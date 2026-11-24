import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AlertManager } from './alerts.mjs';
import { BusyBarClient } from './busybar/client.mjs';
import {
  getWaitingUrgency,
  renderFrontDisplay,
  renderToastOverlay,
} from './busybar/renderer.mjs';
import { BusyBarInputWatcher } from './busybar/ws-input.mjs';
import { createControlServer } from './control-server.mjs';
import { buildFleetSnapshot, countNewCompletions, detectTransitions } from './model.mjs';

const DISMISSED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VALID_VIEW_MODES = new Set(['fleet', 'spotlight', 'pulse']);

function localDateStr(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyDailyStats(now) {
  return { date: localDateStr(now), completed: 0, errors: 0 };
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function pruneDismissed(dismissed, now) {
  const out = {};
  if (!dismissed || typeof dismissed !== 'object' || Array.isArray(dismissed)) return out;
  for (const [k, v] of Object.entries(dismissed)) {
    const ts = Number(v);
    if (typeof k === 'string' && k && Number.isFinite(ts) && ts > 0 && now - ts <= DISMISSED_MAX_AGE_MS) {
      out[k] = ts;
    }
  }
  return out;
}

function loadStateFile(stateFile, now) {
  if (!stateFile) return null;
  const today = localDateStr(now);
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    if (raw && typeof raw === 'object') {
      const clearedAtMs = Number(raw.clearedAtMs);
      const savedStats = raw.dailyStats;
      const dailyStats =
        savedStats && typeof savedStats === 'object' && savedStats.date === today
          ? {
              date: today,
              completed: nonNegInt(savedStats.completed),
              errors: nonNegInt(savedStats.errors),
            }
          : emptyDailyStats(now);
      return {
        clearedAtMs: Number.isFinite(clearedAtMs) && clearedAtMs >= 0 ? clearedAtMs : 0,
        dismissed: pruneDismissed(raw.dismissed, now),
        dailyStats,
      };
    }
  } catch {
    // Missing or corrupt state file falls back to initial window.
  }
  return null;
}

function saveStateFile(stateFile, state) {
  if (!stateFile) return false;
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmp, stateFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Orchestrates provider polling, state reduction, BUSY Bar rendering, alerts, input watcher, and control server.
 */
export class BusyBarDaemon {
  constructor({
    config,
    client,
    registry,
    hookProvider = null,
    inputWatcher = undefined,
    nowFn = () => Date.now(),
    log = console,
  }) {
    this.config = config;
    this.client = client || new BusyBarClient(config.device);
    this.registry = registry;
    this.hookProvider = hookProvider;
    this.alerts = new AlertManager(config.alerts);
    this._now = nowFn;
    this._log = log;

    const multiButton = config.controls?.multiButton !== false;
    if (inputWatcher !== undefined) {
      this._inputWatcher = inputWatcher;
    } else if (config.controls?.wsInputEnabled !== false) {
      this._inputWatcher = new BusyBarInputWatcher({
        baseUrl: config.device?.baseUrl,
        enabled: true,
        multiButton,
        longPressMs: config.controls?.longPressMs ?? 700,
        resetButton: config.controls?.resetButton ?? 'back',
        resetAction: config.controls?.resetAction ?? 'press',
        reconnectDelayMs: config.controls?.reconnectDelayMs ?? 3000,
        debounceMs: config.controls?.debounceMs ?? 500,
        nowFn: this._now,
        onGesture: multiButton
          ? (evt) => {
              this.handleButtonGesture(evt).catch(() => {});
            }
          : null,
        onReset: !multiButton
          ? (evt) => {
              this.reset({ reason: `button:${evt.button}`, onlyIfVisible: true }).catch(() => {});
            }
          : null,
      });
    } else {
      this._inputWatcher = null;
    }

    this._startedAtMs = this._now();
    this._clearedAtMs = 0;
    this._dismissed = {};
    this._dailyStats = emptyDailyStats(this._startedAtMs);
    this._lastPolledSessions = [];
    this._prevSnapshot = null;
    this._lastRenderKey = null;
    this._lastViewMode = null;
    this._lastPhase = null;
    this._lastElementIds = new Set();
    this._lastBlinkColor = null;
    this._displayActive = false;
    this._clearedReleased = false;
    this._deviceConnected = false;
    this._apiVersion = null;
    this._deviceClockOffsetMs = 0;
    this._volumeApplied = false;
    this._lastDrawResult = null;
    this._lastError = null;

    this._viewState = {
      pinnedMode: null,
      spotlightIndex: 0,
      autoSlotIndex: 0,
      lastRotateAtMs: this._startedAtMs,
    };
    this._toast = null;
    this._toastSeq = 0;
    this._toastTimer = null;

    this._syncInFlight = null;
    this._resyncQueued = false;
    this._forceRedrawQueued = false;
    this._debounceTimer = null;
    this._pollTimer = null;
    this._healthTimer = null;
    this._controlServer = null;
    this._running = false;
  }

  _initState() {
    const now = this._now();
    const saved = loadStateFile(this.config.daemon?.stateFile, now);
    if (saved) {
      this._dismissed = saved.dismissed || {};
      this._dailyStats = saved.dailyStats || emptyDailyStats(now);
      if (saved.clearedAtMs > 0) {
        this._clearedAtMs = saved.clearedAtMs;
        return;
      }
    } else {
      this._dismissed = {};
      this._dailyStats = emptyDailyStats(now);
    }
    const recentWindow = Number(this.config.providers?.antigravity?.recentDoneWindowMs ?? 900000);
    this._clearedAtMs = Math.max(0, now - recentWindow);
  }

  _rolloverDailyStats(now) {
    const today = localDateStr(now);
    if (this._dailyStats.date !== today) {
      this._dailyStats = { date: today, completed: 0, errors: 0 };
    }
  }

  _saveState(now = this._now()) {
    this._rolloverDailyStats(now);
    this._dismissed = pruneDismissed(this._dismissed, now);
    return saveStateFile(this.config.daemon?.stateFile, {
      clearedAtMs: this._clearedAtMs,
      dismissed: this._dismissed,
      dailyStats: this._dailyStats,
    });
  }

  _scheduleChangeSync() {
    if (!this._running || this._debounceTimer) return;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.sync().catch(() => {});
    }, 100);
  }

  async _ensureVolume() {
    const vol = this.config.alerts?.chime?.volume;
    if (this._volumeApplied || vol === null || vol === undefined) return;
    try {
      const res = await this.client.setVolume(vol);
      if (res.ok) this._volumeApplied = true;
    } catch {
      // Non-fatal.
    }
  }

  _buildAutoSlots(snapshot) {
    const cfgModes = Array.isArray(this.config.display?.carousel?.modes)
      ? this.config.display.carousel.modes.filter((m) => VALID_VIEW_MODES.has(m))
      : ['fleet', 'spotlight'];
    const modes = cfgModes.length > 0 ? cfgModes : ['fleet'];

    const activeCount = (snapshot?.sessions || []).filter((s) => s.status !== 'done').length;
    const spotlightTotal = activeCount > 0 ? Math.min(4, activeCount) : Math.min(4, snapshot?.sessions?.length || 0);

    const slots = [];
    for (const mode of modes) {
      if (mode === 'spotlight') {
        const count = Math.max(1, spotlightTotal);
        for (let i = 0; i < count; i++) {
          slots.push({ mode: 'spotlight', spotlightIndex: i });
        }
      } else {
        slots.push({ mode, spotlightIndex: 0 });
      }
    }
    return slots.length > 0 ? slots : [{ mode: 'fleet', spotlightIndex: 0 }];
  }

  _resolveEffectiveView(snapshot) {
    const sessions = snapshot?.sessions || [];
    if (this._viewState.pinnedMode) {
      if (this._viewState.pinnedMode === 'spotlight') {
        if (sessions.length === 0) {
          return { mode: 'fleet', spotlightIndex: 0, auto: false };
        }
        const idx = ((this._viewState.spotlightIndex % sessions.length) + sessions.length) % sessions.length;
        return { mode: 'spotlight', spotlightIndex: idx, auto: false };
      }
      return { mode: this._viewState.pinnedMode, spotlightIndex: 0, auto: false };
    }

    const carouselCfg = this.config.display?.carousel || {};
    const isActivePhase =
      snapshot?.phase === 'running' ||
      snapshot?.phase === 'waiting' ||
      snapshot?.phase === 'error';

    if (carouselCfg.enabled !== false && isActivePhase) {
      const slots = this._buildAutoSlots(snapshot);
      const slot = slots[this._viewState.autoSlotIndex % slots.length] || { mode: 'fleet', spotlightIndex: 0 };
      if (slot.mode === 'spotlight' && sessions.length === 0) {
        return { mode: 'fleet', spotlightIndex: 0, auto: true };
      }
      return {
        mode: slot.mode,
        spotlightIndex:
          slot.mode === 'spotlight' && sessions.length > 0
            ? slot.spotlightIndex % sessions.length
            : 0,
        auto: true,
      };
    }

    return { mode: 'fleet', spotlightIndex: 0, auto: true };
  }

  /**
   * Displays a short-lived full-screen overlay toast on the BUSY Bar.
   */
  async showToast(text, color = '#00FFAAFF', durationMs = 1800) {
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    const now = this._now();
    this._toast = {
      id: ++this._toastSeq,
      text: String(text || 'OK'),
      color,
      expiresAtMs: now + Math.max(250, Number(durationMs) || 1800),
    };
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      this._toastTimer = null;
      if (this._running) {
        this.sync({ forceRedraw: true }).catch(() => {});
      }
    }, Math.max(250, Number(durationMs) || 1800));

    return this.sync({ forceRedraw: true });
  }

  /**
   * Switches or cycles the active front-display view mode.
   */
  async setView({ mode = 'next', index } = {}) {
    const now = this._now();
    const targetMode = String(mode || 'next').trim().toLowerCase();
    const snapshot =
      this._prevSnapshot ||
      buildFleetSnapshot(this._lastPolledSessions, {
        clearedAtMs: this._clearedAtMs,
        dismissed: this._dismissed,
        now,
        stayOnUntilCleared: this.config.display?.stayOnUntilCleared !== false,
      });
    const sessionCount = snapshot.sessions?.length || 0;

    if (targetMode === 'auto') {
      this._viewState = {
        pinnedMode: null,
        spotlightIndex: 0,
        autoSlotIndex: 0,
        lastRotateAtMs: now,
      };
      return this.showToast('AUTO MODE', '#00FFAAFF');
    }

    if (targetMode === 'next') {
      const current = this._resolveEffectiveView(snapshot);
      if (!this._viewState.pinnedMode) {
        if (current.mode === 'fleet') {
          if (sessionCount > 0) {
            this._viewState.pinnedMode = 'spotlight';
            this._viewState.spotlightIndex = 0;
          } else {
            this._viewState.pinnedMode = 'pulse';
          }
        } else if (current.mode === 'spotlight') {
          if (current.spotlightIndex + 1 < sessionCount) {
            this._viewState.pinnedMode = 'spotlight';
            this._viewState.spotlightIndex = current.spotlightIndex + 1;
          } else {
            this._viewState.pinnedMode = 'pulse';
          }
        } else {
          this._viewState.pinnedMode = 'fleet';
          this._viewState.spotlightIndex = 0;
        }
        return this.sync({ forceRedraw: true });
      }

      if (this._viewState.pinnedMode === 'fleet') {
        if (sessionCount > 0) {
          this._viewState.pinnedMode = 'spotlight';
          this._viewState.spotlightIndex = 0;
        } else {
          this._viewState.pinnedMode = 'pulse';
        }
        return this.sync({ forceRedraw: true });
      }

      if (this._viewState.pinnedMode === 'spotlight') {
        if (current.spotlightIndex + 1 < sessionCount) {
          this._viewState.spotlightIndex = current.spotlightIndex + 1;
        } else {
          this._viewState.pinnedMode = 'pulse';
          this._viewState.spotlightIndex = 0;
        }
        return this.sync({ forceRedraw: true });
      }

      // Leaving pinned pulse returns to auto carousel with confirmation toast.
      this._viewState = {
        pinnedMode: null,
        spotlightIndex: 0,
        autoSlotIndex: 0,
        lastRotateAtMs: now,
      };
      return this.showToast('AUTO MODE', '#00FFAAFF');
    }

    if (!VALID_VIEW_MODES.has(targetMode)) {
      throw new Error(`Invalid view mode "${mode}" (expected auto|fleet|spotlight|pulse|next)`);
    }

    this._toast = null;
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    this._viewState.pinnedMode = targetMode;
    this._viewState.spotlightIndex =
      targetMode === 'spotlight' && Number.isFinite(Number(index))
        ? Math.max(0, Math.floor(Number(index)))
        : 0;
    return this.sync({ forceRedraw: true });
  }

  /**
   * Dispatches multi-button short/long press gestures from the BUSY Bar hardware.
   */
  async handleButtonGesture({ button, gesture } = {}) {
    if (!this._displayActive) return null;
    const btn = String(button || '').trim().toLowerCase();
    const gst = String(gesture || '').trim().toLowerCase();

    if (btn === 'ok') {
      if (gst === 'long_press') {
        return this.setView({ mode: 'auto' });
      }
      if (gst === 'short_press') {
        return this.setView({ mode: 'next' });
      }
      return null;
    }

    if (btn === 'back') {
      if (gst === 'long_press') {
        return this.reset({ reason: 'button:back:long', onlyIfVisible: true });
      }
      if (gst === 'short_press') {
        const snapshot = this._prevSnapshot;
        const effective = this._resolveEffectiveView(snapshot);
        if (effective.mode === 'spotlight' && (snapshot?.sessions?.length || 0) > 1) {
          const target = snapshot.sessions[effective.spotlightIndex];
          if (target) {
            await this.dismissSession({ provider: target.provider, sessionId: target.id });
            return this.showToast('DISMISSED', '#FFAA00FF', 1400);
          }
        }
        return this.reset({ reason: 'button:back', onlyIfVisible: true });
      }
      return null;
    }

    if (btn === 'start') {
      const cfg = this.alerts.getConfig();
      if (gst === 'short_press') {
        const nextEnabled = !cfg.chime?.enabled;
        await this.updateAlerts({ chime: { enabled: nextEnabled } });
        return this.showToast(
          nextEnabled ? 'CHIME ON' : 'CHIME OFF',
          nextEnabled ? '#00FFAAFF' : '#FFAA00FF'
        );
      }
      if (gst === 'long_press') {
        const nextEnabled = !cfg.blink?.enabled;
        await this.updateAlerts({ blink: { enabled: nextEnabled } });
        return this.showToast(
          nextEnabled ? 'BLINK ON' : 'BLINK OFF',
          nextEnabled ? '#00D4FFFF' : '#8899AAFF'
        );
      }
    }

    return null;
  }

  /**
   * Executes one serialized poll + diff + BUSY Bar draw/chime cycle.
   */
  async sync({ forceRedraw = false } = {}) {
    if (this._syncInFlight) {
      this._resyncQueued = true;
      if (forceRedraw) this._forceRedrawQueued = true;
      return this._syncInFlight;
    }

    this._syncInFlight = this._runSync(forceRedraw).finally(() => {
      this._syncInFlight = null;
    });

    const snapshot = await this._syncInFlight;
    if (this._resyncQueued) {
      const nextForce = this._forceRedrawQueued;
      this._resyncQueued = false;
      this._forceRedrawQueued = false;
      return this.sync({ forceRedraw: nextForce });
    }
    return snapshot;
  }

  async _runSync(forceRedraw) {
    const now = this._now();
    this._rolloverDailyStats(now);

    if (this._toast && now >= this._toast.expiresAtMs) {
      this._toast = null;
    }

    const sessions = await this.registry.pollAll(now);
    this._lastPolledSessions = sessions;

    const snapshot = buildFleetSnapshot(sessions, {
      clearedAtMs: this._clearedAtMs,
      dismissed: this._dismissed,
      now,
      stayOnUntilCleared: this.config.display?.stayOnUntilCleared !== false,
    });

    const transitions = detectTransitions(this._prevSnapshot, snapshot);
    const newlyDone = countNewCompletions(this._prevSnapshot, snapshot);
    const newErrors = transitions
      .filter((t) => t.kind === 'error')
      .reduce((acc, t) => acc + (t.sessionIds?.length || 0), 0);

    if (newlyDone > 0 || newErrors > 0) {
      this._dailyStats.completed += newlyDone;
      this._dailyStats.errors += newErrors;
      this._saveState(now);
    }

    // Snap back to immediate alert fleet view when new urgent attention arrives.
    const hasUrgentTransition = transitions.some((t) => t.kind === 'error' || t.kind === 'waiting');
    if (hasUrgentTransition) {
      this._viewState.pinnedMode = null;
      this._viewState.autoSlotIndex = 0;
      this._viewState.lastRotateAtMs = now;
    }

    const carouselCfg = this.config.display?.carousel || {};
    const isActivePhase =
      snapshot.phase === 'running' || snapshot.phase === 'waiting' || snapshot.phase === 'error';

    if (!isActivePhase && !this._viewState.pinnedMode) {
      this._viewState.autoSlotIndex = 0;
      this._viewState.lastRotateAtMs = now;
    } else if (
      carouselCfg.enabled !== false &&
      !this._viewState.pinnedMode &&
      isActivePhase &&
      !this._toast
    ) {
      const slots = this._buildAutoSlots(snapshot);
      if (slots.length > 1) {
        const intervalMs = Math.max(1500, Number(carouselCfg.intervalMs ?? 5000));
        if (now - this._viewState.lastRotateAtMs >= intervalMs) {
          this._viewState.autoSlotIndex = (this._viewState.autoSlotIndex + 1) % slots.length;
          this._viewState.lastRotateAtMs = now;
        }
      }
    }

    const blinkColor = this.alerts.resolveBlinkColor(snapshot);
    const chimes = this.alerts.selectChimes(transitions, now);

    const clearBehavior = this.config.display?.clearBehavior || 'release';
    const appName = this.config.device?.applicationName || 'agent-status';
    const effectiveView = this._resolveEffectiveView(snapshot);
    const urgency = getWaitingUrgency(snapshot, this.config, now);
    const chimeMuted = !this.alerts.getConfig().chime?.enabled;

    const shouldReleaseCleared =
      !this._toast &&
      snapshot.phase === 'cleared' &&
      clearBehavior === 'release' &&
      this._viewState.pinnedMode !== 'pulse';

    if (shouldReleaseCleared) {
      if (forceRedraw || this._displayActive || !this._clearedReleased) {
        try {
          const res = await this.client.clearDisplay(appName);
          this._deviceConnected = true;
          this._lastError = null;
          this._lastDrawResult = { action: 'clear', ok: res.ok, status: res.status };
          if (res.ok) {
            this._displayActive = false;
            this._clearedReleased = true;
            this._lastRenderKey = `cleared:${snapshot.fingerprint}`;
            this._lastViewMode = null;
            this._lastPhase = 'cleared';
            this._lastElementIds = new Set();
            this._lastBlinkColor = null;
          }
        } catch (err) {
          this._deviceConnected = false;
          this._lastError = err?.message || String(err);
          this._lastDrawResult = { action: 'clear', ok: false, error: this._lastError };
        }
      }
    } else {
      this._clearedReleased = false;
      const targetViewMode = this._toast ? 'toast' : effectiveView.mode;
      const renderKey = this._toast
        ? `toast:${this._toast.id}:${blinkColor || ''}`
        : JSON.stringify({
            f: snapshot.fingerprint,
            b: blinkColor || '',
            m: effectiveView.mode,
            i: effectiveView.mode === 'spotlight' ? effectiveView.spotlightIndex : 0,
            u: urgency.level,
            dc:
              effectiveView.mode === 'pulse' || snapshot.phase === 'all_done'
                ? this._dailyStats.completed
                : 0,
            mu: effectiveView.mode === 'pulse' ? chimeMuted : false,
          });

      const needsDraw = forceRedraw || renderKey !== this._lastRenderKey || blinkColor !== this._lastBlinkColor;

      if (needsDraw) {
        const payload = this._toast
          ? renderToastOverlay(this._toast, { config: this.config, blinkColor })
          : renderFrontDisplay(snapshot, {
              config: this.config,
              blinkColor,
              viewMode: effectiveView.mode,
              spotlightIndex: effectiveView.spotlightIndex,
              dailyStats: this._dailyStats,
              muted: chimeMuted,
              deviceClockOffsetMs: this._deviceClockOffsetMs,
              now,
            });

        const nextElementIds = new Set((payload.elements || []).map((e) => e.id));
        const hasRemovedElement = [...this._lastElementIds].some((id) => !nextElementIds.has(id));
        const needsClearBeforeDraw =
          this._displayActive &&
          (forceRedraw ||
            targetViewMode !== this._lastViewMode ||
            snapshot.phase !== this._lastPhase ||
            hasRemovedElement);

        try {
          if (needsClearBeforeDraw) {
            await this.client.clearDisplay(appName);
          }
          const res = await this.client.draw(payload);
          this._deviceConnected = true;
          this._lastError = null;
          this._lastDrawResult = {
            action: 'draw',
            ok: res.ok,
            status: res.status,
            preempted: res.preempted,
          };
          if (res.ok) {
            this._displayActive = true;
            this._lastRenderKey = renderKey;
            this._lastViewMode = targetViewMode;
            this._lastPhase = snapshot.phase;
            this._lastElementIds = nextElementIds;
            this._lastBlinkColor = blinkColor;
            await this._ensureVolume();
          } else if (res.preempted) {
            // Higher-priority BUSY Bar app owns the screen; avoid 1Hz redraw churn until state changes.
            this._lastRenderKey = renderKey;
            this._lastViewMode = targetViewMode;
            this._lastPhase = snapshot.phase;
            this._lastElementIds = nextElementIds;
            this._lastBlinkColor = blinkColor;
          }
        } catch (err) {
          this._deviceConnected = false;
          this._lastError = err?.message || String(err);
          this._lastDrawResult = { action: 'draw', ok: false, error: this._lastError };
        }
      }
    }

    if (chimes.length > 0) {
      for (const ch of chimes) {
        try {
          await this._ensureVolume();
          await this.client.playAudio({
            applicationName: appName,
            stockPath: ch.sound.stockPath,
            path: ch.sound.path,
          });
        } catch {
          // Chime failures must not interrupt display updates.
        }
      }
    }

    this._prevSnapshot = snapshot;
    return snapshot;
  }

  async _refreshApiVersion() {
    try {
      const ver = await this.client.getVersion();
      const semver = typeof ver?.api_semver === 'string' ? ver.api_semver.trim() : null;
      if (semver) {
        this._apiVersion = semver;
        const major = Number.parseInt(semver.split('.')[0], 10);
        if (Number.isFinite(major) && major < 24) {
          this._log?.warn?.(
            `[busy-bar] device API version ${semver} is older than expected (24.x); some features may not work`
          );
        }
      }
    } catch {
      // Non-fatal: device may be temporarily offline at startup.
    }
  }

  async _refreshDeviceTime() {
    if (typeof this.client.getTime !== 'function') return;
    try {
      const timeInfo = await this.client.getTime();
      const parsedMs = timeInfo?.timestamp ? Date.parse(String(timeInfo.timestamp)) : NaN;
      if (Number.isFinite(parsedMs)) {
        this._deviceClockOffsetMs = parsedMs - this._now();
      }
    } catch {
      // Non-fatal: fallback to host clock offset 0.
    }
  }

  /**
   * Checks device reachability when disconnected and immediately re-syncs on USB reconnect.
   */
  async checkHealth() {
    if (this._deviceConnected) return true;
    try {
      await this.client.getStatus();
      this._deviceConnected = true;
      this._lastError = null;
      if (!this._apiVersion) {
        await this._refreshApiVersion();
      }
      await this._refreshDeviceTime();
      await this.sync({ forceRedraw: true });
      return true;
    } catch (err) {
      this._deviceConnected = false;
      this._lastError = err?.message || String(err);
      return false;
    }
  }

  /**
   * Clears completed sessions from the display and persists clearedAtMs.
   */
  async clear() {
    const now = this._now();
    this._clearedAtMs = now;
    if (this.hookProvider) {
      this.hookProvider.clearDone(now);
    }
    this._saveState(now);
    const snapshot = await this.sync({ forceRedraw: true });
    return { clearedAtMs: this._clearedAtMs, snapshot };
  }

  /**
   * Dismisses all currently visible sessions (including stuck running/waiting/error) until they get new activity.
   */
  async reset({ reason = 'manual', onlyIfVisible = false } = {}) {
    if (onlyIfVisible && this._prevSnapshot?.phase === 'cleared' && !this._displayActive) {
      return {
        skipped: true,
        reason,
        dismissedCount: 0,
        snapshot: this._prevSnapshot,
      };
    }

    const now = this._now();
    const freshSessions = await this.registry.pollAll(now);
    const combined = [...this._lastPolledSessions, ...freshSessions];

    const dismissedKeys = new Set();
    for (const s of combined) {
      if (!s || s.status === 'idle') continue;
      const key = `${s.provider}:${s.id}`;
      const ts = Math.max(now, Number(s.updatedAtMs) || 0);
      this._dismissed[key] = Math.max(this._dismissed[key] || 0, ts);
      dismissedKeys.add(key);
    }

    this._clearedAtMs = now;
    this._viewState.pinnedMode = null;
    this._viewState.spotlightIndex = 0;
    this._viewState.autoSlotIndex = 0;
    this._viewState.lastRotateAtMs = now;

    if (this.hookProvider) {
      this.hookProvider.clearDone(now);
    }
    this._saveState(now);
    const snapshot = await this.sync({ forceRedraw: true });

    return {
      reason,
      clearedAtMs: this._clearedAtMs,
      dismissedCount: dismissedKeys.size,
      snapshot,
    };
  }

  /**
   * Dismisses a single session until its updatedAtMs advances past dismissedAtMs.
   */
  async dismissSession({ provider = 'antigravity', sessionId, atMs } = {}) {
    const sid = String(sessionId ?? '').trim();
    if (!sid) {
      throw new Error('sessionId is required');
    }
    const prov = String(provider || 'antigravity').trim() || 'antigravity';
    const key = sid.includes(':') ? sid : `${prov}:${sid}`;

    const now = this._now();
    const existing = this._lastPolledSessions.find((s) => `${s.provider}:${s.id}` === key);
    const existingUpdatedAt = Number(existing?.updatedAtMs) || 0;
    const baseAt = Number.isFinite(Number(atMs)) && Number(atMs) > 0 ? Number(atMs) : now;
    const dismissedAtMs = Math.max(baseAt, existingUpdatedAt);

    this._dismissed[key] = Math.max(this._dismissed[key] || 0, dismissedAtMs);
    this._saveState(now);
    const snapshot = await this.sync();

    return { key, dismissedAtMs: this._dismissed[key], snapshot };
  }

  /**
   * Updates runtime alert toggles and forces an immediate display/LED refresh.
   */
  async updateAlerts(partial) {
    const updated = this.alerts.updateConfig(partial);
    await this.sync({ forceRedraw: true });
    return updated;
  }

  getStatus() {
    const effective = this._resolveEffectiveView(this._prevSnapshot);
    return {
      connected: this._deviceConnected,
      apiVersion: this._apiVersion,
      uptimeSec: Math.max(0, Math.floor((this._now() - this._startedAtMs) / 1000)),
      clearedAtMs: this._clearedAtMs,
      dismissedCount: Object.keys(this._dismissed).length,
      dailyStats: { ...this._dailyStats },
      view: {
        mode: effective.mode,
        auto: effective.auto,
        pinnedMode: this._viewState.pinnedMode,
        spotlightIndex: effective.spotlightIndex,
      },
      lastError: this._lastError,
      lastDrawResult: this._lastDrawResult,
      alerts: this.alerts.getConfig(),
      input: this._inputWatcher ? this._inputWatcher.getStatus() : { enabled: false },
      providers: this.registry.getStatuses(),
      snapshot: this._prevSnapshot,
      controlUrl: this._controlServer ? this._controlServer.url : null,
    };
  }

  async start({ enableControlServer = true, enableInputWatcher = true } = {}) {
    if (this._running) return;
    this._running = true;
    this._initState();

    await this.registry.startAll({
      config: this.config,
      emitChange: () => this._scheduleChangeSync(),
      log: this._log,
    });

    if (enableControlServer && this.config.daemon?.controlPort !== null && this.config.daemon?.controlPort !== false) {
      this._controlServer = createControlServer({
        daemon: this,
        hookProvider: this.hookProvider,
        host: this.config.daemon?.controlHost || '127.0.0.1',
        port: Number(this.config.daemon?.controlPort ?? 4388),
      });
      await this._controlServer.start();
    }

    await this._refreshApiVersion();
    await this._refreshDeviceTime();
    await this.sync({ forceRedraw: true });

    if (enableInputWatcher && this._inputWatcher) {
      this._inputWatcher.start();
    }

    const pollMs = Math.max(200, Number(this.config.daemon?.pollIntervalMs ?? 1000));
    const healthMs = Math.max(500, Number(this.config.daemon?.healthIntervalMs ?? 5000));

    this._pollTimer = setInterval(() => {
      this.sync().catch(() => {});
    }, pollMs);

    this._healthTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, healthMs);
  }

  async stop() {
    this._running = false;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    this._toast = null;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    if (this._inputWatcher) {
      this._inputWatcher.stop();
    }
    if (this._controlServer) {
      await this._controlServer.stop();
      this._controlServer = null;
    }
    if (this.config.display?.clearOnShutdown !== false && this._displayActive) {
      const appName = this.config.device?.applicationName || 'agent-status';
      try {
        await this.client.clearDisplay(appName);
      } catch {
        // Best-effort clear on shutdown.
      }
      this._displayActive = false;
    }
    await this.registry.stopAll();
  }
}

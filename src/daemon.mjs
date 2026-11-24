import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AlertManager } from './alerts.mjs';
import { BusyBarClient } from './busybar/client.mjs';
import { renderFrontDisplay } from './busybar/renderer.mjs';
import { BusyBarInputWatcher } from './busybar/ws-input.mjs';
import { createControlServer } from './control-server.mjs';
import { buildFleetSnapshot, detectTransitions } from './model.mjs';

const DISMISSED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    if (raw && typeof raw === 'object') {
      const clearedAtMs = Number(raw.clearedAtMs);
      return {
        clearedAtMs: Number.isFinite(clearedAtMs) && clearedAtMs >= 0 ? clearedAtMs : 0,
        dismissed: pruneDismissed(raw.dismissed, now),
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

    if (inputWatcher !== undefined) {
      this._inputWatcher = inputWatcher;
    } else if (config.controls?.wsInputEnabled !== false) {
      this._inputWatcher = new BusyBarInputWatcher({
        baseUrl: config.device?.baseUrl,
        enabled: true,
        resetButton: config.controls?.resetButton ?? 'back',
        resetAction: config.controls?.resetAction ?? 'press',
        reconnectDelayMs: config.controls?.reconnectDelayMs ?? 3000,
        debounceMs: config.controls?.debounceMs ?? 500,
        nowFn: this._now,
        onReset: (evt) => {
          this.reset({ reason: `button:${evt.button}`, onlyIfVisible: true }).catch(() => {});
        },
      });
    } else {
      this._inputWatcher = null;
    }

    this._startedAtMs = this._now();
    this._clearedAtMs = 0;
    this._dismissed = {};
    this._lastPolledSessions = [];
    this._prevSnapshot = null;
    this._lastFingerprint = null;
    this._lastBlinkColor = null;
    this._displayActive = false;
    this._clearedReleased = false;
    this._deviceConnected = false;
    this._apiVersion = null;
    this._volumeApplied = false;
    this._lastDrawResult = null;
    this._lastError = null;

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
      if (saved.clearedAtMs > 0) {
        this._clearedAtMs = saved.clearedAtMs;
        return;
      }
    } else {
      this._dismissed = {};
    }
    const recentWindow = Number(this.config.providers?.antigravity?.recentDoneWindowMs ?? 900000);
    this._clearedAtMs = Math.max(0, now - recentWindow);
  }

  _saveState(now = this._now()) {
    this._dismissed = pruneDismissed(this._dismissed, now);
    return saveStateFile(this.config.daemon?.stateFile, {
      clearedAtMs: this._clearedAtMs,
      dismissed: this._dismissed,
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
    const sessions = await this.registry.pollAll(now);
    this._lastPolledSessions = sessions;

    const snapshot = buildFleetSnapshot(sessions, {
      clearedAtMs: this._clearedAtMs,
      dismissed: this._dismissed,
      now,
      stayOnUntilCleared: this.config.display?.stayOnUntilCleared !== false,
    });

    const transitions = detectTransitions(this._prevSnapshot, snapshot);
    const blinkColor = this.alerts.resolveBlinkColor(snapshot);
    const chimes = this.alerts.selectChimes(transitions, now);

    const clearBehavior = this.config.display?.clearBehavior || 'release';
    const appName = this.config.device?.applicationName || 'agent-status';

    if (snapshot.phase === 'cleared' && clearBehavior === 'release') {
      if (forceRedraw || this._displayActive || !this._clearedReleased) {
        try {
          const res = await this.client.clearDisplay(appName);
          this._deviceConnected = true;
          this._lastError = null;
          this._lastDrawResult = { action: 'clear', ok: res.ok, status: res.status };
          if (res.ok) {
            this._displayActive = false;
            this._clearedReleased = true;
            this._lastFingerprint = snapshot.fingerprint;
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
      const needsDraw =
        forceRedraw ||
        snapshot.fingerprint !== this._lastFingerprint ||
        blinkColor !== this._lastBlinkColor;

      if (needsDraw) {
        const payload = renderFrontDisplay(snapshot, { config: this.config, blinkColor });
        try {
          if (this._displayActive) {
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
            this._lastFingerprint = snapshot.fingerprint;
            this._lastBlinkColor = blinkColor;
            await this._ensureVolume();
          } else if (res.preempted) {
            // Higher-priority BUSY Bar app owns the screen; avoid 1Hz redraw churn until state changes.
            this._lastFingerprint = snapshot.fingerprint;
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
    return {
      connected: this._deviceConnected,
      apiVersion: this._apiVersion,
      uptimeSec: Math.max(0, Math.floor((this._now() - this._startedAtMs) / 1000)),
      clearedAtMs: this._clearedAtMs,
      dismissedCount: Object.keys(this._dismissed).length,
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

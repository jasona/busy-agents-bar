import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import {
  discoverConversations,
  discoverProjects,
  matchProjectName,
  resolveAntigravityPaths,
} from './discovery.mjs';
import { readSwarm } from './swarm.mjs';
import { stepFailure, summarizeTranscript } from './transcript.mjs';

const MAX_ACTIVE_DIR_WATCHERS = 25;

function classifyViewAttention(viewJson) {
  if (!viewJson || !Array.isArray(viewJson.attention)) return null;
  for (const item of viewJson.attention) {
    if (!item || typeof item !== 'object') continue;
    const rawKind = String(item.kind || '').toLowerCase();
    if (rawKind === 'failure' || rawKind === 'error' || rawKind === 'quota') {
      return { status: 'error', attentionKind: rawKind === 'quota' ? 'quota' : 'error', text: item.title || item.why || 'Swarm error' };
    }
    if (rawKind === 'decision' || rawKind === 'review' || rawKind === 'approval') {
      return { status: 'waiting', attentionKind: 'approval', text: item.title || item.why || 'Swarm approval' };
    }
    return { status: 'waiting', attentionKind: 'question', text: item.title || item.why || 'Swarm attention' };
  }
  return null;
}

/**
 * Monitors local Antigravity conversation transcripts and swarm directories.
 */
export class AntigravityProvider {
  constructor(options = {}) {
    this.id = 'antigravity';
    this.label = 'Antigravity';
    this._options = options;
    this._stuckAfterMs = Number(options.stuckAfterMs ?? 600000);
    this._staleAfterMs = Number(options.staleAfterMs ?? 21600000);
    this._emitChange = null;
    this._watchers = new Map();
    this._debounceTimer = null;
    this._started = false;
  }

  _scheduleEmit() {
    if (!this._emitChange) return;
    if (this._debounceTimer) return;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (this._emitChange) this._emitChange();
    }, 150);
  }

  _ensureWatch(dir) {
    if (!dir || this._watchers.has(dir) || !existsSync(dir)) return;
    try {
      const w = watch(dir, () => this._scheduleEmit());
      w.on('error', () => {
        this._dropWatch(dir);
      });
      this._watchers.set(dir, w);
    } catch {
      // Ignore directories that cannot be watched.
    }
  }

  _dropWatch(dir) {
    const w = this._watchers.get(dir);
    if (!w) return;
    this._watchers.delete(dir);
    try {
      w.close();
    } catch {
      // Ignore close error.
    }
  }

  _syncWatchers(convs) {
    if (!this._started) return;
    const { appDataDirs } = resolveAntigravityPaths(this._options);
    const desired = new Set();

    for (const appData of appDataDirs) {
      desired.add(join(appData, 'brain'));
    }
    for (const conv of convs.slice(0, MAX_ACTIVE_DIR_WATCHERS)) {
      if (existsSync(conv.logsDir)) desired.add(conv.logsDir);
      if (conv.hasSwarm && existsSync(conv.swarmDir)) desired.add(conv.swarmDir);
    }

    for (const existing of [...this._watchers.keys()]) {
      if (!desired.has(existing)) this._dropWatch(existing);
    }
    for (const dir of desired) {
      this._ensureWatch(dir);
    }
  }

  start(ctx = {}) {
    this._emitChange = typeof ctx.emitChange === 'function' ? ctx.emitChange : null;
    this._started = true;
    const convs = discoverConversations(this._options);
    this._syncWatchers(convs);
  }

  stop() {
    this._started = false;
    this._emitChange = null;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    for (const dir of [...this._watchers.keys()]) {
      this._dropWatch(dir);
    }
  }

  poll(now = Date.now()) {
    const projects = discoverProjects(this._options);
    const convs = discoverConversations(this._options);
    this._syncWatchers(convs);

    // Inspect swarms first so worker conversations are folded into their coordinator thread.
    const swarmsByConvId = new Map();
    const workerConvIds = new Set();

    for (const conv of convs) {
      if (!conv.hasSwarm) continue;
      if (this._staleAfterMs > 0 && now - conv.mtime > this._staleAfterMs) continue;
      const swarm = readSwarm(conv.appData, conv.id, now, {
        stuckAfterMs: this._stuckAfterMs,
      });
      if (!swarm) continue;
      swarmsByConvId.set(conv.id, swarm);
      for (const wid of swarm.workerConvIds) workerConvIds.add(wid);
    }

    const sessions = [];

    for (const conv of convs) {
      if (workerConvIds.has(conv.id)) continue;

      const swarm = swarmsByConvId.get(conv.id) || null;
      const effectiveMtime = Math.max(conv.mtime, swarm?.mtime || 0);
      const isSwarmWorking = Boolean(swarm && swarm.workingCount > 0);
      if (this._staleAfterMs > 0 && !isSwarmWorking && now - effectiveMtime > this._staleAfterMs) {
        continue;
      }

      const tr = conv.hasTranscript ? summarizeTranscript(conv.transcriptPath).summary : null;
      const updatedAtMs = Math.max(tr?.updatedAtMs || 0, effectiveMtime || 0) || now;
      const project = matchProjectName(conv, tr, swarm, projects);
      const title =
        swarm?.title ||
        conv.localMeta?.title ||
        tr?.firstUserPrompt ||
        `Thread ${conv.id.slice(0, 8)}`;

      const trFailure = stepFailure(tr, now);
      const swarmFailure = swarm?.systemAttention?.find(
        (a) => a.kind === 'error' || a.kind === 'quota'
      );
      const swarmStuck = swarm?.systemAttention?.find((a) => a.kind === 'stuck');
      const viewAttn = classifyViewAttention(swarm?.viewJson);

      const trActive = Boolean(
        tr && !tr.idle && !trFailure && !tr.askQuestion && !tr.pendingApproval
      );
      const running = Boolean(swarm ? isSwarmWorking || trActive : trActive);

      let status = 'idle';
      let attentionKind = null;
      let activity = tr?.activity || '';

      if (trFailure && !running) {
        status = 'error';
        attentionKind = trFailure.kind;
        activity = trFailure.text;
      } else if (swarmFailure && !running) {
        status = 'error';
        attentionKind = swarmFailure.kind;
        activity = swarmFailure.summary;
      } else if (viewAttn?.status === 'error' && !running) {
        status = 'error';
        attentionKind = viewAttn.attentionKind;
        activity = viewAttn.text;
      } else if (tr?.pendingApproval) {
        status = 'waiting';
        attentionKind = 'approval';
        activity = tr.pendingApproval;
      } else if (swarm?.readyWorkers?.length > 0) {
        status = 'waiting';
        attentionKind = 'approval';
        activity = `Swarm ${swarm.readyWorkers[0].handle} ready`;
      } else if (viewAttn?.status === 'waiting') {
        status = 'waiting';
        attentionKind = viewAttn.attentionKind;
        activity = viewAttn.text;
      } else if (tr?.askQuestion) {
        status = 'waiting';
        attentionKind = 'question';
        activity = tr.askQuestion;
      } else if (running && !swarm && tr?.mtime && now - tr.mtime > this._stuckAfterMs) {
        status = 'waiting';
        attentionKind = 'stuck';
        activity = `Stuck ${Math.round((now - tr.mtime) / 60000)}m`;
      } else if (swarmStuck && !running) {
        status = 'waiting';
        attentionKind = 'stuck';
        activity = swarmStuck.summary;
      } else if (running) {
        status = 'running';
        if (swarm) {
          activity = `Swarm ${swarm.workingCount}/${swarm.count}`;
        }
      } else if (tr && tr.steps > 0) {
        status = 'done';
        activity = 'Done';
      }

      if (status === 'idle') continue;

      sessions.push({
        id: conv.id,
        provider: this.id,
        project,
        title,
        status,
        attentionKind,
        activity,
        updatedAtMs,
        startedAtMs: tr?.startedAtMs || updatedAtMs,
        turnStartedAtMs: tr?.turnStartedAtMs || tr?.startedAtMs || updatedAtMs,
        steps: tr?.steps || 0,
        isSwarm: Boolean(swarm),
        swarmWorkingCount: swarm?.workingCount || 0,
        swarmTotalCount: swarm?.count || 0,
      });
    }

    return sessions;
  }
}

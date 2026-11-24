import { normalizeSession } from '../model.mjs';
import { genericHookAdapter, registerBuiltinHookAdapters } from './adapters/index.mjs';

export { genericHookAdapter };

const adapters = new Map();

/**
 * Registers a custom webhook payload adapter for a named provider (e.g. "claude-code", "codex").
 */
export function registerHookAdapter(providerName, transformFn) {
  const key = String(providerName || '').trim().toLowerCase();
  if (!key) throw new Error('Adapter providerName must be non-empty');
  if (typeof transformFn !== 'function') {
    throw new Error('Adapter transformFn must be a function');
  }
  adapters.set(key, transformFn);
}

registerBuiltinHookAdapters(registerHookAdapter);

/**
 * Unregisters a custom hook adapter (useful in tests). Cannot remove the built-in generic adapter.
 */
export function unregisterHookAdapter(providerName) {
  const key = String(providerName || '').trim().toLowerCase();
  if (key === 'generic') return false;
  return adapters.delete(key);
}

export function listHookAdapters() {
  return [...adapters.keys()];
}

/**
 * Push-based provider accepting external hook events over HTTP or CLI `emit`.
 */
export class HookProvider {
  constructor(options = {}) {
    this.id = 'hooks';
    this.label = 'Hooks';
    this._defaultTtlMs = Math.max(1000, Number(options.defaultTtlMs ?? 3600000));
    this._entries = new Map();
    this._emitChange = null;
  }

  start(ctx = {}) {
    this._emitChange = typeof ctx.emitChange === 'function' ? ctx.emitChange : null;
  }

  stop() {
    this._emitChange = null;
  }

  /**
   * Ingests a hook payload for `providerName`, normalizing via a registered adapter or generic fallback.
   * Returns the normalized session on upsert, or null if the event was ignored or removed a session.
   */
  ingest(providerName, payload, now = Date.now()) {
    const provKey = String(providerName || 'generic').trim().toLowerCase() || 'generic';
    const adapter = adapters.get(provKey) || adapters.get('generic');
    const adapted = adapter(provKey, payload, now);

    if (adapted == null || adapted.ignore) {
      return null;
    }

    if (adapted.remove) {
      const targetProv = String(adapted.provider || provKey).trim().toLowerCase() || provKey;
      const targetId = String(adapted.sessionId ?? '').trim();
      if (targetId) {
        this.remove(targetProv, targetId);
      }
      return null;
    }

    const rawSession = adapted && adapted.session ? adapted.session : adapted;
    const ttlMs =
      adapted && adapted.ttlMs !== undefined ? adapted.ttlMs : this._defaultTtlMs;

    const session = normalizeSession({
      ...rawSession,
      provider: rawSession?.provider || provKey,
      updatedAtMs: rawSession?.updatedAtMs || now,
    });

    const key = `${session.provider}:${session.id}`;
    const prev = this._entries.get(key);
    const startedAtMs = prev?.session?.startedAtMs || session.startedAtMs || now;
    const finalSession = { ...session, startedAtMs };

    this._entries.set(key, {
      session: finalSession,
      expiresAtMs: now + ttlMs,
    });

    if (this._emitChange) this._emitChange();
    return finalSession;
  }

  /**
   * Removes a specific provider/session entry from the hook store.
   */
  remove(providerName, sessionId) {
    const prov = String(providerName || '').trim().toLowerCase();
    const sid = String(sessionId || '').trim();
    const key = `${prov}:${sid}`;
    const deleted = this._entries.delete(key);
    if (deleted && this._emitChange) this._emitChange();
    return deleted;
  }

  /**
   * Clears completed/idle hook entries at or before `beforeMs`.
   */
  clearDone(beforeMs = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this._entries.entries()) {
      const st = entry.session.status;
      if ((st === 'done' || st === 'idle') && entry.session.updatedAtMs <= beforeMs) {
        this._entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Prunes expired active hook entries and returns all live/retained hook sessions.
   */
  poll(now = Date.now()) {
    const out = [];
    for (const [key, entry] of this._entries.entries()) {
      const st = entry.session.status;
      const isTerminal = st === 'done' || st === 'idle';
      if (!isTerminal && now > entry.expiresAtMs) {
        this._entries.delete(key);
        continue;
      }
      out.push(entry.session);
    }
    return out;
  }
}

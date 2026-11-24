import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSession, STATUS_RANK } from '../model.mjs';

function isFileLikePath(specifier) {
  return (
    specifier.startsWith('/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('file://')
  );
}

/**
 * Coordinates built-in, hook, and custom third-party agent status providers.
 */
export class ProviderRegistry {
  constructor() {
    this._providers = new Map();
    this._statuses = new Map();
    this._moduleErrors = [];
  }

  /**
   * Registers a provider conforming to { id, label, poll, start?, stop? }.
   */
  register(provider) {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError('Provider must be an object');
    }
    const id = typeof provider.id === 'string' ? provider.id.trim() : '';
    const label = typeof provider.label === 'string' ? provider.label.trim() : '';
    if (!id) throw new Error('Provider must define a non-empty string id');
    if (!label) throw new Error(`Provider "${id}" must define a non-empty string label`);
    if (typeof provider.poll !== 'function') {
      throw new Error(`Provider "${id}" must define a poll(now) function`);
    }
    if (this._providers.has(id)) {
      throw new Error(`Provider "${id}" is already registered`);
    }
    this._providers.set(id, provider);
    this._statuses.set(id, {
      id,
      label,
      ok: true,
      started: false,
      lastPollAtMs: 0,
      sessionCount: 0,
      lastError: null,
    });
    return provider;
  }

  get(id) {
    return this._providers.get(id) || null;
  }

  list() {
    return [...this._providers.values()];
  }

  getStatuses() {
    return {
      providers: [...this._statuses.values()],
      moduleErrors: [...this._moduleErrors],
    };
  }

  /**
   * Dynamically imports custom ESM provider modules exporting `createProvider(config, ctx)` (or default).
   */
  async loadCustomModules(modulePaths = [], config = {}, ctx = {}) {
    const loaded = [];
    const errors = [];

    for (const rawSpec of modulePaths || []) {
      const spec = typeof rawSpec === 'string' ? rawSpec.trim() : '';
      if (!spec) continue;
      try {
        const importTarget = spec.startsWith('file://')
          ? spec
          : isFileLikePath(spec)
            ? pathToFileURL(resolve(spec)).href
            : spec;
        const mod = await import(importTarget);
        const factory =
          typeof mod.createProvider === 'function'
            ? mod.createProvider
            : typeof mod.default === 'function'
              ? mod.default
              : null;

        let provider = null;
        if (factory) {
          provider = await factory(config, ctx);
        } else if (mod.default && typeof mod.default === 'object') {
          provider = mod.default;
        }

        if (!provider) {
          throw new Error(`Module "${spec}" did not export createProvider(config, ctx) or a provider object`);
        }
        this.register(provider);
        loaded.push(provider.id);
      } catch (err) {
        const msg = err?.message || String(err);
        const entry = { module: spec, error: msg };
        errors.push(entry);
        this._moduleErrors.push(entry);
      }
    }

    return { loaded, errors };
  }

  /**
   * Starts all registered providers, isolating individual provider startup errors.
   */
  async startAll(ctx = {}) {
    for (const provider of this._providers.values()) {
      const st = this._statuses.get(provider.id);
      if (typeof provider.start !== 'function') {
        if (st) st.started = true;
        continue;
      }
      try {
        await provider.start(ctx);
        if (st) {
          st.started = true;
          st.ok = true;
          st.lastError = null;
        }
      } catch (err) {
        if (st) {
          st.started = false;
          st.ok = false;
          st.lastError = err?.message || String(err);
        }
      }
    }
  }

  /**
   * Stops all registered providers cleanly.
   */
  async stopAll() {
    for (const provider of this._providers.values()) {
      const st = this._statuses.get(provider.id);
      if (typeof provider.stop === 'function') {
        try {
          await provider.stop();
        } catch {
          // Best-effort shutdown.
        }
      }
      if (st) st.started = false;
    }
  }

  /**
   * Polls all registered providers concurrently, normalizing and deduplicating sessions.
   */
  async pollAll(now = Date.now()) {
    const entries = [...this._providers.values()];
    const settled = await Promise.allSettled(
      entries.map(async (provider) => {
        const rawList = await provider.poll(now);
        const items = Array.isArray(rawList) ? rawList : [];
        return { provider, items };
      })
    );

    const deduped = new Map();

    for (let i = 0; i < entries.length; i++) {
      const provider = entries[i];
      const res = settled[i];
      const st = this._statuses.get(provider.id);

      if (res.status === 'rejected') {
        if (st) {
          st.ok = false;
          st.lastPollAtMs = now;
          st.lastError = res.reason?.message || String(res.reason);
        }
        continue;
      }

      let validCount = 0;
      for (const raw of res.value.items) {
        if (!raw || typeof raw !== 'object') continue;
        try {
          const normalized = normalizeSession({
            ...raw,
            provider: raw.provider || provider.id,
          });
          validCount++;
          const key = `${normalized.provider}:${normalized.id}`;
          const existing = deduped.get(key);
          if (
            !existing ||
            (STATUS_RANK[normalized.status] ?? 9) < (STATUS_RANK[existing.status] ?? 9) ||
            normalized.updatedAtMs > existing.updatedAtMs
          ) {
            deduped.set(key, normalized);
          }
        } catch {
          // Ignore malformed session item without failing the entire provider.
        }
      }

      if (st) {
        st.ok = true;
        st.lastPollAtMs = now;
        st.sessionCount = validCount;
        st.lastError = null;
      }
    }

    return [...deduped.values()];
  }
}

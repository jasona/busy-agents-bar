import { DEFAULT_CONFIG, deepClone, deepMerge } from './config.mjs';

const CHIME_PRIORITY = ['error', 'waiting', 'all_done'];

const EVENT_TOGGLE_KEY = {
  error: 'onError',
  waiting: 'onWaiting',
  all_done: 'onAllDone',
};

const EVENT_CONFIG_KEY = {
  error: 'error',
  waiting: 'waiting',
  all_done: 'allDone',
};

/**
 * Evaluates configurable LED blink and audio chime policies for fleet state changes.
 */
export class AlertManager {
  constructor(alertsConfig = {}) {
    this._config = deepMerge(DEFAULT_CONFIG.alerts, alertsConfig);
    this._lastChimeAt = new Map();
  }

  getConfig() {
    return deepClone(this._config);
  }

  updateConfig(partial = {}) {
    if (!partial || typeof partial !== 'object') return this.getConfig();
    this._config = deepMerge(this._config, partial);
    return this.getConfig();
  }

  /**
   * Returns #RRGGBBAA color when LED blinking is enabled for the current fleet phase, else null.
   */
  resolveBlinkColor(snapshot) {
    const blink = this._config.blink || {};
    if (!blink.enabled || !snapshot) return null;

    const phase = snapshot.phase;
    if (phase === 'error' && blink.onError) {
      return blink.colors?.error || '#FF0000FF';
    }
    if (phase === 'waiting' && blink.onWaiting) {
      return blink.colors?.waiting || '#FFAA00FF';
    }
    if (phase === 'all_done' && blink.onAllDone) {
      return blink.colors?.allDone || '#00FFAAFF';
    }
    return null;
  }

  /**
   * Selects at most one highest-priority chime from transitions, respecting toggles and cooldowns.
   */
  selectChimes(transitions = [], now = Date.now()) {
    const chime = this._config.chime || {};
    if (!chime.enabled || !Array.isArray(transitions) || transitions.length === 0) {
      return [];
    }

    const cooldownMs = Math.max(0, Number(chime.cooldownMs ?? 15000));
    const present = new Set(transitions.map((t) => t?.kind).filter(Boolean));

    for (const kind of CHIME_PRIORITY) {
      if (!present.has(kind)) continue;
      const toggleKey = EVENT_TOGGLE_KEY[kind];
      const cfgKey = EVENT_CONFIG_KEY[kind];
      if (!chime[toggleKey]) continue;

      const lastAt = this._lastChimeAt.get(kind);
      if (lastAt !== undefined && now - lastAt < cooldownMs) continue;

      const sound = chime.sounds?.[cfgKey];
      if (!sound || (!sound.stockPath && !sound.path)) continue;

      this._lastChimeAt.set(kind, now);
      return [{ kind, sound: deepClone(sound) }];
    }

    return [];
  }
}

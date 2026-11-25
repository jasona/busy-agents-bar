import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_CONFIG_PATH = '~/.config/busy-bar/config.json';

export const DEFAULT_CONFIG = {
  device: {
    baseUrl: 'http://10.0.4.20',
    apiToken: null,
    applicationName: 'agent-status',
    priority: 50,
    urgentPriority: 95,
    urgentOverrideTimer: false,
    timeoutMs: 3000,
  },
  daemon: {
    pollIntervalMs: 1000,
    healthIntervalMs: 5000,
    controlHost: '127.0.0.1',
    controlPort: 4388,
    stateFile: '~/.config/busy-bar/state.json',
  },
  display: {
    stayOnUntilCleared: true,
    clearBehavior: 'release',
    clearOnShutdown: true,
    showProjectName: true,
    animations: true,
    showTimers: true,
    providerColors: true,
    carousel: {
      enabled: true,
      intervalMs: 5000,
      modes: ['fleet', 'spotlight'],
    },
    urgencyEscalation: {
      enabled: true,
      elevatedAfterMs: 120000,
      criticalAfterMs: 300000,
    },
  },
  alerts: {
    blink: {
      enabled: true,
      onWaiting: true,
      onError: true,
      onAllDone: true,
      colors: {
        waiting: '#FFAA00FF',
        error: '#FF0000FF',
        allDone: '#00FFAAFF',
      },
    },
    chime: {
      enabled: true,
      onWaiting: true,
      onError: true,
      onAllDone: true,
      cooldownMs: 15000,
      volume: null,
      sounds: {
        waiting: { stockPath: 'shared/calendar_event_starts.snd' },
        error: { stockPath: 'shared/calendar_event_starts.snd' },
        allDone: { stockPath: 'shared/volume_change.snd' },
      },
    },
  },
  providers: {
    antigravity: {
      enabled: true,
      stuckAfterMs: 600000,
      staleAfterMs: 21600000,
      recentDoneWindowMs: 900000,
      appDataDirs: null,
      projectsDir: null,
    },
    hooks: {
      enabled: true,
      defaultTtlMs: 3600000,
    },
    phoenix: {
      enabled: true,
      stuckAfterMs: 600000,
      staleAfterMs: 21600000,
      dataDirs: null,
      dbPaths: null,
    },
    customModules: [],
  },
  controls: {
    wsInputEnabled: true,
    multiButton: true,
    longPressMs: 700,
    resetButton: 'back',
    resetAction: 'press',
    reconnectDelayMs: 3000,
    debounceMs: 500,
  },
};

/**
 * Expands a leading `~` or `~/` to the current user's home directory.
 */
export function expandHome(p, homeDir = homedir()) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homeDir, p.slice(2));
  }
  return p;
}

/**
 * Recursively clones plain objects and arrays.
 */
export function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepClone(v);
    }
    return out;
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merges source objects onto target without mutating inputs.
 */
export function deepMerge(target, ...sources) {
  const result = deepClone(isPlainObject(target) ? target : {});
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [key, val] of Object.entries(src)) {
      if (val === undefined) continue;
      if (isPlainObject(val) && isPlainObject(result[key])) {
        result[key] = deepMerge(result[key], val);
      } else {
        result[key] = deepClone(val);
      }
    }
  }
  return result;
}

function parseBoolEnv(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return undefined;
}

function readJsonConfig(resolvedPath) {
  try {
    const raw = readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error(`Config file at ${resolvedPath} must contain a JSON object`);
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Loads configuration by deep-merging defaults -> JSON config file -> env overrides -> CLI overrides.
 */
export function loadConfig({ configPath, overrides = {}, env = process.env, homeDir = homedir() } = {}) {
  const requestedPath = configPath || env.BUSY_BAR_CONFIG || DEFAULT_CONFIG_PATH;
  const expandedPath = expandHome(requestedPath, homeDir);
  const resolvedConfigPath = isAbsolute(expandedPath) ? expandedPath : resolve(expandedPath);

  const fileConfig = readJsonConfig(resolvedConfigPath);
  if (configPath && fileConfig === null) {
    throw new Error(`Config file not found: ${resolvedConfigPath}`);
  }

  const envOverrides = {};
  if (env.BUSY_BAR_URL) {
    envOverrides.device = { ...(envOverrides.device || {}), baseUrl: env.BUSY_BAR_URL.trim() };
  }
  if (typeof env.BUSY_BAR_TOKEN === 'string' && env.BUSY_BAR_TOKEN.trim()) {
    envOverrides.device = { ...(envOverrides.device || {}), apiToken: env.BUSY_BAR_TOKEN.trim() };
  }
  const blinkEnv = parseBoolEnv(env.BUSY_BAR_BLINK);
  if (blinkEnv !== undefined) {
    envOverrides.alerts = {
      ...(envOverrides.alerts || {}),
      blink: { enabled: blinkEnv },
    };
  }
  const chimeEnv = parseBoolEnv(env.BUSY_BAR_CHIME);
  if (chimeEnv !== undefined) {
    envOverrides.alerts = {
      ...(envOverrides.alerts || {}),
      chime: { enabled: chimeEnv },
    };
  }
  if (env.BUSY_BAR_PORT !== undefined && env.BUSY_BAR_PORT !== '') {
    const portNum = Number(env.BUSY_BAR_PORT);
    if (Number.isInteger(portNum) && portNum >= 0 && portNum <= 65535) {
      envOverrides.daemon = { ...(envOverrides.daemon || {}), controlPort: portNum };
    }
  }
  const wsInputEnv = parseBoolEnv(env.BUSY_BAR_WS_INPUT);
  if (wsInputEnv !== undefined) {
    envOverrides.controls = { ...(envOverrides.controls || {}), wsInputEnabled: wsInputEnv };
  }
  if (typeof env.BUSY_BAR_RESET_BUTTON === 'string' && env.BUSY_BAR_RESET_BUTTON.trim()) {
    const btn = env.BUSY_BAR_RESET_BUTTON.trim().toLowerCase();
    if (btn === 'back' || btn === 'ok' || btn === 'start') {
      envOverrides.controls = { ...(envOverrides.controls || {}), resetButton: btn };
    }
  }
  const carouselEnv = parseBoolEnv(env.BUSY_BAR_CAROUSEL);
  if (carouselEnv !== undefined) {
    envOverrides.display = {
      ...(envOverrides.display || {}),
      carousel: { ...(envOverrides.display?.carousel || {}), enabled: carouselEnv },
    };
  }
  const animEnv = parseBoolEnv(env.BUSY_BAR_ANIMATIONS);
  if (animEnv !== undefined) {
    envOverrides.display = { ...(envOverrides.display || {}), animations: animEnv };
  }
  const timersEnv = parseBoolEnv(env.BUSY_BAR_TIMERS);
  if (timersEnv !== undefined) {
    envOverrides.display = { ...(envOverrides.display || {}), showTimers: timersEnv };
  }
  const multiBtnEnv = parseBoolEnv(env.BUSY_BAR_MULTI_BUTTON);
  if (multiBtnEnv !== undefined) {
    envOverrides.controls = { ...(envOverrides.controls || {}), multiButton: multiBtnEnv };
  }
  const phoenixEnv = parseBoolEnv(env.BUSY_BAR_PHOENIX);
  if (phoenixEnv !== undefined) {
    envOverrides.providers = {
      ...(envOverrides.providers || {}),
      phoenix: { ...(envOverrides.providers?.phoenix || {}), enabled: phoenixEnv },
    };
  }
  if (typeof env.BUSY_BAR_PHOENIX_DIR === 'string' && env.BUSY_BAR_PHOENIX_DIR.trim()) {
    envOverrides.providers = {
      ...(envOverrides.providers || {}),
      phoenix: {
        ...(envOverrides.providers?.phoenix || {}),
        dataDirs: [env.BUSY_BAR_PHOENIX_DIR.trim()],
      },
    };
  }

  const merged = deepMerge(DEFAULT_CONFIG, fileConfig, envOverrides, overrides);

  // Normalize device baseUrl (strip trailing slash) and expand path fields.
  merged.device.baseUrl = String(merged.device.baseUrl || DEFAULT_CONFIG.device.baseUrl).replace(/\/+$/, '');
  merged.daemon.stateFile = expandHome(merged.daemon.stateFile, homeDir);
  if (typeof merged.providers.antigravity.projectsDir === 'string') {
    merged.providers.antigravity.projectsDir = expandHome(merged.providers.antigravity.projectsDir, homeDir);
  }
  if (Array.isArray(merged.providers.antigravity.appDataDirs)) {
    merged.providers.antigravity.appDataDirs = merged.providers.antigravity.appDataDirs.map((d) =>
      expandHome(d, homeDir)
    );
  }
  if (Array.isArray(merged.providers.phoenix?.dataDirs)) {
    merged.providers.phoenix.dataDirs = merged.providers.phoenix.dataDirs.map((d) =>
      expandHome(d, homeDir)
    );
  }
  if (Array.isArray(merged.providers.phoenix?.dbPaths)) {
    merged.providers.phoenix.dbPaths = merged.providers.phoenix.dbPaths.map((p) =>
      expandHome(p, homeDir)
    );
  }
  if (Array.isArray(merged.providers.customModules)) {
    merged.providers.customModules = merged.providers.customModules.map((m) => expandHome(m, homeDir));
  }
  merged._configPath = resolvedConfigPath;
  return merged;
}

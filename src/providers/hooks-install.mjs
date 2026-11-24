import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CLAUDE_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
];

export const CODEX_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'SessionEnd',
];

function readJsonObjectOrEmpty(filePath) {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

function isManagedCommand(command, target) {
  if (typeof command !== 'string') return false;
  if (target === 'claude') {
    return /(?:busy-bar(?:\.mjs)?)\s+hook\s+(?:claude|claude-code)\b/.test(command);
  }
  if (target === 'codex') {
    return /(?:busy-bar(?:\.mjs)?)\s+hook\s+(?:codex|chatgpt)\b/.test(command);
  }
  if (target === 'antigravity') {
    return /(?:busy-bar(?:\.mjs)?)\s+(?:agy-stop-hook|hook\s+(?:antigravity|agy))\b/.test(command);
  }
  return false;
}

function isManagedHookGroup(group, target) {
  return (
    Boolean(group) &&
    typeof group === 'object' &&
    Array.isArray(group.hooks) &&
    group.hooks.some((h) => isManagedCommand(h?.command, target))
  );
}

/**
 * Pure merge/uninstall helper for Claude Code (`settings.json`) and Codex (`hooks.json`) hook structures.
 */
export function mergeHookGroupsMap({
  existingHooks,
  events,
  target,
  command,
  timeout = 3,
  uninstall = false,
}) {
  const nextHooks =
    existingHooks && typeof existingHooks === 'object' && !Array.isArray(existingHooks)
      ? structuredClone(existingHooks)
      : {};

  const desiredGroup = {
    hooks: [
      {
        type: 'command',
        command,
        timeout,
      },
    ],
  };

  if (uninstall) {
    for (const eventName of Object.keys(nextHooks)) {
      const list = nextHooks[eventName];
      if (!Array.isArray(list)) continue;
      const filtered = list.filter((group) => !isManagedHookGroup(group, target));
      if (filtered.length !== list.length) {
        if (filtered.length === 0) {
          delete nextHooks[eventName];
        } else {
          nextHooks[eventName] = filtered;
        }
      }
    }
    return nextHooks;
  }

  for (const eventName of events) {
    const existingList = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : [];
    const preserved = existingList.filter((group) => !isManagedHookGroup(group, target));
    nextHooks[eventName] = [...preserved, structuredClone(desiredGroup)];
  }

  return nextHooks;
}

function writeIfChanged(filePath, nextObj, { dryRun = false } = {}) {
  const prevRaw = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
  const rendered = JSON.stringify(nextObj, null, 2) + '\n';
  const changed = prevRaw !== rendered;

  if (!dryRun && changed) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, rendered, 'utf-8');
  }

  return { path: filePath, changed, content: rendered };
}

/**
 * Installs or uninstalls the Antigravity Stop (`USER_CANCELED`) hook in `~/.gemini/config/hooks.json`.
 */
export function installAntigravityHook({
  homeDir = homedir(),
  nodeBin = process.execPath,
  binPath,
  dryRun = false,
  uninstall = false,
} = {}) {
  const filePath = join(homeDir, '.gemini', 'config', 'hooks.json');
  const existing = readJsonObjectOrEmpty(filePath);
  const next = structuredClone(existing);

  if (uninstall) {
    delete next['busy-bar-stop'];
  } else {
    next['busy-bar-stop'] = {
      Stop: [
        {
          type: 'command',
          command: `${nodeBin} ${binPath} agy-stop-hook`,
          timeout: 3,
        },
      ],
    };
  }

  const res = writeIfChanged(filePath, next, { dryRun });
  return {
    target: 'antigravity',
    action: uninstall ? 'uninstall' : 'install',
    ...res,
  };
}

/**
 * Installs or uninstalls Claude Code hooks in `~/.claude/settings.json` while preserving all existing settings & hooks.
 */
export function installClaudeHooks({
  homeDir = homedir(),
  nodeBin = process.execPath,
  binPath,
  dryRun = false,
  uninstall = false,
} = {}) {
  const filePath = join(homeDir, '.claude', 'settings.json');
  const existing = readJsonObjectOrEmpty(filePath);
  const next = structuredClone(existing);
  const command = `${nodeBin} ${binPath} hook claude`;

  next.hooks = mergeHookGroupsMap({
    existingHooks: existing.hooks,
    events: CLAUDE_HOOK_EVENTS,
    target: 'claude',
    command,
    timeout: 3,
    uninstall,
  });

  const res = writeIfChanged(filePath, next, { dryRun });
  return {
    target: 'claude',
    action: uninstall ? 'uninstall' : 'install',
    ...res,
  };
}

/**
 * Installs or uninstalls OpenAI Codex / ChatGPT hooks in `~/.codex/hooks.json` while preserving existing hooks.
 */
export function installCodexHooks({
  homeDir = homedir(),
  nodeBin = process.execPath,
  binPath,
  dryRun = false,
  uninstall = false,
} = {}) {
  const filePath = join(homeDir, '.codex', 'hooks.json');
  const existing = readJsonObjectOrEmpty(filePath);
  const next = structuredClone(existing);
  const command = `${nodeBin} ${binPath} hook codex`;

  next.hooks = mergeHookGroupsMap({
    existingHooks: existing.hooks,
    events: CODEX_HOOK_EVENTS,
    target: 'codex',
    command,
    timeout: 3,
    uninstall,
  });

  const res = writeIfChanged(filePath, next, { dryRun });
  return {
    target: 'codex',
    action: uninstall ? 'uninstall' : 'install',
    ...res,
  };
}

const TARGET_ALIASES = {
  antigravity: 'antigravity',
  agy: 'antigravity',
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  chatgpt: 'codex',
};

/**
 * Resolves target names (`all`, `antigravity`, `claude`, `codex`, `chatgpt`) and applies hook changes.
 */
export function installHooksForTargets(rawTargets = ['all'], opts = {}) {
  const list = Array.isArray(rawTargets) && rawTargets.length > 0 ? rawTargets : ['all'];
  const canonical = [];
  const seen = new Set();

  const add = (t) => {
    if (!seen.has(t)) {
      seen.add(t);
      canonical.push(t);
    }
  };

  for (const raw of list) {
    const token = String(raw || '').trim().toLowerCase();
    if (!token) continue;
    if (token === 'all') {
      add('antigravity');
      add('claude');
      add('codex');
      continue;
    }
    const mapped = TARGET_ALIASES[token];
    if (!mapped) {
      throw new Error(
        `Unknown hook target "${raw}" (expected all, antigravity, claude, codex, or chatgpt)`
      );
    }
    add(mapped);
  }

  const runners = {
    antigravity: installAntigravityHook,
    claude: installClaudeHooks,
    codex: installCodexHooks,
  };

  return canonical.map((t) => runners[t](opts));
}

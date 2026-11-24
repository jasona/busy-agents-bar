#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlertManager } from '../src/alerts.mjs';
import { BusyBarClient } from '../src/busybar/client.mjs';
import { renderAsciiPreview, renderFrontDisplay } from '../src/busybar/renderer.mjs';
import { BusyBarInputWatcher } from '../src/busybar/ws-input.mjs';
import { loadConfig } from '../src/config.mjs';
import { BusyBarDaemon } from '../src/daemon.mjs';
import { buildFleetSnapshot } from '../src/model.mjs';
import { createProviderRegistry } from '../src/providers/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

function parseCli(argv) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg.startsWith('--no-')) {
      flags[arg.slice(5)] = false;
      continue;
    }
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { command: positionals[0] || 'help', args: positionals.slice(1), flags };
}

function buildConfigOverrides(flags) {
  const overrides = {};
  if (typeof flags.url === 'string') {
    overrides.device = { ...(overrides.device || {}), baseUrl: flags.url };
  }
  if (flags.port !== undefined && flags.port !== true) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid --port value: ${flags.port}`);
    }
    overrides.daemon = { ...(overrides.daemon || {}), controlPort: port };
  }
  if (flags.blink === false) {
    overrides.alerts = { ...(overrides.alerts || {}), blink: { enabled: false } };
  } else if (flags.blink === true) {
    overrides.alerts = { ...(overrides.alerts || {}), blink: { enabled: true } };
  }
  if (flags.chime === false) {
    overrides.alerts = { ...(overrides.alerts || {}), chime: { enabled: false } };
  } else if (flags.chime === true) {
    overrides.alerts = { ...(overrides.alerts || {}), chime: { enabled: true } };
  }
  if (flags.buttons === false) {
    overrides.controls = { ...(overrides.controls || {}), wsInputEnabled: false };
  } else if (flags.buttons === true) {
    overrides.controls = { ...(overrides.controls || {}), wsInputEnabled: true };
  }
  if (typeof flags['reset-button'] === 'string' && flags['reset-button'].trim()) {
    const btn = flags['reset-button'].trim().toLowerCase();
    if (!['back', 'ok', 'start', 'none'].includes(btn)) {
      throw new Error(`Invalid --reset-button "${flags['reset-button']}" (expected back|ok|start|none)`);
    }
    overrides.controls = {
      ...(overrides.controls || {}),
      resetButton: btn === 'none' ? null : btn,
    };
  }
  return overrides;
}

function controlUrlOf(config) {
  const host = config.daemon?.controlHost || '127.0.0.1';
  const port = config.daemon?.controlPort ?? 4388;
  return `http://${host}:${port}`;
}

async function fetchDaemonJson(url, method = 'GET', body = undefined) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2500),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function parseToggle(val, name) {
  if (val === undefined) return undefined;
  if (val === true || val === 'on' || val === 'true' || val === '1') return true;
  if (val === false || val === 'off' || val === 'false' || val === '0') return false;
  throw new Error(`Invalid --${name} value "${val}" (expected on|off)`);
}

function makeScenarioSessions(scenario, now = Date.now()) {
  switch (scenario) {
    case 'running':
      return [
        { id: 'run-1', provider: 'antigravity', project: 'busy-bar', title: 'Build daemon', status: 'running', updatedAtMs: now },
        { id: 'run-2', provider: 'antigravity', project: 'api', title: 'Add tests', status: 'running', updatedAtMs: now - 5000 },
      ];
    case 'waiting':
      return [
        { id: 'wait-1', provider: 'antigravity', project: 'busy-bar', title: 'Approve command', status: 'waiting', attentionKind: 'approval', updatedAtMs: now },
        { id: 'run-1', provider: 'antigravity', project: 'web', title: 'Lint check', status: 'running', updatedAtMs: now - 2000 },
      ];
    case 'error':
      return [
        { id: 'err-1', provider: 'antigravity', project: 'api', title: 'Build failed', status: 'error', attentionKind: 'error', updatedAtMs: now },
        { id: 'wait-1', provider: 'antigravity', project: 'busy-bar', title: 'Question', status: 'waiting', attentionKind: 'question', updatedAtMs: now - 3000 },
      ];
    case 'all_done':
      return [
        { id: 'done-1', provider: 'antigravity', project: 'busy-bar', title: 'Finished', status: 'done', updatedAtMs: now },
        { id: 'done-2', provider: 'antigravity', project: 'api', title: 'Tests passed', status: 'done', updatedAtMs: now - 1000 },
      ];
    case 'mixed':
    default:
      return [
        { id: 'err-1', provider: 'antigravity', project: 'api', title: 'Quota error', status: 'error', attentionKind: 'quota', updatedAtMs: now },
        { id: 'wait-1', provider: 'antigravity', project: 'busy-bar', title: 'Needs approval', status: 'waiting', attentionKind: 'approval', updatedAtMs: now - 1000 },
        { id: 'run-1', provider: 'antigravity', project: 'web', title: 'Running tests', status: 'running', updatedAtMs: now - 2000 },
        { id: 'done-1', provider: 'antigravity', project: 'cli', title: 'Completed', status: 'done', updatedAtMs: now - 3000 },
      ];
  }
}

function printHelp() {
  console.log(`busy-bar - Real-time agent status display daemon for BUSY Bar

Usage:
  busy-bar daemon [--config <path>] [--no-blink] [--no-chime] [--no-buttons] [--reset-button <back|ok|start>] [--port <n>] [--url <url>]
  busy-bar status [--once]
  busy-bar clear
  busy-bar reset
  busy-bar dismiss --session <id> [--provider <name>]
  busy-bar sync-once [--no-blink]
  busy-bar emit --provider <name> --session <id> --status <running|waiting|error|done|idle> [options]
  busy-bar test-screen [running|waiting|error|all_done|mixed] [--dry-run] [--no-blink]
  busy-bar test-chime [waiting|error|all_done]
  busy-bar sounds
  busy-bar alerts [--blink on|off] [--chime on|off]
  busy-bar watch-buttons
  busy-bar install-service [--dry-run]
  busy-bar install-hook [--dry-run]

Emit options:
  --attention <approval|question|error|quota|stuck>
  --project <name>   --title <text>   --activity <text>   --ttl <ms>`);
}

async function cmdDaemon(config) {
  const client = new BusyBarClient(config.device);
  const { registry, hookProvider } = await createProviderRegistry(config);
  const daemon = new BusyBarDaemon({ config, client, registry, hookProvider });

  await daemon.start();
  const st = daemon.getStatus();
  console.log(
    `[busy-bar] daemon started (device=${config.device.baseUrl}, connected=${st.connected}, control=${st.controlUrl}, phase=${st.snapshot?.phase})`
  );

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[busy-bar] received ${signal}, shutting down...`);
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function cmdStatus(config, flags) {
  if (!flags.once) {
    try {
      const data = await fetchDaemonJson(`${controlUrlOf(config)}/status`);
      console.log(JSON.stringify(data, null, 2));
      return;
    } catch (err) {
      if (err?.code === 'INVALID_URL') throw err;
    }
  }

  const now = Date.now();
  const { registry } = await createProviderRegistry(config);
  const sessions = await registry.pollAll(now);
  const recentWindow = Number(config.providers?.antigravity?.recentDoneWindowMs ?? 900000);
  const snapshot = buildFleetSnapshot(sessions, {
    clearedAtMs: Math.max(0, now - recentWindow),
    now,
    stayOnUntilCleared: config.display?.stayOnUntilCleared !== false,
  });
  console.log(
    JSON.stringify(
      {
        mode: 'one-shot',
        providers: registry.getStatuses(),
        snapshot,
      },
      null,
      2
    )
  );
}

async function postDaemonOrClearDisplay(config, endpoint) {
  try {
    const res = await fetchDaemonJson(`${controlUrlOf(config)}${endpoint}`, 'POST', {});
    console.log(JSON.stringify({ mode: 'daemon', ...res }, null, 2));
    return;
  } catch {
    const client = new BusyBarClient(config.device);
    const res = await client.clearDisplay(config.device.applicationName);
    console.log(JSON.stringify({ mode: 'direct', ...res }, null, 2));
    if (!res.ok) process.exitCode = 1;
  }
}

async function cmdClear(config) {
  await postDaemonOrClearDisplay(config, '/clear');
}

async function cmdReset(config) {
  await postDaemonOrClearDisplay(config, '/reset');
}

async function cmdDismiss(config, flags) {
  const sessionId = String(flags.session || flags.id || '').trim();
  if (!sessionId) {
    throw new Error('dismiss requires --session <id>');
  }
  const provider = String(flags.provider || 'antigravity').trim();
  const res = await fetchDaemonJson(`${controlUrlOf(config)}/dismiss`, 'POST', {
    provider,
    sessionId,
  });
  console.log(JSON.stringify(res, null, 2));
}

async function cmdSyncOnce(config) {
  const now = Date.now();
  const client = new BusyBarClient(config.device);
  const { registry } = await createProviderRegistry(config);
  const sessions = await registry.pollAll(now);
  const recentWindow = Number(config.providers?.antigravity?.recentDoneWindowMs ?? 900000);
  const snapshot = buildFleetSnapshot(sessions, {
    clearedAtMs: Math.max(0, now - recentWindow),
    now,
    stayOnUntilCleared: config.display?.stayOnUntilCleared !== false,
  });

  const alerts = new AlertManager(config.alerts);
  const blinkColor = alerts.resolveBlinkColor(snapshot);

  if (snapshot.phase === 'cleared' && config.display?.clearBehavior === 'release') {
    const res = await client.clearDisplay(config.device.applicationName);
    console.log(JSON.stringify({ action: 'clear', snapshot, result: res }, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  const payload = renderFrontDisplay(snapshot, { config, blinkColor });
  await client.clearDisplay(config.device.applicationName).catch(() => {});
  const res = await client.draw(payload);
  console.log(renderAsciiPreview(snapshot, payload));
  console.log(JSON.stringify({ action: 'draw', result: res }, null, 2));
  if (!res.ok && !res.preempted) process.exitCode = 1;
}

async function cmdEmit(config, flags) {
  const provider = String(flags.provider || 'generic').trim();
  const sessionId = String(flags.session || flags.id || '').trim();
  if (!sessionId) {
    throw new Error('emit requires --session <id>');
  }
  const body = {
    sessionId,
    status: String(flags.status || 'running').trim(),
    ...(flags.attention ? { attentionKind: String(flags.attention).trim() } : {}),
    ...(flags.project ? { project: String(flags.project).trim() } : {}),
    ...(flags.title ? { title: String(flags.title).trim() } : {}),
    ...(flags.activity ? { activity: String(flags.activity).trim() } : {}),
    ...(flags.ttl !== undefined ? { ttlMs: Number(flags.ttl) } : {}),
  };

  const res = await fetchDaemonJson(
    `${controlUrlOf(config)}/hooks/${encodeURIComponent(provider)}`,
    'POST',
    body
  );
  console.log(JSON.stringify(res, null, 2));
}

async function cmdTestScreen(config, args, flags) {
  const scenario = args[0] || 'mixed';
  const now = Date.now();
  const sessions = makeScenarioSessions(scenario, now);
  const snapshot = buildFleetSnapshot(sessions, {
    clearedAtMs: 0,
    now,
    stayOnUntilCleared: true,
  });
  const alerts = new AlertManager(config.alerts);
  const blinkColor = alerts.resolveBlinkColor(snapshot);
  const payload = renderFrontDisplay(snapshot, { config, blinkColor });

  console.log(renderAsciiPreview(snapshot, payload));
  console.log(JSON.stringify(payload, null, 2));

  if (flags['dry-run']) return;

  const client = new BusyBarClient(config.device);
  await client.clearDisplay(config.device.applicationName).catch(() => {});
  const res = await client.draw(payload);
  console.log(JSON.stringify({ result: res }, null, 2));
  if (!res.ok) process.exitCode = 1;
}

async function cmdTestChime(config, args) {
  const kind = args[0] || 'waiting';
  const keyMap = { waiting: 'waiting', error: 'error', all_done: 'allDone', allDone: 'allDone' };
  const cfgKey = keyMap[kind];
  if (!cfgKey) {
    throw new Error(`Unknown chime kind "${kind}" (expected waiting|error|all_done)`);
  }
  const sound = config.alerts?.chime?.sounds?.[cfgKey];
  if (!sound || (!sound.stockPath && !sound.path)) {
    throw new Error(`No sound configured for "${cfgKey}"`);
  }
  const client = new BusyBarClient(config.device);
  const res = await client.playAudio({
    applicationName: config.device.applicationName,
    stockPath: sound.stockPath,
    path: sound.path,
  });
  console.log(JSON.stringify({ kind, sound, result: res }, null, 2));
  if (!res.ok) process.exitCode = 1;
}

async function cmdSounds(config) {
  const client = new BusyBarClient(config.device);
  const soundsRes = await client.listStorage('/ext/apps_assets/shared/sounds');
  if (soundsRes.ok) {
    console.log(JSON.stringify({ path: '/ext/apps_assets/shared/sounds', ...soundsRes.body }, null, 2));
    return;
  }
  const sharedRes = await client.listStorage('/ext/apps_assets/shared');
  console.log(JSON.stringify({ path: '/ext/apps_assets/shared', status: sharedRes.status, body: sharedRes.body }, null, 2));
  if (!sharedRes.ok) process.exitCode = 1;
}

async function cmdAlerts(config, flags) {
  const patch = {};
  const blinkVal = parseToggle(flags.blink, 'blink');
  const chimeVal = parseToggle(flags.chime, 'chime');
  if (blinkVal !== undefined) patch.blink = blinkVal;
  if (chimeVal !== undefined) patch.chime = chimeVal;

  if (Object.keys(patch).length === 0) {
    const status = await fetchDaemonJson(`${controlUrlOf(config)}/status`);
    console.log(JSON.stringify(status.alerts, null, 2));
    return;
  }

  const res = await fetchDaemonJson(`${controlUrlOf(config)}/alerts`, 'POST', patch);
  console.log(JSON.stringify(res, null, 2));
}

function cmdInstallService(flags) {
  const templatePath = join(ROOT_DIR, 'systemd', 'busy-bar.service');
  const template = readFileSync(templatePath, 'utf-8');
  const binPath = join(ROOT_DIR, 'bin', 'busy-bar.mjs');
  const rendered = template
    .replaceAll('__NODE_BIN__', process.execPath)
    .replaceAll('__ENTRY_SCRIPT__', binPath)
    .replaceAll('__WORK_DIR__', ROOT_DIR);

  const unitPath = join(homedir(), '.config', 'systemd', 'user', 'busy-bar.service');

  if (flags['dry-run']) {
    console.log(`# Target: ${unitPath}\n${rendered}`);
    return;
  }

  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, rendered, 'utf-8');
  try {
    chmodSync(binPath, 0o755);
  } catch {
    // Ignore chmod error if filesystem does not support it.
  }

  console.log(`Installed systemd user unit: ${unitPath}`);
  console.log('Run:');
  console.log('  systemctl --user daemon-reload');
  console.log('  systemctl --user enable --now busy-bar.service');
  console.log('  systemctl --user status busy-bar.service');
}

function cmdWatchButtons(config) {
  const watcher = new BusyBarInputWatcher({
    baseUrl: config.device.baseUrl,
    enabled: true,
    resetButton: config.controls?.resetButton ?? 'back',
    resetAction: config.controls?.resetAction ?? 'press',
    onButton: (evt) => {
      console.log(`[${new Date().toISOString()}] button=${evt.button} action=${evt.action}`);
    },
  });
  console.log(
    `Watching BUSY Bar buttons on ${watcher.wsUrl} (reset trigger: ${config.controls?.resetButton ?? 'none'} ${config.controls?.resetAction ?? 'press'}). Press Ctrl+C to stop.`
  );
  watcher.start();

  const stop = () => {
    watcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

async function cmdAgyStopHook(config) {
  try {
    const raw = await readStdinText();
    if (raw) {
      const payload = JSON.parse(raw);
      const convId = typeof payload?.conversationId === 'string' ? payload.conversationId.trim() : '';
      if (payload?.terminationReason === 'USER_CANCELED' && convId) {
        await fetch(`${controlUrlOf(config)}/dismiss`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'antigravity', sessionId: convId }),
          signal: AbortSignal.timeout(300),
        });
      }
    }
  } catch {
    // Never block or error Antigravity's Stop hook lifecycle.
  }
  console.log('{}');
}

function cmdInstallHook(flags) {
  const hooksPath = join(homedir(), '.gemini', 'config', 'hooks.json');
  const binPath = join(ROOT_DIR, 'bin', 'busy-bar.mjs');
  let existing = {};
  if (existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed;
      }
    } catch (err) {
      throw new Error(`Failed to parse existing ${hooksPath}: ${err.message}`);
    }
  }

  const nextHooks = {
    ...existing,
    'busy-bar-stop': {
      Stop: [
        {
          type: 'command',
          command: `${process.execPath} ${binPath} agy-stop-hook`,
          timeout: 3,
        },
      ],
    },
  };

  const rendered = JSON.stringify(nextHooks, null, 2) + '\n';
  if (flags['dry-run']) {
    console.log(`# Target: ${hooksPath}\n${rendered}`);
    return;
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, rendered, 'utf-8');
  console.log(`Installed Antigravity Stop hook in ${hooksPath}`);
}

async function main() {
  const { command, args, flags } = parseCli(process.argv.slice(2));
  if (flags.help || command === 'help') {
    printHelp();
    return;
  }

  const configPath = typeof flags.config === 'string' ? flags.config : undefined;
  const overrides = buildConfigOverrides(flags);
  const config = loadConfig({ configPath, overrides });

  switch (command) {
    case 'daemon':
      await cmdDaemon(config);
      break;
    case 'status':
      await cmdStatus(config, flags);
      break;
    case 'clear':
      await cmdClear(config);
      break;
    case 'reset':
      await cmdReset(config);
      break;
    case 'dismiss':
      await cmdDismiss(config, flags);
      break;
    case 'sync-once':
      await cmdSyncOnce(config);
      break;
    case 'emit':
      await cmdEmit(config, flags);
      break;
    case 'test-screen':
      await cmdTestScreen(config, args, flags);
      break;
    case 'test-chime':
      await cmdTestChime(config, args);
      break;
    case 'sounds':
      await cmdSounds(config);
      break;
    case 'alerts':
      await cmdAlerts(config, flags);
      break;
    case 'watch-buttons':
      cmdWatchButtons(config);
      break;
    case 'agy-stop-hook':
      await cmdAgyStopHook(config);
      break;
    case 'install-hook':
      cmdInstallHook(flags);
      break;
    case 'install-service':
      cmdInstallService(flags);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[busy-bar] error: ${err?.message || err}`);
  process.exitCode = 1;
});

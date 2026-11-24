import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BusyBarClient } from '../src/busybar/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { BusyBarDaemon } from '../src/daemon.mjs';
import { claudeCodeHookAdapter } from '../src/providers/adapters/claude-code.mjs';
import { codexHookAdapter } from '../src/providers/adapters/codex.mjs';
import { ProviderRegistry } from '../src/providers/registry.mjs';
import { HookProvider } from '../src/providers/webhook-provider.mjs';

const NOW = 1_700_000_000_000;

test('claudeCodeHookAdapter maps all Claude Code lifecycle events and ignores noise', () => {
  assert.deepEqual(
    claudeCodeHookAdapter('claude-code', { session_id: 'c1', hook_event_name: 'SessionStart', cwd: '/work/app' }, NOW),
    { ignore: true }
  );

  const prompt = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'UserPromptSubmit', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(prompt.session.provider, 'claude-code');
  assert.equal(prompt.session.project, 'my-repo');
  assert.equal(prompt.session.status, 'running');

  const tool = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(tool.session.status, 'running');
  assert.equal(tool.session.activity, 'Tool: Bash');

  const postTool = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(postTool.session.status, 'running');
  assert.equal(postTool.session.activity, 'Tool: Edit');

  const perm = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(perm.session.status, 'waiting');
  assert.equal(perm.session.attentionKind, 'approval');

  const notifPerm = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(notifPerm.session.status, 'waiting');
  assert.equal(notifPerm.session.attentionKind, 'approval');

  const notifElicit = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Pick option', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(notifElicit.session.status, 'waiting');
  assert.equal(notifElicit.session.attentionKind, 'question');

  const notifErr = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'Notification', notification_type: 'auth_failure', message: 'Auth error', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(notifErr.session.status, 'error');
  assert.equal(notifErr.session.attentionKind, 'error');

  assert.deepEqual(
    claudeCodeHookAdapter(
      'claude-code',
      { session_id: 'c1', hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: '/work/my-repo' },
      NOW
    ),
    { ignore: true }
  );

  const stop = claudeCodeHookAdapter(
    'claude-code',
    { session_id: 'c1', hook_event_name: 'Stop', cwd: '/work/my-repo' },
    NOW
  );
  assert.equal(stop.session.status, 'done');

  assert.deepEqual(
    claudeCodeHookAdapter('claude-code', { session_id: 'c1', hook_event_name: 'SessionEnd' }, NOW),
    { remove: true, sessionId: 'c1', provider: 'claude-code' }
  );

  // Generic emit fallback preserves busy-bar emit --provider claude-code compatibility
  const emitted = claudeCodeHookAdapter(
    'claude-code',
    { sessionId: 'c2', project: 'api', status: 'waiting', attentionKind: 'approval' },
    NOW
  );
  assert.equal(emitted.session.id, 'c2');
  assert.equal(emitted.session.provider, 'claude-code');
  assert.equal(emitted.session.status, 'waiting');
});

test('codexHookAdapter maps Codex / ChatGPT lifecycle events, legacy notify, and removals', () => {
  assert.deepEqual(
    codexHookAdapter('codex', { session_id: 'x1', hook_event_name: 'SessionStart', cwd: '/work/codex-proj' }, NOW),
    { ignore: true }
  );

  const prompt = codexHookAdapter(
    'chatgpt',
    { session_id: 'x1', hook_event_name: 'UserPromptSubmit', cwd: '/work/codex-proj' },
    NOW
  );
  assert.equal(prompt.session.provider, 'codex');
  assert.equal(prompt.session.project, 'codex-proj');
  assert.equal(prompt.session.status, 'running');

  const tool = codexHookAdapter(
    'codex',
    { session_id: 'x1', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: '/work/codex-proj' },
    NOW
  );
  assert.equal(tool.session.status, 'running');
  assert.equal(tool.session.activity, 'Tool: apply_patch');

  const perm = codexHookAdapter(
    'codex',
    { session_id: 'x1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: '/work/codex-proj' },
    NOW
  );
  assert.equal(perm.session.status, 'waiting');
  assert.equal(perm.session.attentionKind, 'approval');

  const stop = codexHookAdapter(
    'codex',
    { session_id: 'x1', hook_event_name: 'Stop', cwd: '/work/codex-proj' },
    NOW
  );
  assert.equal(stop.session.status, 'done');

  const notifyComplete = codexHookAdapter(
    'codex',
    { 'thread-id': 'x2', type: 'agent-turn-complete', cwd: '/work/codex-proj' },
    NOW
  );
  assert.equal(notifyComplete.session.id, 'x2');
  assert.equal(notifyComplete.session.status, 'done');

  assert.deepEqual(
    codexHookAdapter('codex', { session_id: 'x1', hook_event_name: 'Interrupt' }, NOW),
    { remove: true, sessionId: 'x1', provider: 'codex' }
  );

  assert.deepEqual(
    codexHookAdapter('codex', { session_id: 'x1', hook_event_name: 'SessionEnd' }, NOW),
    { remove: true, sessionId: 'x1', provider: 'codex' }
  );
});

test('BusyBarDaemon processes native Claude Code and Codex webhook events end-to-end', async () => {
  const draws = [];
  const clears = [];
  const sockets = new Set();

  const mockServer = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const json = raw ? JSON.parse(raw) : null;
      if (req.method === 'POST' && url.pathname === '/api/display/draw') {
        draws.push(json);
      } else if (req.method === 'DELETE' && url.pathname === '/api/display/draw') {
        clears.push(url.searchParams.get('application_name'));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'OK' }));
    });
  });
  mockServer.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  const { port } = mockServer.address();

  const tmp = mkdtempSync(join(tmpdir(), 'busy-bar-adapters-'));
  let clock = NOW;
  const registry = new ProviderRegistry();
  const hookProvider = new HookProvider();
  registry.register(hookProvider);

  const config = loadConfig({
    overrides: {
      device: { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 },
      daemon: { pollIntervalMs: 60000, healthIntervalMs: 60000, controlPort: 0, stateFile: join(tmp, 'state.json') },
      alerts: { blink: { enabled: true }, chime: { enabled: false } },
      controls: { wsInputEnabled: false },
    },
  });

  const daemon = new BusyBarDaemon({
    config,
    client: new BusyBarClient(config.device),
    registry,
    hookProvider,
    nowFn: () => clock,
  });

  try {
    await daemon.start({ enableControlServer: true });
    const controlUrl = daemon.getStatus().controlUrl;

    // SessionStart is ignored -> stays cleared
    await fetch(`${controlUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cc-live', hook_event_name: 'SessionStart', cwd: '/work/alpha' }),
    });
    assert.equal(daemon.getStatus().snapshot.phase, 'cleared');

    // Claude prompt starts running, then Codex waits for permission
    clock += 1000;
    await fetch(`${controlUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cc-live', hook_event_name: 'UserPromptSubmit', cwd: '/work/alpha' }),
    });
    assert.equal(daemon.getStatus().snapshot.phase, 'running');

    clock += 1000;
    await fetch(`${controlUrl}/hooks/chatgpt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cx-live', hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: '/work/beta' }),
    });
    assert.equal(daemon.getStatus().snapshot.phase, 'waiting');
    assert.equal(daemon.getStatus().snapshot.counts.waiting, 1);
    assert.equal(daemon.getStatus().snapshot.counts.running, 1);

    // Codex Interrupt removes cx-live immediately -> back to running (1)
    clock += 1000;
    await fetch(`${controlUrl}/hooks/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cx-live', hook_event_name: 'Interrupt' }),
    });
    assert.equal(daemon.getStatus().snapshot.phase, 'running');
    assert.equal(daemon.getStatus().snapshot.counts.total, 1);

    // Claude Stop -> all_done, then Claude idle_prompt ignored, then SessionEnd removes it -> cleared
    clock += 1000;
    await fetch(`${controlUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cc-live', hook_event_name: 'Stop', cwd: '/work/alpha' }),
    });
    assert.equal(daemon.getStatus().snapshot.phase, 'all_done');

    await fetch(`${controlUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cc-live', hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: '/work/alpha' }),
    });
    assert.equal(daemon.getStatus().snapshot.phase, 'all_done');

    await fetch(`${controlUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cc-live', hook_event_name: 'SessionEnd' }),
    });
    assert.equal(daemon.getStatus().snapshot.phase, 'cleared');
    assert.ok(draws.length >= 4);
    assert.ok(clears.length >= 2);
  } finally {
    await daemon.stop();
    for (const s of sockets) s.destroy();
    await new Promise((r) => mockServer.close(r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

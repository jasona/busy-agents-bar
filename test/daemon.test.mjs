import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BusyBarClient } from '../src/busybar/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { BusyBarDaemon } from '../src/daemon.mjs';
import { ProviderRegistry } from '../src/providers/registry.mjs';
import { HookProvider } from '../src/providers/webhook-provider.mjs';

function startMockBusyBar() {
  const state = {
    drawCalls: [],
    clearCalls: [],
    events: [],
    audioCalls: [],
    statusCalls: 0,
    nextDrawStatus: 200,
    offline: false,
  };

  const sockets = new Set();
  const server = createServer((req, res) => {
    if (state.offline) {
      req.destroy();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const json = raw ? JSON.parse(raw) : null;

      if (req.method === 'GET' && url.pathname === '/api/status') {
        state.statusCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ device: { otp_model: 'BB.1' } }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/display/draw') {
        state.drawCalls.push(json);
        state.events.push({ type: 'draw', primary: json?.elements?.find((e) => e.id === 'primary')?.text });
        const code = state.nextDrawStatus;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(code === 200 ? { result: 'ok' } : { error: 'conflict' }));
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/api/display/draw') {
        const app = url.searchParams.get('application_name');
        state.clearCalls.push(app);
        state.events.push({ type: 'clear', app });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'ok' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/audio/play') {
        state.audioCalls.push(json);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'ok' }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

test('BusyBarDaemon end-to-end: draw-on-change, ALL DONE latch, clear, hooks, alerts, 409, and reconnect', async () => {
  const mock = await startMockBusyBar();
  const tmp = mkdtempSync(join(tmpdir(), 'busy-bar-daemon-'));
  const stateFile = join(tmp, 'state.json');

  let clock = 1_700_000_000_000;
  let fakeSessions = [
    { id: 'ag-1', provider: 'antigravity', project: 'busy-bar', status: 'running', updatedAtMs: clock },
  ];

  const registry = new ProviderRegistry();
  registry.register({
    id: 'antigravity',
    label: 'Antigravity',
    poll: () => fakeSessions,
  });
  const hookProvider = new HookProvider();
  registry.register(hookProvider);

  const config = loadConfig({
    overrides: {
      device: { baseUrl: mock.url, timeoutMs: 1000 },
      daemon: { pollIntervalMs: 60000, healthIntervalMs: 60000, controlPort: 0, stateFile },
      alerts: { chime: { cooldownMs: 0 } },
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
    assert.ok(controlUrl);

    // Startup drew once (running), no startup chime
    assert.equal(mock.state.drawCalls.length, 1);
    assert.equal(mock.state.drawCalls[0].elements.find((e) => e.id === 'primary').text, '1 RUN');
    assert.equal(mock.state.audioCalls.length, 0);

    // Unchanged sync does NOT redraw
    await daemon.sync();
    assert.equal(mock.state.drawCalls.length, 1);

    // Hook event via HTTP POST /hooks/claude-code immediately switches display to waiting + blink + chime
    clock += 1000;
    const hookRes = await fetch(`${controlUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'cc-1',
        project: 'api',
        status: 'waiting',
        attentionKind: 'approval',
      }),
    });
    assert.equal(hookRes.status, 200);
    assert.equal(mock.state.drawCalls.length, 2);
    const waitPayload = mock.state.drawCalls[1];
    assert.equal(waitPayload.led_notification_color, '#FFAA00FF');
    assert.equal(mock.state.audioCalls.length, 1);
    assert.equal(mock.state.audioCalls[0].stock_path, 'shared/calendar_event_starts.snd');

    // Disable blink & chime via POST /alerts -> forces redraw without led_notification_color
    const alertRes = await fetch(`${controlUrl}/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blink: false, chime: false }),
    });
    assert.equal(alertRes.status, 200);
    assert.equal(mock.state.drawCalls.length, 3);
    assert.equal(Object.hasOwn(mock.state.drawCalls[2], 'led_notification_color'), false);

    // Transition all sessions to done -> ALL DONE clears prior elements before drawing and stays latched
    clock += 1000;
    const clearsBeforeAllDone = mock.state.clearCalls.length;
    fakeSessions = [
      { id: 'ag-1', provider: 'antigravity', project: 'busy-bar', status: 'done', updatedAtMs: clock },
    ];
    await fetch(`${controlUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cc-1', project: 'api', status: 'done' }),
    });
    assert.equal(mock.state.drawCalls.length, 4);
    assert.equal(mock.state.clearCalls.length, clearsBeforeAllDone + 1);
    assert.deepEqual(mock.state.events.slice(-2), [
      { type: 'clear', app: 'agent-status' },
      { type: 'draw', primary: 'ALL DONE' },
    ]);
    assert.equal(mock.state.drawCalls[3].elements.find((e) => e.id === 'primary').text, 'ALL DONE');
    assert.equal(mock.state.audioCalls.length, 1);

    clock += 600_000;
    await daemon.sync();
    assert.equal(daemon.getStatus().snapshot.phase, 'all_done');
    assert.equal(mock.state.drawCalls.length, 4);

    // POST /clear issues a fresh DELETE /api/display/draw with no subsequent draw and persists clearedAtMs
    clock += 1000;
    const clearsBeforeUserClear = mock.state.clearCalls.length;
    const drawsBeforeUserClear = mock.state.drawCalls.length;
    const clearRes = await fetch(`${controlUrl}/clear`, { method: 'POST' });
    assert.equal(clearRes.status, 200);
    assert.equal(mock.state.clearCalls.length, clearsBeforeUserClear + 1);
    assert.equal(mock.state.clearCalls.at(-1), 'agent-status');
    assert.equal(mock.state.drawCalls.length, drawsBeforeUserClear);
    assert.deepEqual(mock.state.events.at(-1), { type: 'clear', app: 'agent-status' });
    assert.equal(daemon.getStatus().snapshot.phase, 'cleared');

    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(persisted.clearedAtMs, clock);

    // 409 Conflict from higher-priority BUSY timer is handled non-fatally and doesn't spam retries
    mock.state.nextDrawStatus = 409;
    clock += 1000;
    fakeSessions = [
      { id: 'ag-1', provider: 'antigravity', project: 'busy-bar', status: 'running', updatedAtMs: clock },
    ];
    await daemon.sync();
    assert.equal(mock.state.drawCalls.length, 5);
    assert.equal(daemon.getStatus().lastDrawResult.preempted, true);
    await daemon.sync();
    assert.equal(mock.state.drawCalls.length, 5);

    // Simulate USB disconnect then reconnect -> health check recovers & pushes fresh draw
    mock.state.nextDrawStatus = 200;
    mock.state.offline = true;
    clock += 1000;
    fakeSessions = [
      { id: 'ag-1', provider: 'antigravity', project: 'busy-bar', status: 'error', attentionKind: 'error', updatedAtMs: clock },
    ];
    await daemon.sync();
    assert.equal(daemon.getStatus().connected, false);

    mock.state.offline = false;
    const recovered = await daemon.checkHealth();
    assert.equal(recovered, true);
    assert.equal(daemon.getStatus().connected, true);
    assert.equal(mock.state.drawCalls.at(-1).elements.find((e) => e.id === 'primary').text, '1 ERR');
  } finally {
    await daemon.stop();
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('BusyBarDaemon reset, dismiss, and physical button watcher behavior', async () => {
  const mock = await startMockBusyBar();
  const tmp = mkdtempSync(join(tmpdir(), 'busy-bar-reset-'));
  const stateFile = join(tmp, 'state.json');

  let clock = 1_700_000_000_000;
  let fakeSessions = [
    { id: 'stuck-1', provider: 'antigravity', project: 'busy-bar', status: 'running', updatedAtMs: clock },
    { id: 'other-2', provider: 'antigravity', project: 'api', status: 'running', updatedAtMs: clock },
  ];

  const registry = new ProviderRegistry();
  registry.register({
    id: 'antigravity',
    label: 'Antigravity',
    poll: () => fakeSessions,
  });

  let capturedOnReset = null;
  const fakeWatcher = {
    started: false,
    stopped: false,
    start() { this.started = true; },
    stop() { this.stopped = true; },
    getStatus() { return { enabled: true, connected: true, resetButton: 'back', resetAction: 'press' }; },
  };

  const config = loadConfig({
    overrides: {
      device: { baseUrl: mock.url, timeoutMs: 1000 },
      daemon: { pollIntervalMs: 60000, healthIntervalMs: 60000, controlPort: 0, stateFile },
      alerts: { blink: { enabled: false }, chime: { enabled: false } },
      controls: { wsInputEnabled: true, resetButton: 'back' },
    },
  });

  const daemon = new BusyBarDaemon({
    config,
    client: new BusyBarClient(config.device),
    registry,
    inputWatcher: fakeWatcher,
    nowFn: () => clock,
  });
  capturedOnReset = () => daemon.reset({ reason: 'button:back', onlyIfVisible: true });

  try {
    await daemon.start({ enableControlServer: true });
    const controlUrl = daemon.getStatus().controlUrl;
    assert.equal(fakeWatcher.started, true);
    assert.equal(daemon.getStatus().snapshot.counts.running, 2);

    // POST /dismiss removes only stuck-1, keeping other-2 running
    const dismissRes = await fetch(`${controlUrl}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'antigravity', sessionId: 'stuck-1' }),
    });
    assert.equal(dismissRes.status, 200);
    assert.equal(daemon.getStatus().snapshot.counts.running, 1);
    assert.equal(daemon.getStatus().snapshot.sessions[0].id, 'other-2');

    // Simulated physical BACK button resets remaining visible sessions and clears the display
    clock += 1000;
    const clearsBeforeButton = mock.state.clearCalls.length;
    const btnResult = await capturedOnReset();
    assert.equal(btnResult.skipped, undefined);
    assert.equal(daemon.getStatus().snapshot.phase, 'cleared');
    assert.equal(mock.state.clearCalls.length, clearsBeforeButton + 1);

    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.ok(persisted.dismissed['antigravity:stuck-1']);
    assert.ok(persisted.dismissed['antigravity:other-2']);

    // Pressing BACK again while already cleared is a clean no-op
    const noopResult = await capturedOnReset();
    assert.equal(noopResult.skipped, true);
    assert.equal(mock.state.clearCalls.length, clearsBeforeButton + 1);

    // New activity on other-2 restores it automatically, then POST /reset dismisses it
    clock += 1000;
    fakeSessions = [
      { id: 'stuck-1', provider: 'antigravity', project: 'busy-bar', status: 'running', updatedAtMs: 1_700_000_000_000 },
      { id: 'other-2', provider: 'antigravity', project: 'api', status: 'running', updatedAtMs: clock },
    ];
    await daemon.sync();
    assert.equal(daemon.getStatus().snapshot.phase, 'running');
    assert.equal(daemon.getStatus().snapshot.counts.running, 1);

    clock += 1000;
    const resetRes = await fetch(`${controlUrl}/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 200);
    assert.equal(daemon.getStatus().snapshot.phase, 'cleared');
  } finally {
    await daemon.stop();
    assert.equal(fakeWatcher.stopped, true);
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

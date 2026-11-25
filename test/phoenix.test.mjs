import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createProviderRegistry } from '../src/providers/index.mjs';
import {
  PhoenixProvider,
  resolvePhoenixDbPaths,
  stripShellWrapper,
} from '../src/providers/phoenix/index.mjs';
import { HookProvider } from '../src/providers/webhook-provider.mjs';

function createFixtureSchema(db) {
  db.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL,
      provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      payload_json TEXT NOT NULL,
      provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_runtime_requests (
      runtime_request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      provider_turn_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      parent_node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      child_thread_id TEXT,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      driver TEXT,
      provider_instance_id TEXT,
      completion_delivery_state TEXT
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      provider_thread_id TEXT,
      provider_turn_id TEXT,
      parent_item_id TEXT,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

test('resolvePhoenixDbPaths and stripShellWrapper handle defaults, PHOENIX_HOME, and shell commands', () => {
  assert.equal(stripShellWrapper("/usr/bin/bash -lc 'rtk pnpm test'"), 'rtk pnpm test');
  assert.equal(stripShellWrapper('/bin/sh -c "git status"'), 'git status');

  const resolved = resolvePhoenixDbPaths({}, { env: { PHOENIX_HOME: '/custom/phx' }, homeDir: '/home/u' });
  assert.equal(resolved.includes('/custom/phx/userdata/statev2.sqlite'), true);
  assert.equal(resolved.includes('/home/u/.phoenix/userdata/statev2.sqlite'), true);
  assert.equal(resolved.some((p) => p.includes('/.t3/')), false);
});

test('PhoenixProvider classifies running, approval, question, error/quota, done, cancelled, subagents, stuck, and stale', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'busy-bar-phoenix-'));
  const userdata = join(tmp, 'userdata');
  mkdirSync(userdata, { recursive: true });
  const dbPath = join(userdata, 'statev2.sqlite');

  const now = 1_795_600_000_000;
  const db = new DatabaseSync(dbPath);
  createFixtureSchema(db);

  // 1. Projects
  db.prepare(
    'INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('p1', 'server', '/work/phoenix/apps/server', '[]', iso(now - 600_000), iso(now - 600_000));

  const insThread = db.prepare(
    `INSERT INTO orchestration_v2_projection_threads
     (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at, payload_json, provider_instance_id)
     VALUES (?, ?, ?, ?, 'full-access', 'default', ?, ?, ?, ?, '{}', ?)`
  );
  const insRun = db.prepare(
    `INSERT INTO orchestration_v2_projection_runs
     (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json, provider_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insReq = db.prepare(
    `INSERT INTO orchestration_v2_projection_runtime_requests
     (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
     VALUES (?, ?, 'n1', ?, ?, ?, ?)`
  );
  const insSub = db.prepare(
    `INSERT INTO orchestration_v2_projection_subagents
     (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
     VALUES (?, ?, ?, 'n1', 'codex', ?, 'spawn', ?, ?, '{}')`
  );
  const insItem = db.prepare(
    `INSERT INTO orchestration_v2_projection_turn_items
     (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Thread A: running with command_execution + active subagent (folded child thread)
  insThread.run('th-run', 'p1', 'Build server', 'codex', iso(now - 120_000), iso(now - 5_000), null, null, 'codex');
  insRun.run(
    'run-a1',
    'th-run',
    1,
    'codex',
    'running',
    iso(now - 60_000),
    null,
    JSON.stringify({ workStartedAt: iso(now - 55_000) }),
    'codex'
  );
  insItem.run(
    'it-a1',
    'th-run',
    'run-a1',
    101,
    'command_execution',
    'inProgress',
    iso(now - 5_000),
    JSON.stringify({ input: "/usr/bin/bash -lc 'rtk pnpm test'" })
  );
  insSub.run('sub-1', 'th-run', 'run-a1', 'th-child', 'running', iso(now - 3_000));
  insSub.run('sub-2', 'th-run', 'run-a1', null, 'completed', iso(now - 10_000));

  // Child thread folded into th-run
  insThread.run('th-child', 'p1', 'Child task', 'codex', iso(now - 30_000), iso(now - 3_000), null, null, 'codex');
  insRun.run('run-child', 'th-child', 1, 'codex', 'running', iso(now - 30_000), null, '{}', 'codex');

  // Thread B: pending approval runtime request
  insThread.run('th-appr', 'p1', 'Deploy migration', 'claudeAgent', iso(now - 50_000), iso(now - 4_000), null, null, 'claudeAgent');
  insRun.run('run-b1', 'th-appr', 1, 'claudeAgent', 'running', iso(now - 40_000), null, '{}', 'claudeAgent');
  insReq.run('req-b1', 'th-appr', 'command_execution', 'pending', iso(now - 4_000), '{}');
  insItem.run(
    'it-b1',
    'th-appr',
    'run-b1',
    101,
    'approval_request',
    'pending',
    iso(now - 4_000),
    JSON.stringify({ requestId: 'req-b1', requestKind: 'command_execution', prompt: 'Allow pnpm db:push?' })
  );

  // Thread C: pending user_input runtime request
  insThread.run('th-ask', 'p1', 'Pick region', 'omp', iso(now - 40_000), iso(now - 2_000), null, null, 'omp');
  insRun.run('run-c1', 'th-ask', 1, 'omp', 'waiting', iso(now - 30_000), null, '{}', 'omp');
  insReq.run('req-c1', 'th-ask', 'user_input', 'pending', iso(now - 2_000), '{}');
  insItem.run(
    'it-c1',
    'th-ask',
    'run-c1',
    101,
    'user_input_request',
    'pending',
    iso(now - 2_000),
    JSON.stringify({ requestId: 'req-c1', questions: [{ question: 'Deploy to staging or prod?' }] })
  );

  // Thread D: failed run with usage_limit -> error(quota)
  insThread.run('th-quota', 'p1', 'Quota hit', 'codex', iso(now - 25_000), iso(now - 6_000), null, null, 'codex');
  insRun.run('run-d1', 'th-quota', 1, 'codex', 'failed', iso(now - 20_000), iso(now - 6_000), '{}', 'codex');
  insItem.run(
    'it-d1',
    'th-quota',
    'run-d1',
    101,
    'error',
    'completed',
    iso(now - 6_000),
    JSON.stringify({ failure: { message: 'Rate limit 429 exceeded', errorClass: 'usage_limit' } })
  );

  // Thread E: completed run (latest ordinal=2 overrides earlier cancelled ordinal=1)
  insThread.run('th-done', 'p1', 'Finish docs', 'codex', iso(now - 20_000), iso(now - 1_000), null, null, 'codex');
  insRun.run('run-e1', 'th-done', 1, 'codex', 'cancelled', iso(now - 20_000), iso(now - 15_000), '{}', 'codex');
  insRun.run('run-e2', 'th-done', 2, 'codex', 'completed', iso(now - 10_000), iso(now - 1_000), '{}', 'codex');

  // Thread F: cancelled & Thread G: archived -> both omitted
  insThread.run('th-cancel', 'p1', 'Stopped turn', 'omp', iso(now - 10_000), iso(now - 1_000), null, null, 'omp');
  insRun.run('run-f1', 'th-cancel', 1, 'omp', 'interrupted', iso(now - 10_000), iso(now - 1_000), '{}', 'omp');
  insThread.run('th-arch', 'p1', 'Old thread', 'codex', iso(now - 10_000), iso(now - 1_000), iso(now - 500), null, 'codex');
  insRun.run('run-g1', 'th-arch', 1, 'codex', 'running', iso(now - 10_000), null, '{}', 'codex');

  db.close();

  const provider = new PhoenixProvider({
    dataDirs: [tmp],
    stuckAfterMs: 60_000,
    staleAfterMs: 300_000,
  });

  try {
    await provider.start();
    const sessions = await provider.poll(now);
    const byId = new Map(sessions.map((s) => [s.id, s]));

    assert.equal(sessions.length, 5);
    assert.equal(byId.has('th-child'), false);
    assert.equal(byId.has('th-cancel'), false);
    assert.equal(byId.has('th-arch'), false);

    const runS = byId.get('th-run');
    assert.equal(runS.provider, 'phoenix');
    assert.equal(runS.project, 'server');
    assert.equal(runS.status, 'running');
    assert.equal(runS.activity, 'Run rtk pnpm test');
    assert.equal(runS.turnStartedAtMs, now - 55_000);
    assert.equal(runS.isSwarm, true);
    assert.equal(runS.swarmWorkingCount, 1);
    assert.equal(runS.swarmTotalCount, 2);

    const apprS = byId.get('th-appr');
    assert.equal(apprS.status, 'waiting');
    assert.equal(apprS.attentionKind, 'approval');
    assert.equal(apprS.activity, 'Allow pnpm db:push?');

    const askS = byId.get('th-ask');
    assert.equal(askS.status, 'waiting');
    assert.equal(askS.attentionKind, 'question');
    assert.equal(askS.activity, 'Deploy to staging or prod?');

    const quotaS = byId.get('th-quota');
    assert.equal(quotaS.status, 'error');
    assert.equal(quotaS.attentionKind, 'quota');

    const doneS = byId.get('th-done');
    assert.equal(doneS.status, 'done');

    // Time progression hits stuckAfterMs at +120s, then expires past staleAfterMs at +400s
    const stuckSnap = await provider.poll(now + 120_000);
    const stuckById = new Map(stuckSnap.map((s) => [s.id, s]));
    assert.equal(stuckById.get('th-run').status, 'waiting');
    assert.equal(stuckById.get('th-run').attentionKind, 'stuck');
    assert.equal(stuckById.get('th-done').status, 'done');

    const staleSnap = await provider.poll(now + 400_000);
    const staleById = new Map(staleSnap.map((s) => [s.id, s]));
    assert.equal(staleById.has('th-done'), false);
    assert.equal(staleById.has('th-run'), false);

    // Missing directory returns [] cleanly without throwing
    const missing = new PhoenixProvider({ dataDirs: [join(tmp, 'nonexistent')] });
    assert.deepEqual(await missing.poll(now), []);
    assert.equal(existsSync(dbPath), true);
  } finally {
    provider.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Phoenix SQLite polling is disabled by default (opt-in via BUSY_BAR_PHOENIX=true) and Phoenix hooks drive full lifecycle without false stuck alerts', async () => {
  const defaultCfg = loadConfig({ configPath: undefined, env: {}, homeDir: '/tmp/nonexistent-home' });
  assert.equal(defaultCfg.providers.phoenix.enabled, false);
  const { phoenixProvider: defaultPhx } = await createProviderRegistry(defaultCfg);
  assert.equal(defaultPhx, null);

  const optInCfg = loadConfig({
    configPath: undefined,
    env: { BUSY_BAR_PHOENIX: 'true' },
    homeDir: '/tmp/nonexistent-home',
  });
  assert.equal(optInCfg.providers.phoenix.enabled, true);
  const { phoenixProvider: optInPhx } = await createProviderRegistry(optInCfg);
  assert.notEqual(optInPhx, null);

  const hooks = new HookProvider();
  const t0 = 1_795_700_000_000;

  const s1 = hooks.ingest(
    'phoenix',
    {
      hook_event_name: 'UserPromptSubmit',
      threadId: 'th-phx-1',
      project: 'busy-bar',
      cwd: '/work/busy-bar',
      title: 'Rethink Phoenix',
      startedAtMs: t0 - 5_000,
    },
    t0
  );
  assert.equal(s1.provider, 'phoenix');
  assert.equal(s1.status, 'running');
  assert.equal(s1.turnStartedAtMs, t0 - 5_000);

  const s2 = hooks.ingest(
    'phoenix',
    {
      hook_event_name: 'PreToolUse',
      threadId: 'th-phx-1',
      project: 'busy-bar',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    },
    t0 + 2_000
  );
  assert.equal(s2.status, 'running');
  assert.equal(s2.activity, 'Run npm test');

  const s3 = hooks.ingest(
    'phoenix',
    {
      hook_event_name: 'PermissionRequest',
      threadId: 'th-phx-1',
      project: 'busy-bar',
      requestKind: 'command_execution',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
      message: 'Approval required',
    },
    t0 + 4_000
  );
  assert.equal(s3.status, 'waiting');
  assert.equal(s3.attentionKind, 'approval');

  const s4 = hooks.ingest(
    'phoenix',
    {
      hook_event_name: 'PostToolUse',
      threadId: 'th-phx-1',
      project: 'busy-bar',
      requestKind: 'command_execution',
      requestStatus: 'resolved',
      activity: 'Working',
    },
    t0 + 6_000
  );
  assert.equal(s4.status, 'running');
  assert.equal(s4.attentionKind, null);

  const s5 = hooks.ingest(
    'phoenix',
    {
      hook_event_name: 'Notification',
      threadId: 'th-phx-1',
      project: 'busy-bar',
      notification_type: 'user_input',
      message: 'Deploy to staging?',
    },
    t0 + 8_000
  );
  assert.equal(s5.status, 'waiting');
  assert.equal(s5.attentionKind, 'question');
  assert.equal(s5.activity, 'Deploy to staging?');

  const s6 = hooks.ingest(
    'phoenix',
    {
      hook_event_name: 'Stop',
      threadId: 'th-phx-1',
      project: 'busy-bar',
      runStatus: 'completed',
    },
    t0 + 10_000
  );
  assert.equal(s6.status, 'done');

  // Even 20 minutes later, a completed hook session stays done rather than flipping to STUCK
  const latePoll = hooks.poll(t0 + 20 * 60_000);
  assert.equal(latePoll.length, 1);
  assert.equal(latePoll[0].status, 'done');

  // Interrupt / SessionEnd immediately clear the session
  hooks.ingest('phoenix', { hook_event_name: 'Interrupt', threadId: 'th-phx-1' }, t0 + 21 * 60_000);
  assert.deepEqual(hooks.poll(t0 + 21 * 60_000), []);
});

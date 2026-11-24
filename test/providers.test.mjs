import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProviderRegistry } from '../src/providers/registry.mjs';
import {
  HookProvider,
  registerHookAdapter,
  unregisterHookAdapter,
} from '../src/providers/webhook-provider.mjs';

test('ProviderRegistry isolates failing providers and merges healthy ones', async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'healthy',
    label: 'Healthy',
    poll: async (now) => [
      { id: 's1', project: 'app', status: 'running', updatedAtMs: now },
    ],
  });
  registry.register({
    id: 'broken',
    label: 'Broken',
    poll: async () => {
      throw new Error('boom');
    },
  });

  await registry.startAll({});
  const sessions = await registry.pollAll(1000);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provider, 'healthy');

  const statuses = registry.getStatuses();
  const brokenStatus = statuses.providers.find((p) => p.id === 'broken');
  assert.equal(brokenStatus.ok, false);
  assert.match(brokenStatus.lastError, /boom/);
});

test('HookProvider supports ingest, custom adapters, TTL pruning, remove, and clearDone', () => {
  let changeSignals = 0;
  const hooks = new HookProvider({ defaultTtlMs: 5000 });
  hooks.start({ emitChange: () => { changeSignals++; } });

  registerHookAdapter('claude-code', (provider, payload, now) => ({
    session: {
      id: payload.session_id,
      provider,
      project: payload.repo || 'general',
      status: payload.event === 'Stop' ? 'done' : 'waiting',
      attentionKind: payload.event === 'Notification' ? 'approval' : null,
      updatedAtMs: now,
    },
  }));

  try {
    hooks.ingest('claude-code', { session_id: 'cc-1', repo: 'busy-bar', event: 'Notification' }, 1000);
    hooks.ingest('generic', { sessionId: 'gen-1', status: 'running', ttlMs: 2000 }, 1000);
    assert.equal(changeSignals, 2);

    // At t=4000, gen-1 (ttl 2000) expires while cc-1 (ttl 5000) stays.
    let list = hooks.poll(4000);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'cc-1');
    assert.equal(list[0].status, 'waiting');
    assert.equal(list[0].attentionKind, 'approval');

    // Transition cc-1 to done -> remains retained across TTL until clearDone().
    hooks.ingest('claude-code', { session_id: 'cc-1', repo: 'busy-bar', event: 'Stop' }, 4500);
    list = hooks.poll(50_000);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'done');

    hooks.clearDone(5000);
    assert.equal(hooks.poll(50_000).length, 0);

    hooks.ingest('generic', { sessionId: 'gen-2', status: 'running' }, 50_000);
    assert.equal(hooks.remove('generic', 'gen-2'), true);
    assert.equal(hooks.poll(50_000).length, 0);
  } finally {
    unregisterHookAdapter('claude-code');
  }
});

test('ProviderRegistry dynamically loads custom ESM provider modules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'busy-bar-mod-'));
  const modPath = join(dir, 'custom-provider.mjs');
  writeFileSync(
    modPath,
    `export function createProvider() {
      return {
        id: 'custom-test',
        label: 'Custom Test',
        poll: (now) => [{ id: 'c1', project: 'custom', status: 'running', updatedAtMs: now }]
      };
    }\n`,
    'utf-8'
  );

  try {
    const registry = new ProviderRegistry();
    const res = await registry.loadCustomModules([modPath], {}, {});
    assert.deepEqual(res.loaded, ['custom-test']);
    assert.equal(res.errors.length, 0);

    const sessions = await registry.pollAll(2000);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].provider, 'custom-test');
    assert.equal(sessions[0].id, 'c1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HookProvider tracks turnStartedAtMs and step counts across turns', () => {
  const hooks = new HookProvider();
  const s1 = hooks.ingest('generic', { sessionId: 'h1', status: 'running', activity: 'Read a.mjs' }, 1000);
  assert.equal(s1.turnStartedAtMs, 1000);
  assert.equal(s1.steps, 1);

  const s2 = hooks.ingest('generic', { sessionId: 'h1', status: 'running', activity: 'Edit a.mjs' }, 2500);
  assert.equal(s2.turnStartedAtMs, 1000);
  assert.equal(s2.steps, 2);

  hooks.ingest('generic', { sessionId: 'h1', status: 'done', activity: 'Done' }, 3000);
  const s3 = hooks.ingest('generic', { sessionId: 'h1', status: 'running', activity: 'Run npm test' }, 9000);
  assert.equal(s3.turnStartedAtMs, 9000);
  assert.equal(s3.steps, 1);
});

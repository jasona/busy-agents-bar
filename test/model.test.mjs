import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFleetSnapshot, countNewCompletions, detectTransitions, normalizeSession } from '../src/model.mjs';

const NOW = 1_700_000_000_000;

test('normalizeSession sanitizes and defaults fields', () => {
  const s = normalizeSession({
    id: 's1',
    provider: 'antigravity',
    status: 'WAITING',
    project: '  ',
    updatedAtMs: NOW,
  });
  assert.equal(s.status, 'waiting');
  assert.equal(s.attentionKind, 'question');
  assert.equal(s.project, 'general');
  assert.equal(s.startedAtMs, NOW);
});

test('buildFleetSnapshot enforces phase priority error > waiting > running > all_done > cleared', () => {
  const done = { id: 'd1', provider: 'ag', status: 'done', updatedAtMs: NOW };
  const run = { id: 'r1', provider: 'ag', status: 'running', updatedAtMs: NOW };
  const wait = { id: 'w1', provider: 'ag', status: 'waiting', attentionKind: 'approval', updatedAtMs: NOW };
  const err = { id: 'e1', provider: 'ag', status: 'error', attentionKind: 'quota', updatedAtMs: NOW };

  assert.equal(buildFleetSnapshot([done, run, wait, err], { now: NOW }).phase, 'error');
  assert.equal(buildFleetSnapshot([done, run, wait], { now: NOW }).phase, 'waiting');
  assert.equal(buildFleetSnapshot([done, run], { now: NOW }).phase, 'running');
  assert.equal(buildFleetSnapshot([done], { now: NOW }).phase, 'all_done');
  assert.equal(buildFleetSnapshot([], { now: NOW }).phase, 'cleared');
});

test('buildFleetSnapshot honors stayOnUntilCleared and clearedAtMs gating', () => {
  const doneOld = { id: 'd1', provider: 'ag', status: 'done', updatedAtMs: NOW - 10_000 };
  const doneNew = { id: 'd2', provider: 'ag', status: 'done', updatedAtMs: NOW + 1_000 };

  // Stays in all_done indefinitely while stayOnUntilCleared=true and updatedAtMs > clearedAtMs.
  const held = buildFleetSnapshot([doneOld], {
    clearedAtMs: NOW - 20_000,
    now: NOW + 86_400_000,
    stayOnUntilCleared: true,
  });
  assert.equal(held.phase, 'all_done');
  assert.equal(held.counts.done, 1);

  // Once clearedAtMs advances past doneOld.updatedAtMs, phase becomes cleared.
  const afterClear = buildFleetSnapshot([doneOld], {
    clearedAtMs: NOW,
    now: NOW + 1_000,
    stayOnUntilCleared: true,
  });
  assert.equal(afterClear.phase, 'cleared');
  assert.equal(afterClear.counts.done, 0);

  // Newer completions after clearedAtMs appear again.
  const newer = buildFleetSnapshot([doneOld, doneNew], {
    clearedAtMs: NOW,
    now: NOW + 2_000,
    stayOnUntilCleared: true,
  });
  assert.equal(newer.phase, 'all_done');
  assert.equal(newer.counts.done, 1);
  assert.equal(newer.sessions[0].id, 'd2');

  // With stayOnUntilCleared=false and no active sessions, drops to cleared.
  const nonHeld = buildFleetSnapshot([doneOld], {
    clearedAtMs: 0,
    now: NOW,
    stayOnUntilCleared: false,
  });
  assert.equal(nonHeld.phase, 'cleared');
});

test('buildFleetSnapshot suppresses dismissed sessions across all statuses until updatedAtMs advances', () => {
  const running = { id: 'r1', provider: 'antigravity', status: 'running', updatedAtMs: NOW };
  const waiting = { id: 'w1', provider: 'antigravity', status: 'waiting', attentionKind: 'approval', updatedAtMs: NOW };
  const err = { id: 'e1', provider: 'antigravity', status: 'error', attentionKind: 'error', updatedAtMs: NOW };
  const done = { id: 'd1', provider: 'antigravity', status: 'done', updatedAtMs: NOW };

  const dismissed = {
    'antigravity:r1': NOW,
    'antigravity:w1': NOW,
    'antigravity:e1': NOW,
    'antigravity:d1': NOW,
  };

  const suppressed = buildFleetSnapshot([running, waiting, err, done], {
    dismissed,
    now: NOW + 1_000,
  });
  assert.equal(suppressed.phase, 'cleared');
  assert.equal(suppressed.counts.total, 0);

  // Once a session gets new activity (updatedAtMs > dismissed[key]), it automatically reappears.
  const resumed = buildFleetSnapshot(
    [{ ...running, updatedAtMs: NOW + 500 }, waiting, err, done],
    { dismissed, now: NOW + 1_000 }
  );
  assert.equal(resumed.phase, 'running');
  assert.equal(resumed.counts.total, 1);
  assert.equal(resumed.sessions[0].id, 'r1');
});

test('detectTransitions skips startup snapshot and detects new error, waiting, and all_done', () => {
  const sRun = { id: '1', provider: 'ag', status: 'running', updatedAtMs: NOW };
  const sWait = { id: '1', provider: 'ag', status: 'waiting', attentionKind: 'approval', updatedAtMs: NOW + 100 };
  const sWaitQ = { id: '1', provider: 'ag', status: 'waiting', attentionKind: 'question', updatedAtMs: NOW + 200 };
  const sErr = { id: '2', provider: 'ag', status: 'error', attentionKind: 'error', updatedAtMs: NOW + 300 };
  const sDone = { id: '1', provider: 'ag', status: 'done', updatedAtMs: NOW + 400 };

  const snapRun = buildFleetSnapshot([sRun], { now: NOW });
  assert.deepEqual(detectTransitions(null, snapRun), []);
  assert.deepEqual(detectTransitions(snapRun, snapRun), []);

  const snapWait = buildFleetSnapshot([sWait], { now: NOW + 100 });
  assert.deepEqual(detectTransitions(snapRun, snapWait), [
    { kind: 'waiting', sessionIds: ['ag:1'] },
  ]);

  // Changing attentionKind while waiting triggers waiting transition again.
  const snapWaitQ = buildFleetSnapshot([sWaitQ], { now: NOW + 200 });
  assert.deepEqual(detectTransitions(snapWait, snapWaitQ), [
    { kind: 'waiting', sessionIds: ['ag:1'] },
  ]);

  const snapErr = buildFleetSnapshot([sWaitQ, sErr], { now: NOW + 300 });
  assert.deepEqual(detectTransitions(snapWaitQ, snapErr), [
    { kind: 'error', sessionIds: ['ag:2'] },
  ]);

  const snapDone = buildFleetSnapshot([sDone], { now: NOW + 400 });
  assert.deepEqual(detectTransitions(snapRun, snapDone), [
    { kind: 'all_done', count: 1 },
  ]);

  // Repeated all_done poll does not re-emit transition.
  assert.deepEqual(detectTransitions(snapDone, snapDone), []);
});

test('countNewCompletions, turnStartedAtMs, and activity fingerprint sensitivity behave properly', () => {
  const s1 = normalizeSession({
    id: 'a1',
    provider: 'claude-code',
    status: 'running',
    activity: 'Edit foo.mjs',
    steps: 4,
    startedAtMs: NOW - 5000,
    turnStartedAtMs: NOW - 1000,
    updatedAtMs: NOW,
  });
  assert.equal(s1.turnStartedAtMs, NOW - 1000);
  assert.equal(s1.steps, 4);

  const snapA = buildFleetSnapshot([s1], { now: NOW });
  const snapB = buildFleetSnapshot([{ ...s1, activity: 'Run npm test' }], { now: NOW + 500 });
  assert.notEqual(snapA.fingerprint, snapB.fingerprint);

  const snapDone1 = buildFleetSnapshot([{ ...s1, status: 'done', updatedAtMs: NOW + 1000 }], { now: NOW + 1000 });
  assert.equal(countNewCompletions(null, snapDone1), 0);
  assert.equal(countNewCompletions(snapB, snapDone1), 1);
  assert.equal(countNewCompletions(snapDone1, snapDone1), 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { AlertManager } from '../src/alerts.mjs';

test('AlertManager handles all 4 combinations of blink x chime enabled', () => {
  const waitSnap = { phase: 'waiting' };
  const transitions = [{ kind: 'waiting', sessionIds: ['ag:1'] }];

  // 1. Both enabled
  const bothOn = new AlertManager({ blink: { enabled: true }, chime: { enabled: true } });
  assert.equal(bothOn.resolveBlinkColor(waitSnap), '#FFAA00FF');
  assert.equal(bothOn.selectChimes(transitions, 1000).length, 1);

  // 2. Blink only
  const blinkOnly = new AlertManager({ blink: { enabled: true }, chime: { enabled: false } });
  assert.equal(blinkOnly.resolveBlinkColor(waitSnap), '#FFAA00FF');
  assert.equal(blinkOnly.selectChimes(transitions, 1000).length, 0);

  // 3. Chime only
  const chimeOnly = new AlertManager({ blink: { enabled: false }, chime: { enabled: true } });
  assert.equal(chimeOnly.resolveBlinkColor(waitSnap), null);
  assert.equal(chimeOnly.selectChimes(transitions, 1000).length, 1);

  // 4. Both disabled
  const bothOff = new AlertManager({ blink: { enabled: false }, chime: { enabled: false } });
  assert.equal(bothOff.resolveBlinkColor(waitSnap), null);
  assert.equal(bothOff.selectChimes(transitions, 1000).length, 0);
});

test('AlertManager respects per-event toggles, priority order, cooldown, and runtime updates', () => {
  const alerts = new AlertManager({
    blink: { enabled: true, onWaiting: false, onError: true, onAllDone: true },
    chime: { enabled: true, onWaiting: false, onError: true, onAllDone: true, cooldownMs: 10000 },
  });

  // Waiting suppressed by per-event toggle
  assert.equal(alerts.resolveBlinkColor({ phase: 'waiting' }), null);
  assert.equal(alerts.selectChimes([{ kind: 'waiting', sessionIds: ['1'] }], 1000).length, 0);

  // Error takes priority over all_done and triggers cooldown
  const picked = alerts.selectChimes(
    [
      { kind: 'all_done', count: 1 },
      { kind: 'error', sessionIds: ['2'] },
    ],
    1000
  );
  assert.equal(picked.length, 1);
  assert.equal(picked[0].kind, 'error');

  // Within cooldown window -> suppressed
  assert.equal(alerts.selectChimes([{ kind: 'error', sessionIds: ['3'] }], 5000).length, 0);

  // Past cooldown window -> fires again
  assert.equal(alerts.selectChimes([{ kind: 'error', sessionIds: ['3'] }], 12000).length, 1);

  // Runtime toggle enables waiting blink and disables chime
  alerts.updateConfig({ blink: { onWaiting: true }, chime: { enabled: false } });
  assert.equal(alerts.resolveBlinkColor({ phase: 'waiting' }), '#FFAA00FF');
  assert.equal(alerts.selectChimes([{ kind: 'all_done', count: 1 }], 25000).length, 0);
});

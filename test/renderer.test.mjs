import assert from 'node:assert/strict';
import test from 'node:test';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, renderAsciiPreview, renderFrontDisplay, sanitizeAscii } from '../src/busybar/renderer.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { buildFleetSnapshot } from '../src/model.mjs';

const ASCII_RE = /^[\x20-\x7E]+$/;
const COLOR_RE = /^#[a-fA-F0-9]{8}$/;
const ID_RE = /^[a-zA-Z0-9._-]+$/;

function assertValidOpenApiPayload(payload) {
  assert.match(payload.application_name, ID_RE);
  assert.ok(payload.priority >= 1 && payload.priority <= 100);
  assert.ok(Array.isArray(payload.elements) && payload.elements.length >= 1);

  if (Object.hasOwn(payload, 'led_notification_color')) {
    assert.match(payload.led_notification_color, COLOR_RE);
  }

  for (const el of payload.elements) {
    assert.match(el.id, ID_RE);
    assert.equal(el.display, 'front');
    assert.equal(el.timeout, 0);
    assert.ok(el.x >= 0 && el.x < DISPLAY_WIDTH, `x=${el.x} out of range`);
    assert.ok(el.y >= 0 && el.y < DISPLAY_HEIGHT, `y=${el.y} out of range`);

    if (el.type === 'text') {
      assert.ok(el.text.length >= 1);
      assert.match(el.text, ASCII_RE);
      assert.match(el.color, COLOR_RE);
    } else if (el.type === 'rectangle') {
      assert.equal(el.border_width, 0);
      assert.ok(el.width >= 1 && el.x + el.width <= DISPLAY_WIDTH, `rect overflow: ${el.x}+${el.width}`);
      assert.ok(el.height >= 1 && el.y + el.height <= DISPLAY_HEIGHT);
      for (const c of el.fill_colors) {
        assert.match(c, COLOR_RE);
      }
    }
  }
}

test('sanitizeAscii normalizes unicode punctuation and strips non-printable characters', () => {
  assert.equal(sanitizeAscii('busy\u2014bar \u201Chello\u201D \u{1F680}'), 'busy-bar "hello"');
  assert.equal(sanitizeAscii('\u{1F680}\n\t', 10, 'proj'), 'proj');
});

test('renderFrontDisplay satisfies OpenAPI constraints across all phases and 18 pips', () => {
  const now = Date.now();
  const sessions = Array.from({ length: 20 }, (_, i) => ({
    id: `s-${i}`,
    provider: 'antigravity',
    project: i === 0 ? 'very-long-project-name-\u2014demo' : 'api',
    status: i === 0 ? 'error' : i < 3 ? 'waiting' : i < 8 ? 'running' : 'done',
    attentionKind: i === 0 ? 'quota' : i < 3 ? 'approval' : null,
    updatedAtMs: now - i * 1000,
  }));

  const snap = buildFleetSnapshot(sessions, { now });
  const withBlink = renderFrontDisplay(snap, {
    config: DEFAULT_CONFIG,
    blinkColor: '#FF0000FF',
  });
  assertValidOpenApiPayload(withBlink);
  assert.equal(withBlink.led_notification_color, '#FF0000FF');

  const pips = withBlink.elements.filter((e) => e.id.startsWith('pip-'));
  assert.equal(pips.length, 18);

  const withoutBlink = renderFrontDisplay(snap, {
    config: DEFAULT_CONFIG,
    blinkColor: null,
  });
  assertValidOpenApiPayload(withoutBlink);
  assert.equal(Object.hasOwn(withoutBlink, 'led_notification_color'), false);

  for (const phaseSessions of [
    [{ id: 'w1', provider: 'ag', project: 'busy-bar', status: 'waiting', attentionKind: 'approval', updatedAtMs: now }],
    [{ id: 'r1', provider: 'ag', project: 'busy-bar-extra-long', status: 'running', updatedAtMs: now }],
    [{ id: 'd1', provider: 'ag', project: 'busy-bar', status: 'done', updatedAtMs: now }],
    [],
  ]) {
    const s = buildFleetSnapshot(phaseSessions, { now });
    const p = renderFrontDisplay(s, { config: DEFAULT_CONFIG, blinkColor: null });
    assertValidOpenApiPayload(p);
    assert.ok(renderAsciiPreview(s, p).includes('BUSY BAR 72x16'));
  }
});

test('renderFrontDisplay respects urgentOverrideTimer priority flag', () => {
  const now = Date.now();
  const snap = buildFleetSnapshot(
    [{ id: 'w1', provider: 'ag', status: 'waiting', attentionKind: 'approval', updatedAtMs: now }],
    { now }
  );

  const normal = renderFrontDisplay(snap, { config: DEFAULT_CONFIG });
  assert.equal(normal.priority, 50);

  const overrideCfg = {
    ...DEFAULT_CONFIG,
    device: { ...DEFAULT_CONFIG.device, urgentOverrideTimer: true, urgentPriority: 95 },
  };
  const urgent = renderFrontDisplay(snap, { config: overrideCfg });
  assert.equal(urgent.priority, 95);
});

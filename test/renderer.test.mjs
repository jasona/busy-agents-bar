import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  getProviderMeta,
  getWaitingUrgency,
  renderAsciiPreview,
  renderFrontDisplay,
  renderToastOverlay,
  sanitizeAscii,
} from '../src/busybar/renderer.mjs';
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
      assert.ok(el.width >= 1 && el.x + el.width <= DISPLAY_WIDTH, `rect overflow: ${el.x}+${el.width}`);
      assert.ok(el.height >= 1 && el.y + el.height <= DISPLAY_HEIGHT);
      if (el.fill !== 'none') {
        assert.equal(el.border_width, 0);
        const expectedColors = el.fill === 'gradient_h' || el.fill === 'gradient_v' ? 2 : 1;
        assert.equal(el.fill_colors.length, expectedColors);
        for (const c of el.fill_colors) {
          assert.match(c, COLOR_RE);
        }
      } else {
        assert.match(el.border_color, COLOR_RE);
      }
    } else if (el.type === 'countdown') {
      assert.match(el.timestamp, /^[0-9]+$/);
      assert.ok(el.direction === 'time_since' || el.direction === 'time_left');
      assert.ok(el.show_hours === 'when_non_zero' || el.show_hours === 'always');
      assert.match(el.color, COLOR_RE);
    } else if (el.type === 'animation' || el.type === 'image') {
      assert.match(el.stock_path || el.path, /^[\x20-\x7E]+$/);
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

test('renderFrontDisplay renders animations, live countdown timers with RTC offset, and urgency escalation', () => {
  const now = 1_700_000_500_000;
  const runSnap = buildFleetSnapshot(
    [
      {
        id: 'r1',
        provider: 'antigravity',
        project: 'busy-bar',
        status: 'running',
        turnStartedAtMs: now - 90_000,
        updatedAtMs: now,
      },
      {
        id: 'r2',
        provider: 'claude-code',
        project: 'api',
        status: 'running',
        turnStartedAtMs: now - 30_000,
        updatedAtMs: now - 10_000,
      },
    ],
    { now }
  );

  const payload = renderFrontDisplay(runSnap, {
    config: DEFAULT_CONFIG,
    deviceClockOffsetMs: -1_000_000,
    now,
  });
  assertValidOpenApiPayload(payload);
  assert.equal(payload.elements.find((e) => e.id === 'icon')?.type, 'animation');
  const timer = payload.elements.find((e) => e.id === 'timer');
  assert.equal(timer?.type, 'countdown');
  assert.equal(timer?.timestamp, String(Math.floor((now - 90_000 - 1_000_000) / 1000)));
  const pip0 = payload.elements.find((e) => e.id === 'pip-0');
  const pip1 = payload.elements.find((e) => e.id === 'pip-1');
  assert.equal(pip0.fill, 'gradient_h');
  assert.equal(pip0.fill_colors[1], getProviderMeta('antigravity').color);
  assert.equal(pip1.fill_colors[1], getProviderMeta('claude-code').color);

  // Disabled animations/timers falls back to static layout without icon/timer
  const plainCfg = {
    ...DEFAULT_CONFIG,
    display: { ...DEFAULT_CONFIG.display, animations: false, showTimers: false },
  };
  const plain = renderFrontDisplay(runSnap, { config: plainCfg, now });
  assertValidOpenApiPayload(plain);
  assert.equal(plain.elements.some((e) => e.id === 'icon'), false);
  assert.equal(plain.elements.some((e) => e.id === 'timer'), false);

  // Urgency escalation transitions normal -> elevated -> critical
  const waitNormal = buildFleetSnapshot(
    [{ id: 'w1', provider: 'codex', status: 'waiting', attentionKind: 'approval', updatedAtMs: now - 30_000 }],
    { now }
  );
  const waitElevated = buildFleetSnapshot(
    [{ id: 'w1', provider: 'codex', status: 'waiting', attentionKind: 'approval', updatedAtMs: now - 150_000 }],
    { now }
  );
  const waitCritical = buildFleetSnapshot(
    [{ id: 'w1', provider: 'codex', status: 'waiting', attentionKind: 'approval', updatedAtMs: now - 360_000 }],
    { now }
  );
  assert.equal(getWaitingUrgency(waitNormal, DEFAULT_CONFIG, now).level, 'normal');
  assert.equal(getWaitingUrgency(waitElevated, DEFAULT_CONFIG, now).level, 'elevated');
  assert.equal(getWaitingUrgency(waitCritical, DEFAULT_CONFIG, now).level, 'critical');
  const critPayload = renderFrontDisplay(waitCritical, { config: DEFAULT_CONFIG, now });
  assertValidOpenApiPayload(critPayload);
  assert.equal(critPayload.elements.find((e) => e.id === 'primary').color, '#FF3300FF');
});

test('renderFrontDisplay spotlight, pulse, and toast overlay satisfy OpenAPI and show rich telemetry', () => {
  const now = 1_700_000_500_000;
  const sessions = [
    {
      id: 'swm-1',
      provider: 'antigravity',
      project: 'busy-bar',
      activity: 'Edit src/busybar/renderer.mjs with long scrolling text',
      status: 'running',
      isSwarm: true,
      swarmWorkingCount: 2,
      swarmTotalCount: 4,
      updatedAtMs: now,
    },
    {
      id: 'cc-1',
      provider: 'claude-code',
      project: 'api',
      activity: 'Approve Bash: npm test',
      status: 'waiting',
      attentionKind: 'approval',
      updatedAtMs: now - 5000,
    },
    {
      id: 'cx-1',
      provider: 'codex',
      project: 'docs',
      activity: 'apply_patch README.md',
      status: 'running',
      updatedAtMs: now - 9000,
    },
  ];
  const snap = buildFleetSnapshot(sessions, { now });

  // Spotlight index 0 (swarm badge + bright active pip + dimmed inactive pips)
  const spot0 = renderFrontDisplay(snap, {
    config: DEFAULT_CONFIG,
    viewMode: 'spotlight',
    spotlightIndex: 0,
    now,
  });
  assertValidOpenApiPayload(spot0);
  assert.equal(spot0.elements.find((e) => e.id === 'provider').text, 'CLD');

  const spot1 = renderFrontDisplay(snap, {
    config: DEFAULT_CONFIG,
    viewMode: 'spotlight',
    spotlightIndex: 1,
    now,
  });
  assertValidOpenApiPayload(spot1);
  assert.equal(spot1.elements.find((e) => e.id === 'provider').text, 'AGY');
  assert.equal(spot1.elements.find((e) => e.id === 'badge').text, 'SWM 2/4');
  assert.equal(spot1.elements.find((e) => e.id === 'pip-1').height, 3);
  assert.equal(spot1.elements.find((e) => e.id === 'pip-0').height, 2);
  assert.ok(renderAsciiPreview(snap, spot1, 'spotlight').includes('mode=spotlight'));

  // Pulse mode shows provider breakdown, daily count or MUTE, and 72px full bar
  const pulse = renderFrontDisplay(snap, {
    config: DEFAULT_CONFIG,
    viewMode: 'pulse',
    dailyStats: { date: '2026-11-24', completed: 7, errors: 0 },
    muted: true,
    now,
  });
  assertValidOpenApiPayload(pulse);
  assert.equal(pulse.elements.find((e) => e.id === 'pulse_meta').text, 'MUTE');
  const bars = pulse.elements.filter((e) => e.id.startsWith('bar-'));
  const totalSpan = bars.reduce((sum, b) => sum + b.width, 0) + (bars.length - 1);
  assert.equal(totalSpan, DISPLAY_WIDTH);
  assert.ok(renderAsciiPreview(snap, pulse, 'pulse').includes('mode=pulse'));

  // Pulse mode when cleared displays baseline bar
  const pulseCleared = renderFrontDisplay(buildFleetSnapshot([], { now }), {
    config: DEFAULT_CONFIG,
    viewMode: 'pulse',
    dailyStats: { date: '2026-11-24', completed: 3, errors: 0 },
    muted: false,
    now,
  });
  assertValidOpenApiPayload(pulseCleared);
  assert.equal(pulseCleared.elements.find((e) => e.id === 'prov-0').text, 'TODAY 3 DONE');

  // Toast overlay validates cleanly
  const toast = renderToastOverlay({ text: 'CHIME OFF', color: '#FFAA00FF' }, { config: DEFAULT_CONFIG });
  assertValidOpenApiPayload(toast);
  assert.equal(toast.elements.find((e) => e.id === 'toast_text').text, 'CHIME OFF');
  assert.ok(renderAsciiPreview(snap, toast).includes('toast'));
});

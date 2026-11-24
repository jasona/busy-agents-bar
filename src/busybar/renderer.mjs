export const DISPLAY_WIDTH = 72;
export const DISPLAY_HEIGHT = 16;

const ACCENT_COLORS = {
  error: '#FF2222FF',
  waiting: '#FFAA00FF',
  running: '#00FF55FF',
  all_done: '#00DDAAFF',
  cleared: '#335566FF',
};

const PIP_COLORS = {
  error: '#FF2222FF',
  waiting: '#FFAA00FF',
  running: '#00FF55FF',
};

const UNICODE_ASCII_MAP = [
  [/[\u2018\u2019]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/[\u2013\u2014]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u2192\u2794]/g, '->'],
  [/\u2190/g, '<-'],
  [/\u00B7/g, '.'],
];

/**
 * Normalizes text to printable ASCII (0x20..0x7E) required by BUSY Bar bitmap fonts.
 */
export function sanitizeAscii(text, maxLen = 32, fallback = '?') {
  let s = String(text ?? '');
  for (const [re, rep] of UNICODE_ASCII_MAP) {
    s = s.replace(re, rep);
  }
  s = s.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = fallback;
  if (maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, maxLen).trimEnd() || fallback;
  }
  return s;
}

function attentionTag(kind) {
  switch (kind) {
    case 'approval':
      return 'APPR';
    case 'question':
      return 'ASK';
    case 'stuck':
      return 'STUCK';
    case 'quota':
      return 'QUOTA';
    case 'error':
      return 'ERR';
    default:
      return '';
  }
}

function buildRightInfoText(snapshot, showProjectName) {
  const primary = snapshot.primarySession;
  if (!primary) return '';
  if (showProjectName && primary.project && primary.project !== 'general') {
    return sanitizeAscii(primary.project, 20, '');
  }
  return attentionTag(primary.attentionKind);
}

function makeScrollingOrRightTiny({ id, text, color, startX = 38 }) {
  const safe = sanitizeAscii(text, 20, '');
  if (!safe) return null;
  const maxStaticWidth = DISPLAY_WIDTH - startX; // e.g. 34px (~8 tiny chars)
  const approxWidth = safe.length * 4;
  if (approxWidth <= maxStaticWidth) {
    return {
      id,
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 71,
      y: 3,
      align: 'top_right',
      text: safe,
      font: 'tiny',
      color,
    };
  }
  return {
    id,
    type: 'text',
    display: 'front',
    timeout: 0,
    x: startX,
    y: 3,
    align: 'top_left',
    text: safe,
    font: 'tiny',
    color,
    width: DISPLAY_WIDTH - startX,
    scroll_rate: 600,
    scroll_start_delay: 1000,
    scroll_repeat_delay: 2500,
  };
}

function buildFleetPips(snapshot) {
  const sessions = snapshot.sessions || [];
  const count = Math.min(sessions.length, 18);
  if (count === 0) return [];

  const gap = 1;
  const pipWidth = Math.max(2, Math.floor((DISPLAY_WIDTH - (count - 1) * gap) / count));
  const elements = [];

  for (let i = 0; i < count; i++) {
    const s = sessions[i];
    const x = i * (pipWidth + gap);
    if (x >= DISPLAY_WIDTH) break;
    const width = Math.min(pipWidth, DISPLAY_WIDTH - x);
    const color =
      s.status === 'done'
        ? snapshot.phase === 'all_done'
          ? '#00DDAAFF'
          : '#00AAFFFF'
        : PIP_COLORS[s.status] || '#335566FF';

    elements.push({
      id: `pip-${i}`,
      type: 'rectangle',
      display: 'front',
      timeout: 0,
      x,
      y: 13,
      align: 'top_left',
      width,
      height: 3,
      radius: 0,
      fill: 'solid',
      fill_colors: [color],
      border_width: 0,
    });
  }

  return elements;
}

/**
 * Renders a FleetSnapshot into a BUSY Bar `/api/display/draw` payload targeting the 72x16 front RGB screen.
 */
export function renderFrontDisplay(snapshot, { config, blinkColor = null } = {}) {
  const deviceCfg = config?.device || {};
  const displayCfg = config?.display || {};
  const showProjectName = displayCfg.showProjectName !== false;
  const { phase, counts } = snapshot;

  const isUrgent = phase === 'error' || phase === 'waiting';
  const basePriority = Number(deviceCfg.priority ?? 50);
  const urgentPriority = Number(deviceCfg.urgentPriority ?? 95);
  const priority = Math.max(
    1,
    Math.min(100, isUrgent && deviceCfg.urgentOverrideTimer ? urgentPriority : basePriority)
  );

  const elements = [
    {
      id: 'accent',
      type: 'rectangle',
      display: 'front',
      timeout: 0,
      x: 0,
      y: 1,
      align: 'top_left',
      width: 2,
      height: 9,
      radius: 0,
      fill: 'solid',
      fill_colors: [ACCENT_COLORS[phase] || ACCENT_COLORS.cleared],
      border_width: 0,
    },
  ];

  if (phase === 'error') {
    const hasSecondaryCount = counts.waiting > 0 || counts.running > 0;
    const errText = counts.error >= 10 && hasSecondaryCount ? `${counts.error}E` : `${counts.error} ERR`;
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 4,
      y: 1,
      align: 'top_left',
      text: errText,
      font: 'small',
      color: '#FF3333FF',
    });

    if (counts.waiting > 0) {
      elements.push({
        id: 'secondary',
        type: 'text',
        display: 'front',
        timeout: 0,
        x: 71,
        y: 1,
        align: 'top_right',
        text: `${counts.waiting}W`,
        font: 'small',
        color: '#FFAA00FF',
      });
    } else if (counts.running > 0) {
      elements.push({
        id: 'secondary',
        type: 'text',
        display: 'front',
        timeout: 0,
        x: 71,
        y: 1,
        align: 'top_right',
        text: `${counts.running}R`,
        font: 'small',
        color: '#00FF55FF',
      });
    } else {
      const info = buildRightInfoText(snapshot, showProjectName) || 'ERR';
      const rightEl = makeScrollingOrRightTiny({
        id: 'secondary',
        text: info,
        color: '#FF8888FF',
        startX: 38,
      });
      if (rightEl) elements.push(rightEl);
    }
  } else if (phase === 'waiting') {
    const waitText = counts.waiting >= 10 ? `${counts.waiting}W` : `${counts.waiting} WAIT`;
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 4,
      y: 1,
      align: 'top_left',
      text: waitText,
      font: 'small',
      color: '#FFAA00FF',
    });

    if (counts.running > 0) {
      elements.push({
        id: 'secondary',
        type: 'text',
        display: 'front',
        timeout: 0,
        x: 71,
        y: 1,
        align: 'top_right',
        text: `${counts.running}R`,
        font: 'small',
        color: '#00FF55FF',
      });
    } else {
      const tag = attentionTag(snapshot.primarySession?.attentionKind);
      const proj =
        showProjectName &&
        snapshot.primarySession?.project &&
        snapshot.primarySession.project !== 'general'
          ? sanitizeAscii(snapshot.primarySession.project, 16, '')
          : '';
      const info = proj || tag;
      if (info) {
        const rightEl = makeScrollingOrRightTiny({
          id: 'secondary',
          text: info,
          color: '#FFD066FF',
          startX: 41,
        });
        if (rightEl) elements.push(rightEl);
      }
    }
  } else if (phase === 'running') {
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 4,
      y: 1,
      align: 'top_left',
      text: `${counts.running} RUN`,
      font: 'small',
      color: '#00FF55FF',
    });

    if (counts.done > 0) {
      elements.push({
        id: 'secondary',
        type: 'text',
        display: 'front',
        timeout: 0,
        x: 71,
        y: 3,
        align: 'top_right',
        text: `${counts.done} OK`,
        font: 'tiny',
        color: '#00AAFFFF',
      });
    } else if (showProjectName && snapshot.primarySession?.project) {
      const rightEl = makeScrollingOrRightTiny({
        id: 'secondary',
        text: snapshot.primarySession.project,
        color: '#88CCAAFF',
        startX: 38,
      });
      if (rightEl) elements.push(rightEl);
    }
  } else if (phase === 'all_done') {
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 37,
      y: 1,
      align: 'top_mid',
      text: 'ALL DONE',
      font: 'small',
      color: '#00FFAAFF',
    });
  } else {
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 37,
      y: 1,
      align: 'top_mid',
      text: 'IDLE',
      font: 'small',
      color: '#557788FF',
    });
  }

  elements.push(...buildFleetPips(snapshot));

  const payload = {
    application_name: String(deviceCfg.applicationName || 'agent-status'),
    priority,
    elements,
  };

  if (typeof blinkColor === 'string' && /^#[a-fA-F0-9]{8}$/.test(blinkColor)) {
    payload.led_notification_color = blinkColor;
  }

  return payload;
}

/**
 * Formats a concise terminal preview of the rendered 72x16 layout for dry-run debugging.
 */
export function renderAsciiPreview(snapshot, payload) {
  const texts = (payload?.elements || []).filter((e) => e.type === 'text');
  const primary = texts.find((e) => e.id === 'primary')?.text || '';
  const secondary = texts.find((e) => e.id === 'secondary')?.text || '';
  const pips = (payload?.elements || [])
    .filter((e) => e.id?.startsWith('pip-'))
    .map((p) => {
      const c = p.fill_colors?.[0] || '';
      if (c === '#FF2222FF') return 'E';
      if (c === '#FFAA00FF') return 'W';
      if (c === '#00FF55FF') return 'R';
      return 'D';
    })
    .join(' ');

  const blink = payload?.led_notification_color || 'off';
  return [
    `[BUSY BAR 72x16 | phase=${snapshot.phase} | priority=${payload.priority} | blink=${blink}]`,
    `| ${primary.padEnd(10)} ${secondary.padStart(16)} |`,
    `| pips: ${pips || '(none)'}`,
  ].join('\n');
}

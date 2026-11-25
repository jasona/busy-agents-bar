export const DISPLAY_WIDTH = 72;
export const DISPLAY_HEIGHT = 16;

const ACCENT_GRADIENTS = {
  error: ['#FF2222FF', '#FF0066FF'],
  waiting: ['#FFAA00FF', '#FF7700FF'],
  running: ['#00FF55FF', '#00D4FFFF'],
  all_done: ['#00FFAAFF', '#00AAFFFF'],
  cleared: ['#335566FF', '#223344FF'],
};

const PIP_COLORS = {
  error: '#FF2222FF',
  waiting: '#FFAA00FF',
  running: '#00FF55FF',
};

const PROVIDER_PALETTE = {
  antigravity: { tag: 'AGY', color: '#00D4FFFF', dimColor: '#004866FF' },
  'claude-code': { tag: 'CLD', color: '#FF7A45FF', dimColor: '#66301BFF' },
  claude: { tag: 'CLD', color: '#FF7A45FF', dimColor: '#66301BFF' },
  codex: { tag: 'CDX', color: '#C084FCFF', dimColor: '#4E2A66FF' },
  chatgpt: { tag: 'CDX', color: '#C084FCFF', dimColor: '#4E2A66FF' },
  phoenix: { tag: 'PHX', color: '#E85D26FF', dimColor: '#5C240EFF' },
  'phoenix-code': { tag: 'PHX', color: '#E85D26FF', dimColor: '#5C240EFF' },
  t3: { tag: 'PHX', color: '#E85D26FF', dimColor: '#5C240EFF' },
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

/**
 * Returns compact tag and signature colors for an agent provider.
 */
export function getProviderMeta(provider) {
  const key = String(provider || '').trim().toLowerCase();
  if (PROVIDER_PALETTE[key]) {
    return PROVIDER_PALETTE[key];
  }
  const clean = sanitizeAscii(key, 12, 'AGT').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const tag = (clean.slice(0, 3) || 'AGT').padEnd(1, 'A');
  return { tag, color: '#60A5FAFF', dimColor: '#223B5CFF' };
}

/**
 * Evaluates waiting urgency tier and color palette based on wait duration.
 */
export function getWaitingUrgency(snapshot, config, now = snapshot?.generatedAtMs || Date.now()) {
  const normal = {
    level: 'normal',
    accentColors: ['#FFAA00FF', '#FF7700FF'],
    primaryColor: '#FFAA00FF',
    secondaryColor: '#FFD066FF',
    pipColor: '#FFAA00FF',
  };

  const esc = config?.display?.urgencyEscalation;
  if (esc?.enabled === false) return normal;

  const waiting = (snapshot?.sessions || []).filter((s) => s.status === 'waiting');
  if (waiting.length === 0) return normal;

  const oldestMs = Math.min(...waiting.map((s) => s.updatedAtMs || now));
  const waitMs = Math.max(0, now - oldestMs);
  const elevatedAfterMs = Math.max(1000, Number(esc?.elevatedAfterMs ?? 120000));
  const criticalAfterMs = Math.max(elevatedAfterMs, Number(esc?.criticalAfterMs ?? 300000));

  if (waitMs >= criticalAfterMs) {
    return {
      level: 'critical',
      accentColors: ['#FF2200FF', '#FF0055FF'],
      primaryColor: '#FF3300FF',
      secondaryColor: '#FF7799FF',
      pipColor: '#FF3300FF',
    };
  }
  if (waitMs >= elevatedAfterMs) {
    return {
      level: 'elevated',
      accentColors: ['#FF6600FF', '#FF3300FF'],
      primaryColor: '#FF7700FF',
      secondaryColor: '#FFAA66FF',
      pipColor: '#FF7700FF',
    };
  }
  return normal;
}

function resolvePriority(snapshot, config) {
  const deviceCfg = config?.device || {};
  const phase = snapshot?.phase;
  const isUrgent = phase === 'error' || phase === 'waiting';
  const basePriority = Number(deviceCfg.priority ?? 50);
  const urgentPriority = Number(deviceCfg.urgentPriority ?? 95);
  return Math.max(
    1,
    Math.min(100, isUrgent && deviceCfg.urgentOverrideTimer ? urgentPriority : basePriority)
  );
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

function makeTinyTextRow({
  id,
  text,
  color,
  x,
  y = 0,
  maxWidth,
  rightAlign = false,
  scrollRate = 600,
  startDelay = 900,
  repeatDelay = 2200,
}) {
  const safe = sanitizeAscii(text, 48, '');
  if (!safe) return null;
  const approxWidth = safe.length * 4;
  if (approxWidth <= maxWidth) {
    return {
      id,
      type: 'text',
      display: 'front',
      timeout: 0,
      x: rightAlign ? 71 : x,
      y,
      align: rightAlign ? 'top_right' : 'top_left',
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
    x,
    y,
    align: 'top_left',
    text: safe,
    font: 'tiny',
    color,
    width: Math.max(8, maxWidth),
    scroll_rate: scrollRate,
    scroll_start_delay: startDelay,
    scroll_repeat_delay: repeatDelay,
  };
}

function makeCountdownElement({ baseMs, deviceClockOffsetMs, now, color }) {
  const tsMs = Number(baseMs);
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  const offset = Number.isFinite(Number(deviceClockOffsetMs)) ? Number(deviceClockOffsetMs) : 0;
  const deviceNowSec = Math.floor((now + offset) / 1000);
  const targetSec = Math.max(0, Math.min(deviceNowSec, Math.floor((tsMs + offset) / 1000)));
  return {
    id: 'timer',
    type: 'countdown',
    display: 'front',
    timeout: 0,
    x: 71,
    y: 1,
    align: 'top_right',
    timestamp: String(targetSec),
    direction: 'time_since',
    show_hours: 'when_non_zero',
    color,
  };
}

function resolveSessionPipColor(session, snapshotPhase, urgency) {
  if (session.status === 'done') {
    return snapshotPhase === 'all_done' ? '#00DDAAFF' : '#00AAFFFF';
  }
  if (session.status === 'waiting') {
    return urgency.pipColor;
  }
  return PIP_COLORS[session.status] || '#335566FF';
}

function buildFleetPips(snapshot, { config, urgency, highlightIndex = null } = {}) {
  const sessions = snapshot.sessions || [];
  const count = Math.min(sessions.length, 18);
  if (count === 0) return [];

  const useProviderColors = config?.display?.providerColors !== false;
  const gap = 1;
  const pipWidth = Math.max(2, Math.floor((DISPLAY_WIDTH - (count - 1) * gap) / count));
  const elements = [];

  for (let i = 0; i < count; i++) {
    const s = sessions[i];
    const x = i * (pipWidth + gap);
    if (x >= DISPLAY_WIDTH) break;
    const width = Math.min(pipWidth, DISPLAY_WIDTH - x);
    const statusColor = resolveSessionPipColor(s, snapshot.phase, urgency);
    const provMeta = getProviderMeta(s.provider);

    const isPagerMode = highlightIndex !== null;
    const isHighlighted = highlightIndex === i;

    if (isPagerMode && !isHighlighted) {
      elements.push({
        id: `pip-${i}`,
        type: 'rectangle',
        display: 'front',
        timeout: 0,
        x,
        y: 14,
        align: 'top_left',
        width,
        height: 2,
        radius: 0,
        fill: 'solid',
        fill_colors: [provMeta.dimColor],
        border_width: 0,
      });
      continue;
    }

    const useGradient = useProviderColors && width >= 4;
    const fillColors = useGradient
      ? s.status === 'done' && snapshot.phase === 'all_done'
        ? ['#00FFAAFF', '#00AAFFFF']
        : [statusColor, provMeta.color]
      : [statusColor];

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
      fill: useGradient ? 'gradient_h' : 'solid',
      fill_colors: fillColors,
      border_width: 0,
    });
  }

  return elements;
}

function makeStatusIcon(phase) {
  switch (phase) {
    case 'running':
      return {
        id: 'icon',
        type: 'animation',
        display: 'front',
        timeout: 0,
        x: 3,
        y: 1,
        stock_path: 'shared/spinner_front_8x8.anim',
        loop: true,
      };
    case 'error':
      return {
        id: 'icon',
        type: 'image',
        display: 'front',
        timeout: 0,
        x: 3,
        y: 1,
        stock_path: 'shared/error_front_8x8.image',
      };
    case 'waiting':
      return {
        id: 'icon',
        type: 'image',
        display: 'front',
        timeout: 0,
        x: 3,
        y: 3,
        stock_path: 'shared/hourglass_5x5.image',
      };
    case 'all_done':
      return {
        id: 'icon',
        type: 'image',
        display: 'front',
        timeout: 0,
        x: 3,
        y: 1,
        stock_path: 'shared/checkmark_front_8x8.image',
      };
    default:
      return null;
  }
}

function renderFleetMode(snapshot, opts) {
  const { config, urgency, deviceClockOffsetMs, now } = opts;
  const displayCfg = config?.display || {};
  const showProjectName = displayCfg.showProjectName !== false;
  const useAnimations = displayCfg.animations !== false;
  const useTimers = displayCfg.showTimers !== false;
  const { phase, counts } = snapshot;

  const accentColors =
    phase === 'waiting' ? urgency.accentColors : ACCENT_GRADIENTS[phase] || ACCENT_GRADIENTS.cleared;

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
      fill: 'gradient_v',
      fill_colors: accentColors,
      border_width: 0,
    },
  ];

  const iconEl = useAnimations ? makeStatusIcon(phase) : null;
  if (iconEl) elements.push(iconEl);
  const textX = iconEl ? 12 : 4;

  if (phase === 'error') {
    const hasSecondaryCount = counts.waiting > 0 || counts.running > 0;
    const errText = counts.error >= 10 && hasSecondaryCount ? `${counts.error}E` : `${counts.error} ERR`;
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: textX,
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
        color: urgency.primaryColor,
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
      const rightStartX = iconEl ? 40 : 38;
      const rightEl = makeTinyTextRow({
        id: 'secondary',
        text: info,
        color: '#FF8888FF',
        x: rightStartX,
        y: 3,
        maxWidth: DISPLAY_WIDTH - rightStartX,
        rightAlign: true,
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
      x: textX,
      y: 1,
      align: 'top_left',
      text: waitText,
      font: 'small',
      color: urgency.primaryColor,
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
      const timerEl = useTimers
        ? makeCountdownElement({
            baseMs: snapshot.primarySession?.updatedAtMs || snapshot.primarySession?.turnStartedAtMs,
            deviceClockOffsetMs,
            now,
            color: urgency.secondaryColor,
          })
        : null;
      if (timerEl) {
        elements.push(timerEl);
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
          const rightEl = makeTinyTextRow({
            id: 'secondary',
            text: info,
            color: urgency.secondaryColor,
            x: 41,
            y: 3,
            maxWidth: DISPLAY_WIDTH - 41,
            rightAlign: true,
          });
          if (rightEl) elements.push(rightEl);
        }
      }
    }
  } else if (phase === 'running') {
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: textX,
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
    } else {
      const timerEl = useTimers
        ? makeCountdownElement({
            baseMs: snapshot.primarySession?.turnStartedAtMs || snapshot.primarySession?.startedAtMs || snapshot.primarySession?.updatedAtMs,
            deviceClockOffsetMs,
            now,
            color: '#88FFAAFF',
          })
        : null;
      if (timerEl) {
        elements.push(timerEl);
      } else if (showProjectName && snapshot.primarySession?.project) {
        const rightStartX = iconEl ? 40 : 38;
        const rightEl = makeTinyTextRow({
          id: 'secondary',
          text: snapshot.primarySession.project,
          color: '#88CCAAFF',
          x: rightStartX,
          y: 3,
          maxWidth: DISPLAY_WIDTH - rightStartX,
          rightAlign: true,
        });
        if (rightEl) elements.push(rightEl);
      }
    }
  } else if (phase === 'all_done') {
    elements.push({
      id: 'primary',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: textX,
      y: 0,
      align: 'top_left',
      text: `${counts.done} DONE`,
      font: 'tiny',
      color: '#00FFAAFF',
    });

    const finished = snapshot.primarySession;
    if (finished) {
      const tag = getProviderMeta(finished.provider).tag;
      const provider = { PHX: 'Phoenix', CDX: 'Codex', CLD: 'Claude', AGY: 'Antigravity' }[tag] || tag;
      const task = finished.title !== finished.id
        ? finished.title
        : finished.project !== 'general' ? finished.project : '';
      const label = `${provider}${task ? `: ${task}` : ''}`;
      const completionEl = makeTinyTextRow({
        id: 'secondary',
        text: counts.done > 1 ? `Latest ${label}` : label,
        x: textX,
        y: 7,
        maxWidth: DISPLAY_WIDTH - textX,
        color: '#88FFEEFF',
      });
      if (completionEl) elements.push(completionEl);
    }
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

  elements.push(...buildFleetPips(snapshot, { config, urgency }));
  return elements;
}

function formatCompactElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return '<1m';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h`;
}

function renderSpotlightMode(snapshot, opts) {
  const { config, urgency, spotlightIndex = 0, now } = opts;
  const sessions = snapshot.sessions || [];
  if (sessions.length === 0) {
    return renderFleetMode(snapshot, opts);
  }

  const idx = ((Number(spotlightIndex) || 0) % sessions.length + sessions.length) % sessions.length;
  const session = sessions[idx];
  const provMeta = getProviderMeta(session.provider);
  const isPhoenix = ['phoenix', 'phoenix-code', 't3'].includes(String(session.provider || '').trim().toLowerCase());
  const statusColor = resolveSessionPipColor(session, snapshot.phase, urgency);

  const elements = [
    {
      id: 'accent',
      type: 'rectangle',
      display: 'front',
      timeout: 0,
      x: 0,
      y: 0,
      align: 'top_left',
      width: 2,
      height: 12,
      radius: 0,
      fill: 'gradient_v',
      fill_colors: [statusColor, provMeta.color],
      border_width: 0,
    },
    {
      id: 'provider',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 3,
      y: 0,
      align: 'top_left',
      text: isPhoenix ? 'Phoenix' : provMeta.tag,
      font: 'tiny',
      color: provMeta.color,
    },
  ];

  let badgeText = '';
  if (session.isSwarm) {
    badgeText = `SWM ${session.swarmWorkingCount}/${session.swarmTotalCount}`;
  } else if (session.status === 'waiting' || session.status === 'error') {
    badgeText = attentionTag(session.attentionKind) || session.status.toUpperCase();
  } else if (sessions.length > 1) {
    badgeText = `${idx + 1}/${sessions.length}`;
  } else {
    badgeText = formatCompactElapsed(now - (session.turnStartedAtMs || session.updatedAtMs || now));
  }

  badgeText = sanitizeAscii(badgeText, 10, '');
  if (badgeText) {
    elements.push({
      id: 'badge',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 71,
      y: 0,
      align: 'top_right',
      text: badgeText,
      font: 'tiny',
      color: session.status === 'error' ? '#FF8888FF' : session.status === 'waiting' ? urgency.secondaryColor : '#88FFCCFF',
    });
  }

  const projStartX = 18;
  // Reserve 5px/char + 5px gutter for wide tiny glyphs (e.g. 'SWM 2/4') so scrolling project never touches badge.
  const badgeReserve = badgeText ? badgeText.length * 5 + 5 : 0;
  const projMaxWidth = Math.max(12, DISPLAY_WIDTH - projStartX - badgeReserve);
  const projText =
    session.project && session.project !== 'general'
      ? session.project
      : session.title || session.id.slice(0, 10);

  const projEl = makeTinyTextRow({
    id: 'project',
    text: isPhoenix ? '' : projText,
    color: '#FFFFFFFF',
    x: projStartX,
    y: 0,
    maxWidth: projMaxWidth,
  });
  if (projEl) elements.push(projEl);

  const actColor =
    session.status === 'error'
      ? '#FF8888FF'
      : session.status === 'waiting'
        ? urgency.secondaryColor
        : session.status === 'done'
          ? '#00DDAAFF'
          : '#AADDFFFF';

  const actText = session.activity || session.title || session.status.toUpperCase();
  const actEl = makeTinyTextRow({
    id: 'activity',
    text: actText,
    color: actColor,
    x: 3,
    y: 7,
    maxWidth: DISPLAY_WIDTH - 3,
    scrollRate: 720,
    startDelay: 800,
    repeatDelay: 2000,
  });
  if (actEl) elements.push(actEl);

  elements.push(...buildFleetPips(snapshot, { config, urgency, highlightIndex: idx }));
  return elements;
}

function buildHealthSegments(counts, urgency) {
  const buckets = [
    { key: 'error', count: counts.error, colors: ['#FF2222FF', '#FF0066FF'] },
    { key: 'waiting', count: counts.waiting, colors: urgency.accentColors },
    { key: 'running', count: counts.running, colors: ['#00FF55FF', '#00D4FFFF'] },
    { key: 'done', count: counts.done, colors: ['#00AAFFFF', '#00FFAAFF'] },
  ].filter((b) => b.count > 0);

  if (buckets.length === 0) return [];
  const totalCount = buckets.reduce((acc, b) => acc + b.count, 0);
  const gaps = buckets.length - 1;
  const availWidth = DISPLAY_WIDTH - gaps;

  const widths = buckets.map((b) => Math.max(2, Math.floor((b.count / totalCount) * availWidth)));
  let used = widths.reduce((a, b) => a + b, 0);
  if (used !== availWidth) {
    let largestIdx = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[largestIdx]) largestIdx = i;
    }
    widths[largestIdx] = Math.max(2, widths[largestIdx] + (availWidth - used));
  }

  const elements = [];
  let curX = 0;
  for (let i = 0; i < buckets.length; i++) {
    const w = Math.min(widths[i], DISPLAY_WIDTH - curX);
    if (w < 1) break;
    elements.push({
      id: `bar-${i}`,
      type: 'rectangle',
      display: 'front',
      timeout: 0,
      x: curX,
      y: 8,
      align: 'top_left',
      width: w,
      height: 7,
      radius: 1,
      fill: 'gradient_h',
      fill_colors: buckets[i].colors,
      border_width: 0,
    });
    curX += w + 1;
  }
  return elements;
}

function renderPulseMode(snapshot, opts) {
  const { urgency, dailyStats, muted } = opts;
  const sessions = snapshot.sessions || [];
  const completedToday = Math.max(0, Number(dailyStats?.completed) || 0);
  const rightText = muted ? 'MUTE' : `${completedToday}D`;
  const rightColor = muted ? '#FF6666FF' : '#00FFAAFF';

  const elements = [
    {
      id: 'pulse_meta',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 71,
      y: 0,
      align: 'top_right',
      text: rightText,
      font: 'tiny',
      color: rightColor,
    },
  ];

  const rightBoundary = DISPLAY_WIDTH - rightText.length * 4 - 3;

  if (sessions.length === 0) {
    elements.push({
      id: 'prov-0',
      type: 'text',
      display: 'front',
      timeout: 0,
      x: 0,
      y: 0,
      align: 'top_left',
      text: completedToday > 0 ? `TODAY ${completedToday} DONE` : 'READY',
      font: 'tiny',
      color: '#00DDAAFF',
    });
    elements.push({
      id: 'bar-0',
      type: 'rectangle',
      display: 'front',
      timeout: 0,
      x: 0,
      y: 10,
      align: 'top_left',
      width: DISPLAY_WIDTH,
      height: 4,
      radius: 1,
      fill: 'gradient_h',
      fill_colors: completedToday > 0 ? ['#00AAFFFF', '#00FFAAFF'] : ['#223344FF', '#335566FF'],
      border_width: 0,
    });
    return elements;
  }

  const byTag = new Map();
  for (const s of sessions) {
    const meta = getProviderMeta(s.provider);
    const existing = byTag.get(meta.tag) || { tag: meta.tag, color: meta.color, count: 0 };
    existing.count++;
    byTag.set(meta.tag, existing);
  }

  let curX = 0;
  let provIdx = 0;
  for (const entry of byTag.values()) {
    const label = `${entry.tag}:${entry.count}`;
    const width = label.length * 4;
    if (curX + width > rightBoundary) break;
    elements.push({
      id: `prov-${provIdx++}`,
      type: 'text',
      display: 'front',
      timeout: 0,
      x: curX,
      y: 0,
      align: 'top_left',
      text: label,
      font: 'tiny',
      color: entry.color,
    });
    curX += width + 3;
  }

  elements.push(...buildHealthSegments(snapshot.counts, urgency));
  return elements;
}

/**
 * Renders a FleetSnapshot into a BUSY Bar `/api/display/draw` payload targeting the 72x16 front RGB screen.
 */
export function renderFrontDisplay(
  snapshot,
  {
    config,
    blinkColor = null,
    viewMode = 'fleet',
    spotlightIndex = 0,
    dailyStats = null,
    muted = false,
    deviceClockOffsetMs = 0,
    now = snapshot?.generatedAtMs || Date.now(),
  } = {}
) {
  const deviceCfg = config?.device || {};
  const priority = resolvePriority(snapshot, config);
  const urgency = getWaitingUrgency(snapshot, config, now);

  const opts = {
    config,
    urgency,
    spotlightIndex,
    dailyStats,
    muted,
    deviceClockOffsetMs,
    now,
  };

  let elements;
  if (viewMode === 'spotlight') {
    elements = renderSpotlightMode(snapshot, opts);
  } else if (viewMode === 'pulse') {
    elements = renderPulseMode(snapshot, opts);
  } else {
    elements = renderFleetMode(snapshot, opts);
  }

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
 * Renders a transient 72x16 feedback toast overlay (e.g., button mute or mode confirmation).
 */
export function renderToastOverlay(toast, { config, blinkColor = null } = {}) {
  const deviceCfg = config?.device || {};
  const color =
    typeof toast?.color === 'string' && /^#[a-fA-F0-9]{8}$/.test(toast.color)
      ? toast.color
      : '#00FFAAFF';
  const text = sanitizeAscii(toast?.text || 'OK', 16, 'OK');

  const payload = {
    application_name: String(deviceCfg.applicationName || 'agent-status'),
    priority: Math.max(1, Math.min(100, Number(deviceCfg.urgentPriority ?? 95))),
    elements: [
      {
        id: 'toast_box',
        type: 'rectangle',
        display: 'front',
        timeout: 0,
        x: 0,
        y: 0,
        align: 'top_left',
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        radius: 2,
        fill: 'none',
        border_width: 1,
        border_color: color,
      },
      {
        id: 'toast_text',
        type: 'text',
        display: 'front',
        timeout: 0,
        x: 36,
        y: 8,
        align: 'center',
        text,
        font: 'small',
        color: '#FFFFFFFF',
      },
    ],
  };

  if (typeof blinkColor === 'string' && /^#[a-fA-F0-9]{8}$/.test(blinkColor)) {
    payload.led_notification_color = blinkColor;
  }

  return payload;
}

/**
 * Formats a concise terminal preview of the rendered 72x16 layout for dry-run debugging.
 */
export function renderAsciiPreview(snapshot, payload, viewMode = 'fleet') {
  const els = payload?.elements || [];
  const blink = payload?.led_notification_color || 'off';
  const toast = els.find((e) => e.id === 'toast_text');
  if (toast) {
    return [
      `[BUSY BAR 72x16 | toast | priority=${payload.priority} | blink=${blink}]`,
      `| [ ${toast.text} ] |`,
    ].join('\n');
  }

  const activity = els.find((e) => e.id === 'activity');
  if (activity) {
    const prov = els.find((e) => e.id === 'provider')?.text || '';
    const proj = els.find((e) => e.id === 'project')?.text || '';
    const badge = els.find((e) => e.id === 'badge')?.text || '';
    return [
      `[BUSY BAR 72x16 | mode=spotlight | phase=${snapshot.phase} | priority=${payload.priority} | blink=${blink}]`,
      `| ${prov} ${proj.padEnd(10)} ${badge.padStart(8)} |`,
      `| ${activity.text} |`,
    ].join('\n');
  }

  const pulseMeta = els.find((e) => e.id === 'pulse_meta');
  if (pulseMeta) {
    const provs = els.filter((e) => e.id?.startsWith('prov-')).map((e) => e.text).join(' ');
    const bars = els.filter((e) => e.id?.startsWith('bar-')).map((b) => `${b.width}px`).join('+');
    return [
      `[BUSY BAR 72x16 | mode=pulse | phase=${snapshot.phase} | priority=${payload.priority} | blink=${blink}]`,
      `| ${provs.padEnd(18)} ${pulseMeta.text.padStart(6)} |`,
      `| bar: ${bars || '(none)'} |`,
    ].join('\n');
  }

  const primary = els.find((e) => e.id === 'primary')?.text || '';
  const secondary = els.find((e) => e.id === 'secondary')?.text || (els.some((e) => e.id === 'timer') ? '<live-timer>' : '');
  const icon = els.find((e) => e.id === 'icon');
  const iconTag = icon ? `(${icon.type === 'animation' ? '*' : '+'})` : '';
  const pips = els
    .filter((e) => e.id?.startsWith('pip-'))
    .map((p) => {
      const c = p.fill_colors?.[0] || '';
      if (c === '#FF2222FF') return 'E';
      if (c === '#FFAA00FF' || c === '#FF7700FF' || c === '#FF3300FF') return 'W';
      if (c === '#00FF55FF') return 'R';
      return 'D';
    })
    .join(' ');

  return [
    `[BUSY BAR 72x16 | mode=${viewMode} | phase=${snapshot.phase} | priority=${payload.priority} | blink=${blink}]`,
    `| ${iconTag} ${primary.padEnd(10)} ${secondary.padStart(16)} |`,
    `| pips: ${pips || '(none)'}`,
  ].join('\n');
}

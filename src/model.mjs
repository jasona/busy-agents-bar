import { createHash } from 'node:crypto';

export const STATUS_RANK = {
  error: 0,
  waiting: 1,
  running: 2,
  done: 3,
  idle: 4,
};

const VALID_STATUSES = new Set(Object.keys(STATUS_RANK));
const VALID_ATTENTION_KINDS = new Set(['approval', 'question', 'error', 'quota', 'stuck']);

function nonNegInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Normalizes a raw provider session record into the canonical AgentSession shape.
 */
export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Session must be a non-null object');
  }
  const id = String(raw.id ?? '').trim();
  if (!id) {
    throw new Error('Session must have a non-empty id');
  }
  const provider = String(raw.provider ?? 'unknown').trim() || 'unknown';
  const rawStatus = String(raw.status ?? 'idle').trim().toLowerCase();
  const status = VALID_STATUSES.has(rawStatus) ? rawStatus : 'idle';

  const rawAttention = raw.attentionKind == null ? null : String(raw.attentionKind).trim().toLowerCase();
  let attentionKind = rawAttention && VALID_ATTENTION_KINDS.has(rawAttention) ? rawAttention : null;
  if (status === 'error' && !attentionKind) attentionKind = 'error';
  if (status === 'waiting' && !attentionKind) attentionKind = 'question';
  if (status === 'running' || status === 'done' || status === 'idle') attentionKind = null;

  const updatedAtMs = nonNegInt(raw.updatedAtMs, 0);
  const startedAtMs = nonNegInt(raw.startedAtMs, updatedAtMs);
  const turnStartedAtMs = nonNegInt(raw.turnStartedAtMs, startedAtMs);
  const steps = nonNegInt(raw.steps, 0);
  const isSwarm = Boolean(raw.isSwarm);
  const swarmTotalCount = isSwarm ? Math.max(1, nonNegInt(raw.swarmTotalCount, 1)) : 0;
  const swarmWorkingCount = isSwarm ? nonNegInt(raw.swarmWorkingCount, 0) : 0;

  return {
    id,
    provider,
    project: String(raw.project ?? 'general').trim() || 'general',
    title: String(raw.title ?? id).trim() || id,
    status,
    attentionKind,
    activity: String(raw.activity ?? '').trim(),
    updatedAtMs,
    startedAtMs,
    turnStartedAtMs,
    steps,
    isSwarm,
    swarmWorkingCount,
    swarmTotalCount,
  };
}

/**
 * Reduces normalized sessions into a deterministic fleet snapshot for rendering and transition detection.
 */
export function buildFleetSnapshot(
  sessions,
  { clearedAtMs = 0, dismissed = {}, now = Date.now(), stayOnUntilCleared = true, doneHoldMs = 0 } = {}
) {
  const normalized = [];
  for (const s of sessions || []) {
    if (!s) continue;
    normalized.push(normalizeSession(s));
  }

  const errorSessions = [];
  const waitingSessions = [];
  const runningSessions = [];
  const candidateDoneSessions = [];

  for (const s of normalized) {
    const key = `${s.provider}:${s.id}`;
    const dismissedAt = Number(dismissed?.[key]) || 0;
    if (dismissedAt > 0 && s.updatedAtMs <= dismissedAt) {
      continue;
    }

    if (s.status === 'error') errorSessions.push(s);
    else if (s.status === 'waiting') waitingSessions.push(s);
    else if (s.status === 'running') runningSessions.push(s);
    else if (s.status === 'done' && s.updatedAtMs > clearedAtMs) {
      candidateDoneSessions.push(s);
    }
  }

  const hasActive =
    errorSessions.length > 0 || waitingSessions.length > 0 || runningSessions.length > 0;

  let doneSessions = candidateDoneSessions;
  if (!stayOnUntilCleared && !hasActive && candidateDoneSessions.length > 0) {
    const newestDoneMs = Math.max(...candidateDoneSessions.map((s) => s.updatedAtMs));
    if (doneHoldMs <= 0 || now - newestDoneMs > doneHoldMs) {
      doneSessions = [];
    }
  }

  const visibleSessions = [
    ...errorSessions,
    ...waitingSessions,
    ...runningSessions,
    ...doneSessions,
  ].sort((a, b) => {
    const rankDiff = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    return `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`);
  });

  const counts = {
    error: errorSessions.length,
    waiting: waitingSessions.length,
    running: runningSessions.length,
    done: doneSessions.length,
    total: visibleSessions.length,
  };

  let phase = 'cleared';
  if (counts.error > 0) phase = 'error';
  else if (counts.waiting > 0) phase = 'waiting';
  else if (counts.running > 0) phase = 'running';
  else if (counts.done > 0) phase = 'all_done';

  const primarySession = visibleSessions[0] || null;

  const trimAct = (s) => (s.activity || '').slice(0, 48);
  const fingerprintInput = {
    phase,
    counts,
    primary: primarySession
      ? {
          id: primarySession.id,
          provider: primarySession.provider,
          project: primarySession.project,
          status: primarySession.status,
          attentionKind: primarySession.attentionKind,
          activity: trimAct(primarySession),
          swarmWorkingCount: primarySession.swarmWorkingCount,
          swarmTotalCount: primarySession.swarmTotalCount,
        }
      : null,
    pips: visibleSessions.slice(0, 18).map((s) => [
      s.provider,
      s.id,
      s.status,
      s.attentionKind,
      trimAct(s),
      s.swarmWorkingCount,
      s.swarmTotalCount,
    ]),
  };

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(fingerprintInput))
    .digest('hex')
    .slice(0, 16);

  return {
    phase,
    counts,
    sessions: visibleSessions,
    primarySession,
    clearedAtMs,
    generatedAtMs: now,
    fingerprint,
  };
}

/**
 * Computes edge-triggered alert transitions between two fleet snapshots.
 * Returns [] when prevSnapshot is null so daemon startup never triggers spurious chimes.
 */
export function detectTransitions(prevSnapshot, nextSnapshot) {
  if (!prevSnapshot || !nextSnapshot) return [];

  const transitions = [];
  const prevByKey = new Map(
    (prevSnapshot.sessions || []).map((s) => [`${s.provider}:${s.id}`, s])
  );

  const newErrorIds = [];
  const newWaitingIds = [];

  for (const s of nextSnapshot.sessions || []) {
    const key = `${s.provider}:${s.id}`;
    const prev = prevByKey.get(key);
    if (s.status === 'error' && (!prev || prev.status !== 'error')) {
      newErrorIds.push(key);
    } else if (
      s.status === 'waiting' &&
      (!prev || prev.status !== 'waiting' || prev.attentionKind !== s.attentionKind)
    ) {
      newWaitingIds.push(key);
    }
  }

  if (newErrorIds.length > 0) {
    transitions.push({ kind: 'error', sessionIds: newErrorIds });
  }
  if (newWaitingIds.length > 0) {
    transitions.push({ kind: 'waiting', sessionIds: newWaitingIds });
  }

  const wasActive =
    prevSnapshot.phase === 'running' ||
    prevSnapshot.phase === 'waiting' ||
    prevSnapshot.phase === 'error';
  if (wasActive && nextSnapshot.phase === 'all_done') {
    transitions.push({ kind: 'all_done', count: nextSnapshot.counts.done });
  }

  return transitions;
}

/**
 * Counts sessions that transitioned into `'done'` since `prevSnapshot` (returns 0 on startup).
 */
export function countNewCompletions(prevSnapshot, nextSnapshot) {
  if (!prevSnapshot || !nextSnapshot) return 0;
  const prevByKey = new Map(
    (prevSnapshot.sessions || []).map((s) => [`${s.provider}:${s.id}`, s])
  );
  let newlyDone = 0;
  for (const s of nextSnapshot.sessions || []) {
    if (s.status !== 'done') continue;
    const prev = prevByKey.get(`${s.provider}:${s.id}`);
    if (!prev || prev.status !== 'done') {
      newlyDone++;
    }
  }
  return newlyDone;
}

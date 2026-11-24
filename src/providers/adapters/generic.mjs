import { basename } from 'node:path';
import { normalizeSession } from '../../model.mjs';

export function assertHookObject(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Hook payload must be a JSON object');
  }
}

export function deriveProject(payload) {
  const explicit = String(payload?.project ?? '').trim();
  if (explicit) return explicit;
  const cwd = String(payload?.cwd ?? '').trim();
  if (cwd) {
    const base = basename(cwd.replace(/[/\\]+$/, ''));
    if (base) return base;
  }
  return 'general';
}

/**
 * Built-in generic webhook adapter transforming standard hook payloads into AgentSession fields.
 */
export function genericHookAdapter(providerName, payload, now = Date.now()) {
  assertHookObject(payload);
  const sessionId = String(payload.sessionId ?? payload.session_id ?? payload.id ?? '').trim();
  if (!sessionId) {
    throw new Error('Hook payload requires sessionId');
  }
  const status = String(payload.status ?? 'running').trim().toLowerCase();
  const attentionKind = payload.attentionKind ?? payload.attention_kind ?? null;
  const updatedAtMs = Number.isFinite(Number(payload.updatedAtMs))
    ? Number(payload.updatedAtMs)
    : now;
  const startedAtMs = Number.isFinite(Number(payload.startedAtMs))
    ? Number(payload.startedAtMs)
    : updatedAtMs;
  const ttlMs = payload.ttlMs === undefined || payload.ttlMs === null
    ? undefined
    : Math.max(1000, Number(payload.ttlMs) || 0);

  return {
    session: normalizeSession({
      id: sessionId,
      provider: String(payload.provider || providerName || 'hooks').trim() || 'hooks',
      project: deriveProject(payload),
      title: payload.title ?? sessionId,
      status,
      attentionKind,
      activity: payload.activity ?? '',
      updatedAtMs,
      startedAtMs,
      isSwarm: Boolean(payload.isSwarm),
      swarmWorkingCount: payload.swarmWorkingCount ?? 0,
      swarmTotalCount: payload.swarmTotalCount ?? 0,
    }),
    ttlMs,
  };
}

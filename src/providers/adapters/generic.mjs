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

function collapseOneLine(text, maxLen = 36) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1).trimEnd()}...` : clean;
}

function parseToolInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // Ignore unparseable JSON tool_input strings.
      }
    }
  }
  return null;
}

/**
 * Formats a concise front-display activity string from a hook tool_name and optional tool_input.
 */
export function describeHookToolActivity(toolName, toolInput, { approval = false } = {}) {
  const tool = String(toolName ?? '').trim();
  const input = parseToolInput(toolInput);

  if (input) {
    const fileVal = input.file_path ?? input.path ?? input.target_file ?? input.AbsolutePath;
    if (typeof fileVal === 'string' && fileVal.trim()) {
      const fileName = basename(fileVal.trim().replace(/[/\\]+$/, '')) || fileVal.trim();
      return approval ? `Approve ${tool || 'file'} ${fileName}` : `${tool || 'Edit'} ${fileName}`;
    }

    const cmdVal = input.command ?? input.cmd;
    if (typeof cmdVal === 'string' && cmdVal.trim()) {
      const cmd = collapseOneLine(cmdVal, approval ? 28 : 36);
      return approval ? `Approve ${tool || 'Run'}: ${cmd}` : `Run ${cmd}`;
    }

    const queryVal = input.pattern ?? input.query;
    if (typeof queryVal === 'string' && queryVal.trim()) {
      const q = collapseOneLine(queryVal, approval ? 24 : 32);
      return approval ? `Approve ${tool || 'Search'}: ${q}` : `Search ${q}`;
    }
  }

  if (approval) {
    return tool ? `Approve ${tool}` : 'Approval required';
  }
  return tool ? `Tool: ${tool}` : 'Working';
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
      turnStartedAtMs: Number.isFinite(Number(payload.turnStartedAtMs))
        ? Number(payload.turnStartedAtMs)
        : startedAtMs,
      steps: payload.steps ?? 0,
      isSwarm: Boolean(payload.isSwarm),
      swarmWorkingCount: payload.swarmWorkingCount ?? 0,
      swarmTotalCount: payload.swarmTotalCount ?? 0,
    }),
    ttlMs,
  };
}

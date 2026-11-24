import { assertHookObject, deriveProject, genericHookAdapter } from './generic.mjs';

const CANONICAL_PROVIDER = 'codex';

/**
 * Translates OpenAI Codex / ChatGPT lifecycle hook and notify payloads into canonical AgentSession updates.
 */
export function codexHookAdapter(providerName, payload, now = Date.now()) {
  assertHookObject(payload);

  const event = String(
    payload.hook_event_name ?? payload.type ?? payload.event ?? ''
  ).trim();
  if (!event && payload.status !== undefined) {
    return genericHookAdapter(CANONICAL_PROVIDER, { ...payload, provider: CANONICAL_PROVIDER }, now);
  }

  const sessionId = String(
    payload.session_id ??
      payload.thread_id ??
      payload['thread-id'] ??
      payload.sessionId ??
      payload.id ??
      ''
  ).trim();
  if (!sessionId) {
    throw new Error('Codex hook payload requires session_id or thread_id');
  }

  const project = deriveProject(payload);
  const toolName = String(payload.tool_name ?? '').trim();

  switch (event) {
    case 'SessionStart':
      return { ignore: true };

    case 'SessionEnd':
    case 'Interrupt':
      return { remove: true, sessionId, provider: CANONICAL_PROVIDER };

    case 'UserPromptSubmit':
    case 'PreModelRequest':
    case 'PostModelRequest':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Codex (${project})`,
          status: 'running',
          attentionKind: null,
          activity: 'Thinking',
          updatedAtMs: now,
        },
      };

    case 'PreToolUse':
    case 'PostToolUse':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Codex (${project})`,
          status: 'running',
          attentionKind: null,
          activity: toolName ? `Tool: ${toolName}` : 'Working',
          updatedAtMs: now,
        },
      };

    case 'PermissionRequest':
    case 'approval-requested':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Codex (${project})`,
          status: 'waiting',
          attentionKind: 'approval',
          activity: toolName ? `Approve ${toolName}` : 'Approval required',
          updatedAtMs: now,
        },
      };

    case 'Stop':
    case 'agent-turn-complete':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Codex (${project})`,
          status: 'done',
          attentionKind: null,
          activity: 'Done',
          updatedAtMs: now,
        },
      };

    default:
      return { ignore: true };
  }
}

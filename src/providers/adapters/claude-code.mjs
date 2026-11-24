import { assertHookObject, deriveProject, describeHookToolActivity, genericHookAdapter } from './generic.mjs';

const CANONICAL_PROVIDER = 'claude-code';

/**
 * Translates Claude Code lifecycle hook JSON payloads into canonical AgentSession updates.
 */
export function claudeCodeHookAdapter(providerName, payload, now = Date.now()) {
  assertHookObject(payload);

  const event = String(payload.hook_event_name ?? payload.event ?? '').trim();
  if (!event && payload.status !== undefined) {
    return genericHookAdapter(CANONICAL_PROVIDER, { ...payload, provider: CANONICAL_PROVIDER }, now);
  }

  const sessionId = String(payload.session_id ?? payload.sessionId ?? payload.id ?? '').trim();
  if (!sessionId) {
    throw new Error('Claude Code hook payload requires session_id');
  }

  const project = deriveProject(payload);
  const toolName = String(payload.tool_name ?? '').trim();

  switch (event) {
    case 'SessionStart':
      return { ignore: true };

    case 'SessionEnd':
      return { remove: true, sessionId, provider: CANONICAL_PROVIDER };

    case 'UserPromptSubmit':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Claude (${project})`,
          status: 'running',
          attentionKind: null,
          activity: 'Prompt submitted',
          updatedAtMs: now,
        },
      };

    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Claude (${project})`,
          status: 'running',
          attentionKind: null,
          activity: describeHookToolActivity(toolName, payload.tool_input),
          updatedAtMs: now,
        },
      };

    case 'PermissionRequest':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Claude (${project})`,
          status: 'waiting',
          attentionKind: 'approval',
          activity: describeHookToolActivity(toolName, payload.tool_input, { approval: true }),
          updatedAtMs: now,
        },
      };

    case 'Notification': {
      const ntype = String(payload.notification_type ?? '').trim().toLowerCase();
      const msg = String(payload.message ?? '').trim();

      if (ntype === 'permission_prompt') {
        return {
          session: {
            id: sessionId,
            provider: CANONICAL_PROVIDER,
            project,
            title: `Claude (${project})`,
            status: 'waiting',
            attentionKind: 'approval',
            activity: msg || 'Permission prompt',
            updatedAtMs: now,
          },
        };
      }
      if (ntype === 'elicitation_dialog' || ntype === 'agent_needs_input') {
        return {
          session: {
            id: sessionId,
            provider: CANONICAL_PROVIDER,
            project,
            title: `Claude (${project})`,
            status: 'waiting',
            attentionKind: 'question',
            activity: msg || 'Input needed',
            updatedAtMs: now,
          },
        };
      }
      if (ntype.includes('error') || ntype.includes('failure')) {
        return {
          session: {
            id: sessionId,
            provider: CANONICAL_PROVIDER,
            project,
            title: `Claude (${project})`,
            status: 'error',
            attentionKind: 'error',
            activity: msg || ntype,
            updatedAtMs: now,
          },
        };
      }
      // Ignore idle_prompt / auth_success so post-turn idle pings do not resurrect cleared sessions.
      return { ignore: true };
    }

    case 'Stop':
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title: `Claude (${project})`,
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

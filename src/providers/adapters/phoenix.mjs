import { assertHookObject, deriveProject, describeHookToolActivity, genericHookAdapter } from './generic.mjs';
import { QUOTA_RE } from '../antigravity/transcript.mjs';

const CANONICAL_PROVIDER = 'phoenix';

const REMOVE_EVENTS = new Set([
  'sessionend',
  'threadarchived',
  'threaddeleted',
  'interrupt',
  'interrupted',
  'cancelled',
  'rolled_back',
]);

const DONE_TOKENS = new Set(['completed', 'done', 'stop', 'turncompleted']);
const FAILED_TOKENS = new Set(['failed', 'limited', 'error', 'turnfailed', 'runerror']);
const APPROVAL_TOKENS = new Set([
  'approval',
  'approval_request',
  'permissionrequest',
  'permission_prompt',
  'command_execution',
  'file_change',
  'dynamic_tool_call',
  'auth_refresh',
]);
const QUESTION_TOKENS = new Set(['input', 'user_input', 'user_input_request', 'question', 'ask_question']);
const ACTIVE_TOKENS = new Set([
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'working',
  'userpromptsubmit',
  'pretooluse',
  'posttooluse',
  'runstart',
  'runstarted',
]);

/**
 * Translates Phoenix lifecycle webhook / CLI hook JSON payloads into canonical AgentSession updates.
 */
export function phoenixHookAdapter(providerName, payload, now = Date.now()) {
  assertHookObject(payload);

  const event = String(payload.event ?? payload.hook_event_name ?? payload.type ?? '').trim();
  const hasPhoenixFields =
    payload.threadId !== undefined ||
    payload.thread_id !== undefined ||
    payload.runStatus !== undefined ||
    payload.requestKind !== undefined ||
    payload.kind !== undefined ||
    payload.errorClass !== undefined;

  if (!event && payload.status !== undefined && !hasPhoenixFields) {
    return genericHookAdapter(CANONICAL_PROVIDER, { ...payload, provider: CANONICAL_PROVIDER }, now);
  }

  const sessionId = String(
    payload.threadId ??
      payload.thread_id ??
      payload.sessionId ??
      payload.session_id ??
      payload.id ??
      ''
  ).trim();
  if (!sessionId) {
    throw new Error('Phoenix hook payload requires threadId or sessionId');
  }

  const project = deriveProject(payload);
  const rawTitle = String(payload.title ?? '').trim();
  const title = rawTitle || `Phoenix (${project})`;
  const toolName = String(payload.toolName ?? payload.tool_name ?? '').trim();
  const toolInput = payload.tool_input ?? payload.input;
  const reqKind = String(payload.requestKind ?? payload.kind ?? '').trim().toLowerCase();
  const notifType = String(payload.notification_type ?? payload.notificationType ?? '').trim().toLowerCase();
  const runStatus = String(payload.runStatus ?? payload.status ?? '').trim().toLowerCase();
  const evLower = event.toLowerCase();
  const msg = String(payload.activity ?? payload.message ?? payload.prompt ?? '').trim();
  const explicitTurnStart = Number(payload.turnStartedAtMs ?? payload.startedAtMs);
  const turnStartProps =
    Number.isFinite(explicitTurnStart) && explicitTurnStart > 0
      ? { turnStartedAtMs: explicitTurnStart }
      : {};

  if (REMOVE_EVENTS.has(evLower) || REMOVE_EVENTS.has(runStatus)) {
    return { remove: true, sessionId, provider: CANONICAL_PROVIDER };
  }

  const token = evLower || runStatus || reqKind;

  if (evLower === 'notification') {
    if (notifType === 'permission_prompt' || APPROVAL_TOKENS.has(reqKind)) {
      const act =
        (msg && msg.toLowerCase() !== 'approval required' ? msg : '') ||
        (toolName || toolInput !== undefined
          ? describeHookToolActivity(toolName, toolInput, { approval: true })
          : msg || 'Approval required');
      return {
        session: {
          id: sessionId,
          provider: CANONICAL_PROVIDER,
          project,
          title,
          status: 'waiting',
          attentionKind: 'approval',
          activity: act,
          ...turnStartProps,
          updatedAtMs: now,
        },
      };
    }
    return {
      session: {
        id: sessionId,
        provider: CANONICAL_PROVIDER,
        project,
        title,
        status: 'waiting',
        attentionKind: 'question',
        activity: msg || (notifType === 'user_input' ? 'Input needed' : 'Attention needed'),
        ...turnStartProps,
        updatedAtMs: now,
      },
    };
  }

  const isHookLifecycleActiveOrTerminal =
    ACTIVE_TOKENS.has(token) || DONE_TOKENS.has(token) || FAILED_TOKENS.has(token);

  if (APPROVAL_TOKENS.has(token) || (!isHookLifecycleActiveOrTerminal && APPROVAL_TOKENS.has(reqKind))) {
    const act =
      (msg && msg.toLowerCase() !== 'approval required' ? msg : '') ||
      (toolName || toolInput !== undefined
        ? describeHookToolActivity(toolName, toolInput, { approval: true })
        : msg || 'Approval required');
    return {
      session: {
        id: sessionId,
        provider: CANONICAL_PROVIDER,
        project,
        title,
        status: 'waiting',
        attentionKind: 'approval',
        activity: act,
        ...turnStartProps,
        updatedAtMs: now,
      },
    };
  }

  if (QUESTION_TOKENS.has(token) || (!isHookLifecycleActiveOrTerminal && QUESTION_TOKENS.has(reqKind))) {
    return {
      session: {
        id: sessionId,
        provider: CANONICAL_PROVIDER,
        project,
        title,
        status: 'waiting',
        attentionKind: 'question',
        activity: msg || 'Input needed',
        ...turnStartProps,
        updatedAtMs: now,
      },
    };
  }

  if (FAILED_TOKENS.has(token) || FAILED_TOKENS.has(runStatus)) {
    const errClass = String(payload.errorClass ?? payload.lastErrorClass ?? '').trim().toLowerCase();
    const errMsg = msg || 'Run failed';
    const isQuota = token === 'limited' || errClass === 'usage_limit' || QUOTA_RE.test(errMsg);
    return {
      session: {
        id: sessionId,
        provider: CANONICAL_PROVIDER,
        project,
        title,
        status: 'error',
        attentionKind: isQuota ? 'quota' : 'error',
        activity: errMsg,
        ...turnStartProps,
        updatedAtMs: now,
      },
    };
  }

  if (DONE_TOKENS.has(token) || DONE_TOKENS.has(runStatus)) {
    return {
      session: {
        id: sessionId,
        provider: CANONICAL_PROVIDER,
        project,
        title,
        status: 'done',
        attentionKind: null,
        activity: msg || 'Done',
        updatedAtMs: now,
      },
    };
  }

  if (ACTIVE_TOKENS.has(token) || ACTIVE_TOKENS.has(runStatus)) {
    const act =
      msg ||
      (toolName || toolInput !== undefined
        ? describeHookToolActivity(toolName, toolInput)
        : 'Working');
    return {
      session: {
        id: sessionId,
        provider: CANONICAL_PROVIDER,
        project,
        title,
        status: 'running',
        attentionKind: null,
        activity: act,
        ...turnStartProps,
        updatedAtMs: now,
      },
    };
  }

  return { ignore: true };
}

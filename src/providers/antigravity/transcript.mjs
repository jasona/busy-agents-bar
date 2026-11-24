import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { ID_RE, statOf } from './discovery.mjs';

export const STEP_ERROR_SETTLE_MS = 60 * 1000;
export const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;

const BOARD_ACTIVITY = {
  swarm_wait: 'Waiting for posts',
  read_board: 'Reading the board',
  post_message: 'Posting to the board',
};

const transcriptCache = new Map();
const NO_TRANSCRIPT = { key: '-', summary: null };

export function transcriptPathOf(appData, convId) {
  return join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

export function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseMaybeJson(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[' && s[0] !== '"')) return null;
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string') return parseMaybeJson(parsed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function oneLine(s, maxLen = 96) {
  const out = String(s || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}...` : out;
}

export function describeToolCall(tc) {
  const name = tc?.name || '';
  if (!name) return '';
  if (BOARD_ACTIVITY[name]) return BOARD_ACTIVITY[name];
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = unquote(args.toolSummary) || unquote(args.toolAction);
  if (summary) return oneLine(summary);
  const filePath = unquote(args.Path || args.AbsolutePath || args.TargetFile || args.path);
  if (filePath) {
    const verb = {
      read_file: 'Read',
      view_file: 'Read',
      write_file: 'Write',
      write_to_file: 'Write',
      edit_file: 'Edit',
      replace_file_content: 'Edit',
      multi_replace_file_content: 'Edit',
    }[name];
    if (verb) return `${verb} ${basename(filePath)}`;
  }
  if (name === 'run_command' && args.CommandLine) {
    return oneLine(`Run ${unquote(args.CommandLine)}`, 64);
  }
  if ((name === 'code_search' || name === 'grep_search') && args.Query) {
    return oneLine(`Search ${unquote(args.Query)}`);
  }
  if (name === 'ask_question') return 'Waiting for user answer';
  if (name === 'swarm' && args.action) return oneLine(`swarm ${unquote(args.action)} ${unquote(args.name)}`);
  return name;
}

export function thinkingHeading(thinking) {
  if (typeof thinking !== 'string') return '';
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)];
  return hs.length ? oneLine(hs[hs.length - 1][1]) : '';
}

function parseStep(item) {
  if (!item) return null;
  if (typeof item === 'object') return item;
  if (typeof item !== 'string' || !item.trim()) return null;
  try {
    const obj = JSON.parse(item);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Determines whether the newest parsed transcript steps represent a completed turn.
 */
export function turnEnded(steps) {
  const results = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) return false;
    if (step.type === 'GENERIC') {
      results.unshift(step);
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE') return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const wait = calls.findIndex((c) => c?.name === 'swarm_wait');
    return wait >= 0 && results.length >= calls.length && results[wait].status === 'DONE';
  }
  return false;
}

/**
 * Evaluates whether a transcript summary stopped on a model or settled tool error.
 */
export function stepFailure(tr, now = Date.now()) {
  const last = tr?.last;
  if (!last) return null;
  const modelError = last.type === 'ERROR_MESSAGE';
  const settledToolError =
    last.status === 'ERROR' && now - (tr.mtime || 0) >= STEP_ERROR_SETTLE_MS;
  if (!modelError && !settledToolError) return null;
  const text = last.error || (modelError ? 'model error' : 'step failed');
  return { kind: QUOTA_RE.test(text) ? 'quota' : 'error', text };
}

function extractAskQuestionText(tc) {
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const direct = unquote(args.question || args.Prompt || args.prompt);
  if (direct) return oneLine(direct, 160);
  const qs = parseMaybeJson(args.questions);
  if (Array.isArray(qs) && qs.length > 0) {
    const qTexts = qs
      .map((item) => (typeof item === 'string' ? item : item?.question))
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => oneLine(s, 140));
    if (qTexts.length > 0) {
      return qTexts.length === 1 ? qTexts[0] : oneLine(qTexts.join(' / '), 160);
    }
  }
  return '';
}

function extractPendingPromptState(steps) {
  let askQuestion = '';
  let pendingApproval = '';

  const trailingResults = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'GENERIC') {
      trailingResults.unshift(step);
      continue;
    }
    if (step.type === 'USER_INPUT') break;
    if (step.type !== 'PLANNER_RESPONSE') break;

    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (let c = 0; c < calls.length; c++) {
      const tc = calls[c];
      const res = trailingResults[c];
      const waiting =
        !res || res.status === 'RUNNING' || res.status === 'WAITING' || res.status === 'PENDING';
      if (tc?.name === 'ask_question' && waiting) {
        askQuestion = extractAskQuestionText(tc) || 'Waiting for your answer';
      }
      if (
        (step.status === 'WAITING' || res?.status === 'WAITING' || res?.status === 'PENDING') &&
        tc?.name !== 'ask_question'
      ) {
        pendingApproval = describeToolCall(tc) || `Approval required: ${tc?.name || 'tool'}`;
      }
    }
    break;
  }

  return { askQuestion, pendingApproval };
}

function extractReferencedPaths(steps) {
  const paths = new Set();
  for (const step of steps) {
    if (step.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (const tc of calls) {
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        for (const key of ['Path', 'AbsolutePath', 'TargetFile', 'SearchDirectory', 'Cwd', 'path']) {
          const val = unquote(args[key]);
          if (val && isAbsolute(val)) paths.add(val);
        }
        const cmd = unquote(args.CommandLine);
        if (cmd) {
          for (const m of cmd.matchAll(/(?:^|[\s"'=])(\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)/g)) {
            paths.add(m[1]);
          }
        }
      }
    }
    if (step.type === 'SYSTEM_MESSAGE' || step.type === 'USER_INPUT') {
      const text = String(step.content || '');
      for (const m of text.matchAll(/(?:^|\s|file:\/\/)(\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)/gm)) {
        paths.add(m[1]);
      }
    }
  }
  return [...paths];
}

function extractFirstUserTitle(steps) {
  for (const step of steps) {
    if (step.type !== 'USER_INPUT') continue;
    const text = String(step.content || '')
      .replace(/<\/?USER_REQUEST>/gi, '')
      .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
      .trim();
    if (!text) continue;
    const firstLine = text.split('\n').find((l) => l.trim()) || '';
    if (firstLine) return oneLine(firstLine, 72);
  }
  return '';
}

/**
 * Parses and caches a conversation's transcript.jsonl summary by mtime:size.
 */
export function summarizeTranscript(appDataOrPath, convId) {
  let filePath;
  if (convId !== undefined) {
    if (!appDataOrPath || !convId || !ID_RE.test(convId)) return NO_TRANSCRIPT;
    filePath = transcriptPathOf(appDataOrPath, convId);
  } else {
    if (!appDataOrPath || typeof appDataOrPath !== 'string') return NO_TRANSCRIPT;
    filePath = appDataOrPath;
  }

  const s = statOf(filePath);
  if (s.size < 0 || !s.isFile) return NO_TRANSCRIPT;
  const key = `${s.mtime}:${s.size}`;
  const hit = transcriptCache.get(filePath);
  if (hit && hit.key === key) return hit;

  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return NO_TRANSCRIPT;
  }

  const lines = text.split('\n').filter((l) => l.trim());
  const steps = [];
  for (const line of lines) {
    const parsed = parseStep(line);
    if (parsed) steps.push(parsed);
  }

  let totalSteps = steps.length;
  let activity = '';
  let last = null;
  let updatedAtMs = s.mtime;
  let startedAtMs = 0;
  let turnStartedAtMs = 0;
  let firstStepInTurnAtMs = 0;

  for (const step of steps) {
    if (step.created_at) {
      const ms = Date.parse(String(step.created_at));
      if (Number.isFinite(ms)) {
        startedAtMs = ms;
        break;
      }
    }
  }

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const stepMs = step.created_at ? Date.parse(String(step.created_at)) : NaN;
    if (i === steps.length - 1 && Number.isFinite(step.step_index)) {
      totalSteps = Math.max(totalSteps, step.step_index + 1);
    }
    if (i === steps.length - 1 && Number.isFinite(stepMs)) {
      updatedAtMs = Math.max(updatedAtMs, stepMs);
    }
    if (!last) {
      last = {
        type: String(step.type || ''),
        status: String(step.status || ''),
        error: typeof step.error === 'string' ? oneLine(step.error, 240) : '',
      };
    }
    if (step.type === 'USER_INPUT') {
      if (Number.isFinite(stepMs)) turnStartedAtMs = stepMs;
      break;
    }
    if (Number.isFinite(stepMs)) {
      firstStepInTurnAtMs = stepMs;
    }
    if (step.type !== 'PLANNER_RESPONSE') continue;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.some((tc) => tc?.name === 'swarm_wait')) break;
    const labeled = calls.filter((tc) => describeToolCall(tc)).pop();
    const label = labeled ? describeToolCall(labeled) : '';
    const heading = thinkingHeading(step.thinking);
    if (label && !activity) {
      activity = label;
    } else if (heading && !activity) {
      activity = heading;
    }
  }

  if (!turnStartedAtMs) {
    turnStartedAtMs = firstStepInTurnAtMs || startedAtMs || updatedAtMs;
  }

  const idle = turnEnded(steps);
  const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
  const lastCalls = Array.isArray(lastStep?.tool_calls) ? lastStep.tool_calls : [];
  const replied = Boolean(lastStep?.type === 'PLANNER_RESPONSE' && lastCalls.length === 0);
  const { askQuestion, pendingApproval } = extractPendingPromptState(steps);
  const referencedPaths = extractReferencedPaths(steps);
  const firstUserPrompt = extractFirstUserTitle(steps);

  const summary = {
    steps: totalSteps,
    activity,
    last,
    idle,
    replied,
    askQuestion,
    pendingApproval,
    referencedPaths,
    firstUserPrompt,
    mtime: s.mtime,
    updatedAtMs,
    startedAtMs: startedAtMs || updatedAtMs,
    turnStartedAtMs,
  };

  const entry = { key, summary };
  if (transcriptCache.size > 500) transcriptCache.clear();
  transcriptCache.set(filePath, entry);
  return entry;
}

export function clearTranscriptCache() {
  transcriptCache.clear();
}

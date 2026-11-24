import { join } from 'node:path';
import { ID_RE, readCached } from './discovery.mjs';
import { oneLine, stepFailure, summarizeTranscript } from './transcript.mjs';

export const VIEW_MAX_BYTES = 64 * 1024;
const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/;
const viewJsonCache = new Map();

export function swarmDirOf(appData, convId) {
  return join(appData, 'brain', convId, '.system_generated', 'swarm');
}

function roleOf(name, m) {
  const r = typeof m?.role === 'string' ? m.role : '';
  if (r && r !== 'worker') return r;
  const match = /^(narrator|monitor)(?:-\d+)?$/.exec(String(name ?? ''));
  return match ? match[1] : r;
}

function isRoleWorker(name, m) {
  const r = roleOf(name, m);
  return Boolean((r && r !== 'worker' && r !== 'coordinator') || ROLE_WORKER_RE.test(String(name ?? '')));
}

function parseRoster(text) {
  if (!text) return null;
  try {
    const r = JSON.parse(text);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    return {
      title: typeof r.title === 'string' ? r.title : '',
      members: r.members && typeof r.members === 'object' && !Array.isArray(r.members) ? r.members : {},
    };
  } catch {
    return null;
  }
}

function parseBoard(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === 'object') out.push(m);
    } catch {
      // Tolerate torn final line while board.jsonl is being appended.
    }
  }
  return out;
}

function parseViewJson(id, dir) {
  const f = readCached(join(dir, 'view.json'), VIEW_MAX_BYTES);
  if (f.size < 0) {
    viewJsonCache.delete(id);
    return { json: null, mtime: 0 };
  }
  const key = `${f.mtime}:${f.size}`;
  let c = viewJsonCache.get(id);
  if (!c || c.key !== key) {
    let parsed = null;
    if (!f.tooLarge) {
      try {
        const v = JSON.parse(f.text ?? '');
        if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v;
      } catch {
        parsed = null;
      }
    }
    c = { key, good: parsed ? { json: parsed, mtime: f.mtime } : c?.good || null };
    viewJsonCache.set(id, c);
  }
  return { json: c.good?.json || null, mtime: c.good?.mtime || 0 };
}

function rawStatusOf(m, tr) {
  if (m.killed) return 'killed';
  if (typeof tr?.idle === 'boolean') return tr.idle ? 'waiting' : 'working';
  if (m.wake_mode === 'mentions' || m.wake_mode === 'anything') return 'waiting';
  return 'working';
}

function isReadyMember(rawStatus, tr, lastPostText = '') {
  if (rawStatus !== 'waiting') return false;
  return /\[done\]|\bready\b/i.test(lastPostText) || Boolean(tr?.replied);
}

/**
 * Reads swarm roster, board, and view.json state for a coordinator conversation.
 */
export function readSwarm(appData, convId, now = Date.now(), { stuckAfterMs = 600000 } = {}) {
  if (!appData || !convId || !ID_RE.test(convId)) return null;
  const dir = swarmDirOf(appData, convId);
  const membersFile = readCached(join(dir, 'members.json'), 256 * 1024);
  if (membersFile.size < 0 || !membersFile.text) return null;

  const roster = parseRoster(membersFile.text);
  if (!roster) return null;

  const boardFile = readCached(join(dir, 'board.jsonl'), 2 * 1024 * 1024);
  const rawMsgs = parseBoard(boardFile.text);
  const view = parseViewJson(convId, dir);

  const names = Object.keys(roster.members).filter(
    (n) => roster.members[n] && typeof roster.members[n] === 'object'
  );
  const lastPostByAgent = new Map();
  for (const msg of rawMsgs) {
    const agent = String(msg.agent || '');
    if (agent) lastPostByAgent.set(agent, msg);
  }

  const workerConvIds = new Set();
  const workspaces = new Set();
  const memberObjs = [];

  for (const name of names) {
    const m = roster.members[name];
    const cid = typeof m.conversation_id === 'string' ? m.conversation_id : '';
    if (cid && cid !== convId && ID_RE.test(cid)) {
      workerConvIds.add(cid);
    }
    if (typeof m.workspace === 'string' && m.workspace.trim()) {
      workspaces.add(m.workspace.trim());
    }

    const tr = summarizeTranscript(appData, cid).summary;
    const rawStatus = rawStatusOf(m, tr);
    const lastPost = lastPostByAgent.get(name);
    const role = roleOf(name, m);
    const roleWorker = isRoleWorker(name, m);
    const failure = stepFailure(tr, now);

    memberObjs.push({
      name,
      handle: `@${name}`,
      role,
      roleWorker,
      status: rawStatus,
      ready: isReadyMember(rawStatus, tr, String(lastPost?.text || '')),
      conversationId: cid,
      activity: tr?.activity || '',
      failure,
      transcriptMtime: tr?.mtime || 0,
      killed: Boolean(m.killed),
    });
  }

  const systemAttention = [];
  for (const m of memberObjs) {
    if (m.killed || m.roleWorker) continue;
    if (m.failure) {
      systemAttention.push({
        kind: m.failure.kind,
        summary: oneLine(`${m.handle}: ${m.failure.text}`, 120),
      });
    } else if (m.status === 'working' && m.transcriptMtime && now - m.transcriptMtime > stuckAfterMs) {
      systemAttention.push({
        kind: 'stuck',
        summary: `${m.handle}: stuck ${Math.round((now - m.transcriptMtime) / 60000)}m`,
      });
    }
  }

  const activeMembers = memberObjs.filter((m) => !m.killed);
  const workingCount = activeMembers.filter((m) => m.status === 'working').length;
  const readyWorkers = activeMembers.filter(
    (m) => m.role !== 'coordinator' && !m.roleWorker && m.ready
  );

  return {
    id: convId,
    title: roster.title,
    count: activeMembers.length || memberObjs.length,
    workingCount,
    isLive: workingCount > 0 || readyWorkers.length > 0,
    workerConvIds,
    workspaces: [...workspaces],
    viewJson: view.json,
    systemAttention,
    readyWorkers,
    mtime: Math.max(membersFile.mtime, boardFile.mtime, view.mtime),
  };
}

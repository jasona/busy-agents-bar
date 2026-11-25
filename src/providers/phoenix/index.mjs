import { existsSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expandHome } from '../../config.mjs';
import { normalizePathSafe, statOf } from '../antigravity/discovery.mjs';
import { oneLine, QUOTA_RE } from '../antigravity/transcript.mjs';

const ACTIVE_RUN_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const CANCELLED_RUN_STATUSES = new Set(['interrupted', 'cancelled', 'rolled_back']);
const NON_TERMINAL_SUBAGENT_STATUSES = new Set([
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
]);

let sqliteModulePromise = null;

async function getDatabaseSync() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite')
      .then((mod) => (typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null))
      .catch(() => null);
  }
  return sqliteModulePromise;
}

function dedupePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const expanded = resolve(expandHome(p.trim()));
    const canon = normalizePathSafe(expanded);
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(expanded);
  }
  return out;
}

/**
 * Resolves candidate Phoenix SQLite state database paths (`statev2.sqlite`).
 */
export function resolvePhoenixDbPaths(
  options = {},
  { env = process.env, homeDir = homedir() } = {}
) {
  if (Array.isArray(options.dbPaths) && options.dbPaths.length > 0) {
    return dedupePaths(options.dbPaths.map((p) => expandHome(p, homeDir)));
  }
  if (typeof options.dbPaths === 'string' && options.dbPaths.trim()) {
    return dedupePaths([expandHome(options.dbPaths.trim(), homeDir)]);
  }

  let dataDirs = [];
  if (Array.isArray(options.dataDirs) && options.dataDirs.length > 0) {
    dataDirs = options.dataDirs.map((d) => expandHome(d, homeDir)).filter(Boolean);
  } else if (typeof options.dataDirs === 'string' && options.dataDirs.trim()) {
    dataDirs = [expandHome(options.dataDirs.trim(), homeDir)];
  } else {
    if (typeof env.PHOENIX_HOME === 'string' && env.PHOENIX_HOME.trim()) {
      dataDirs.push(expandHome(env.PHOENIX_HOME.trim(), homeDir));
    }
    dataDirs.push(join(homeDir, '.phoenix'));
  }

  const candidates = [];
  for (const dir of dedupePaths(dataDirs)) {
    candidates.push(join(dir, 'userdata', 'statev2.sqlite'));
    candidates.push(join(dir, 'dev', 'statev2.sqlite'));
    if (Array.isArray(options.dataDirs) || typeof options.dataDirs === 'string') {
      candidates.push(join(dir, 'statev2.sqlite'));
    }
  }
  return dedupePaths(candidates);
}

function parseJsonSafe(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function stripShellWrapper(rawCmd) {
  let cmd = String(rawCmd ?? '').trim();
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+(?:-lc|-c)\s+([\s\S]+)$/.exec(cmd);
  if (m) {
    cmd = m[1].trim();
    if (
      cmd.length >= 2 &&
      ((cmd[0] === "'" && cmd[cmd.length - 1] === "'") ||
        (cmd[0] === '"' && cmd[cmd.length - 1] === '"'))
    ) {
      cmd = cmd.slice(1, -1).trim();
    }
  }
  return oneLine(cmd, 48);
}

function describeToolInputSummary(toolName, input) {
  const name = String(toolName || '').trim();
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const fileVal = input.file_path ?? input.path ?? input.fileName ?? input.target_file;
    if (typeof fileVal === 'string' && fileVal.trim()) {
      const target = fileVal.includes('://') ? fileVal.trim() : basename(fileVal.trim()) || fileVal.trim();
      return oneLine(`${name || 'Tool'} ${target}`, 52);
    }
    const cmdVal = input.command ?? input.cmd;
    if (typeof cmdVal === 'string' && cmdVal.trim()) {
      return `Run ${stripShellWrapper(cmdVal)}`;
    }
    const queryVal = input.pattern ?? input.query;
    if (typeof queryVal === 'string' && queryVal.trim()) {
      return oneLine(`Search ${queryVal}`, 52);
    }
  } else if (typeof input === 'string' && input.trim()) {
    return oneLine(`${name || 'Run'} ${input}`, 52);
  }
  return name ? `Tool: ${name}` : 'Working';
}

function describePhoenixTurnItem(item, driver) {
  if (!item) return driver ? `[${driver}] Working` : 'Working';
  const p = item.payload || {};
  switch (item.type) {
    case 'command_execution': {
      const cleaned = stripShellWrapper(p.input || '');
      return cleaned ? `Run ${cleaned}` : 'Running command';
    }
    case 'file_change': {
      const fileName = typeof p.fileName === 'string' ? p.fileName.trim() : '';
      return fileName ? `Edit ${basename(fileName) || fileName}` : 'Editing file';
    }
    case 'dynamic_tool':
      return describeToolInputSummary(p.toolName || p.title || 'tool', p.input);
    case 'file_search':
      return p.pattern ? oneLine(`Search ${p.pattern}`, 52) : 'Searching files';
    case 'web_search': {
      const pat = Array.isArray(p.patterns) && p.patterns[0] ? String(p.patterns[0]) : '';
      return pat ? oneLine(`Search ${pat}`, 52) : 'Web search';
    }
    case 'reasoning':
      return 'Thinking';
    case 'assistant_message':
      return 'Responding';
    case 'proposed_plan':
      return 'Planning';
    default:
      return driver ? `[${driver}] Working` : 'Working';
  }
}

function extractWaitingDetails(pendingReq, turnItems) {
  const reqKind = String(pendingReq.kind || '').toLowerCase();
  const reqId = pendingReq.runtime_request_id;
  const matchingItem = turnItems.find(
    (it) =>
      it.payload?.requestId === reqId ||
      (reqKind === 'user_input' && it.type === 'user_input_request') ||
      (reqKind !== 'user_input' && it.type === 'approval_request')
  );

  if (reqKind === 'user_input') {
    const q = matchingItem?.payload?.questions?.[0];
    const promptText = q?.question || q?.header || pendingReq.payload?.prompt;
    return {
      attentionKind: 'question',
      activity: promptText ? oneLine(promptText, 64) : 'Input needed',
    };
  }

  const promptText =
    matchingItem?.payload?.prompt ||
    matchingItem?.payload?.reason ||
    pendingReq.payload?.prompt ||
    pendingReq.payload?.reason;

  const fallback =
    reqKind && reqKind !== 'approval' && reqKind !== 'command_execution'
      ? `Approve ${reqKind}`
      : reqKind === 'command_execution'
        ? 'Approve command'
        : 'Approval required';

  return {
    attentionKind: 'approval',
    activity: promptText ? oneLine(promptText, 64) : fallback,
  };
}

function extractErrorDetails(run, session, turnItems) {
  const errItem = turnItems.find((it) => it.type === 'error');
  const failureObj = errItem?.payload?.failure;
  const rawMessage =
    failureObj?.message ||
    failureObj?.reason ||
    (typeof run?.payload?.failure === 'string' ? run.payload.failure : run?.payload?.failure?.message) ||
    session?.payload?.lastError ||
    session?.payload?.error ||
    'Run failed';

  const errorClass = String(
    failureObj?.errorClass ||
      session?.payload?.lastErrorClass ||
      run?.payload?.lastErrorClass ||
      ''
  ).toLowerCase();

  const text = oneLine(rawMessage, 64) || 'Run failed';
  const isQuota = errorClass === 'usage_limit' || QUOTA_RE.test(text);
  return {
    attentionKind: isQuota ? 'quota' : 'error',
    activity: text,
  };
}

function readDbSnapshot(dbPath, DatabaseSync) {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 500 });
  try {
    const existingTables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
    );
    if (
      !existingTables.has('orchestration_v2_projection_threads') ||
      !existingTables.has('orchestration_v2_projection_runs')
    ) {
      return null;
    }

    const projects = new Map();
    if (existingTables.has('projection_projects')) {
      const projRows = db
        .prepare(
          'SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL'
        )
        .all();
      for (const p of projRows) {
        projects.set(p.project_id, {
          id: p.project_id,
          title: typeof p.title === 'string' ? p.title.trim() : '',
          workspaceRoot: typeof p.workspace_root === 'string' ? p.workspace_root.trim() : '',
        });
      }
    }

    const threadRows = db
      .prepare(
        `SELECT thread_id, project_id, title, default_provider, provider_instance_id, created_at, updated_at
         FROM orchestration_v2_projection_threads
         WHERE archived_at IS NULL AND deleted_at IS NULL`
      )
      .all();

    if (threadRows.length === 0) {
      return { projects, threads: [], runsByThread: new Map(), pendingReqByThread: new Map(), sessionsByThread: new Map(), subagents: [], itemsByRun: new Map() };
    }

    const latestRunRows = db
      .prepare(
        `SELECT run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ordinal DESC) AS rn
           FROM orchestration_v2_projection_runs
         )
         WHERE rn = 1`
      )
      .all();

    const runsByThread = new Map();
    for (const r of latestRunRows) {
      runsByThread.set(r.thread_id, {
        ...r,
        payload: parseJsonSafe(r.payload_json),
      });
    }

    const pendingReqByThread = new Map();
    if (existingTables.has('orchestration_v2_projection_runtime_requests')) {
      const reqRows = db
        .prepare(
          `SELECT runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, payload_json
           FROM orchestration_v2_projection_runtime_requests
           WHERE status = 'pending'
           ORDER BY created_at DESC`
        )
        .all();
      for (const req of reqRows) {
        if (!pendingReqByThread.has(req.thread_id)) {
          pendingReqByThread.set(req.thread_id, {
            ...req,
            payload: parseJsonSafe(req.payload_json),
          });
        }
      }
    }

    const sessionsByThread = new Map();
    if (existingTables.has('orchestration_v2_projection_provider_sessions')) {
      const sessRows = db
        .prepare(
          `SELECT provider_session_id, thread_id, provider, status, updated_at, payload_json
           FROM orchestration_v2_projection_provider_sessions
           ORDER BY updated_at DESC`
        )
        .all();
      for (const s of sessRows) {
        if (!sessionsByThread.has(s.thread_id)) {
          sessionsByThread.set(s.thread_id, {
            ...s,
            payload: parseJsonSafe(s.payload_json),
          });
        }
      }
    }

    let subagents = [];
    if (existingTables.has('orchestration_v2_projection_subagents')) {
      subagents = db
        .prepare(
          `SELECT subagent_id, thread_id, run_id, child_thread_id, status, updated_at
           FROM orchestration_v2_projection_subagents`
        )
        .all();
    }

    const itemsByRun = new Map();
    if (existingTables.has('orchestration_v2_projection_turn_items')) {
      const countStmt = db.prepare(
        'SELECT COUNT(*) AS total FROM orchestration_v2_projection_turn_items WHERE run_id = ?'
      );
      const itemsStmt = db.prepare(
        `SELECT turn_item_id, type, status, updated_at, payload_json
         FROM orchestration_v2_projection_turn_items
         WHERE run_id = ?
         ORDER BY ordinal DESC
         LIMIT 8`
      );
      const activeThreadIds = new Set(threadRows.map((t) => t.thread_id));
      for (const r of runsByThread.values()) {
        if (!activeThreadIds.has(r.thread_id)) continue;
        if (CANCELLED_RUN_STATUSES.has(String(r.status || '').toLowerCase())) continue;
        const countRow = countStmt.get(r.run_id);
        const rawItems = itemsStmt.all(r.run_id);
        itemsByRun.set(r.run_id, {
          total: Number(countRow?.total || rawItems.length || 0),
          items: rawItems.map((it) => ({
            ...it,
            payload: parseJsonSafe(it.payload_json),
          })),
        });
      }
    }

    return {
      projects,
      threads: threadRows,
      runsByThread,
      pendingReqByThread,
      sessionsByThread,
      subagents,
      itemsByRun,
    };
  } finally {
    db.close();
  }
}

/**
 * Monitors local Phoenix (`../phoenix-code/`) Orchestration v2 SQLite projections.
 */
export class PhoenixProvider {
  constructor(options = {}) {
    this.id = 'phoenix';
    this.label = 'Phoenix';
    this._options = options;
    this._stuckAfterMs = Number(options.stuckAfterMs ?? 600000);
    this._staleAfterMs = Number(options.staleAfterMs ?? 21600000);
    this._emitChange = null;
    this._watchers = new Map();
    this._debounceTimer = null;
    this._started = false;
    this._dbCache = new Map();
  }

  _scheduleEmit() {
    if (!this._emitChange) return;
    if (this._debounceTimer) return;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (this._emitChange) this._emitChange();
    }, 150);
  }

  _ensureWatch(dir) {
    if (!dir || this._watchers.has(dir) || !existsSync(dir)) return;
    try {
      const w = watch(dir, (_eventType, filename) => {
        if (
          !filename ||
          String(filename).startsWith('statev2.sqlite') ||
          String(filename) === 'userdata' ||
          String(filename) === 'dev'
        ) {
          this._scheduleEmit();
        }
      });
      w.on('error', () => this._dropWatch(dir));
      this._watchers.set(dir, w);
    } catch {
      // Ignore directories that cannot be watched.
    }
  }

  _dropWatch(dir) {
    const w = this._watchers.get(dir);
    if (!w) return;
    this._watchers.delete(dir);
    try {
      w.close();
    } catch {
      // Ignore close error.
    }
  }

  _syncWatchers(dbPaths) {
    if (!this._started) return;
    const desired = new Set();
    for (const dbPath of dbPaths) {
      const parent = dirname(dbPath);
      const grandParent = dirname(parent);
      if (existsSync(parent)) desired.add(parent);
      if (existsSync(grandParent)) desired.add(grandParent);
    }
    for (const existing of [...this._watchers.keys()]) {
      if (!desired.has(existing)) this._dropWatch(existing);
    }
    for (const dir of desired) {
      this._ensureWatch(dir);
    }
  }

  async start(ctx = {}) {
    this._emitChange = typeof ctx.emitChange === 'function' ? ctx.emitChange : null;
    this._started = true;
    await getDatabaseSync();
    const dbPaths = resolvePhoenixDbPaths(this._options);
    this._syncWatchers(dbPaths);
  }

  stop() {
    this._started = false;
    this._emitChange = null;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    for (const dir of [...this._watchers.keys()]) {
      this._dropWatch(dir);
    }
    this._dbCache.clear();
  }

  async poll(now = Date.now()) {
    const DatabaseSync = await getDatabaseSync();
    if (!DatabaseSync) return [];

    const dbPaths = resolvePhoenixDbPaths(this._options);
    this._syncWatchers(dbPaths);

    const sessions = [];

    for (const dbPath of dbPaths) {
      const dbStat = statOf(dbPath);
      if (dbStat.size < 0 || !dbStat.isFile) continue;
      const walStat = statOf(`${dbPath}-wal`);
      const cacheKey = `${dbStat.mtime}:${dbStat.size}:${walStat.mtime}:${walStat.size}`;

      let snapshot = null;
      const cached = this._dbCache.get(dbPath);
      if (cached && cached.key === cacheKey) {
        snapshot = cached.data;
      } else {
        try {
          snapshot = readDbSnapshot(dbPath, DatabaseSync);
          this._dbCache.set(dbPath, { key: cacheKey, data: snapshot });
        } catch {
          // Database may be initializing or temporarily busy; degrade cleanly.
          continue;
        }
      }

      if (!snapshot) continue;

      const threadIds = new Set(snapshot.threads.map((t) => t.thread_id));
      const foldedChildThreadIds = new Set();
      for (const sub of snapshot.subagents) {
        if (sub.child_thread_id && threadIds.has(sub.thread_id)) {
          foldedChildThreadIds.add(sub.child_thread_id);
        }
      }

      for (const thread of snapshot.threads) {
        if (foldedChildThreadIds.has(thread.thread_id)) continue;

        const run = snapshot.runsByThread.get(thread.thread_id);
        if (!run) continue;

        const runStatus = String(run.status || '').toLowerCase();
        if (CANCELLED_RUN_STATUSES.has(runStatus)) continue;

        const pendingReq = snapshot.pendingReqByThread.get(thread.thread_id) || null;
        const providerSession = snapshot.sessionsByThread.get(thread.thread_id) || null;
        const itemEntry = snapshot.itemsByRun.get(run.run_id) || { total: 0, items: [] };
        const turnItems = itemEntry.items;

        const matchingSubagents = snapshot.subagents.filter(
          (s) => s.run_id === run.run_id || (!s.run_id && s.thread_id === thread.thread_id)
        );
        const swarmTotalCount = matchingSubagents.length;
        const swarmWorkingCount = matchingSubagents.filter((s) =>
          NON_TERMINAL_SUBAGENT_STATUSES.has(String(s.status || '').toLowerCase())
        ).length;
        const isSwarm = swarmTotalCount > 0;

        const startedAtMs =
          parseIsoMs(thread.created_at) ||
          parseIsoMs(run.requested_at) ||
          parseIsoMs(thread.updated_at) ||
          now;
        const turnStartedAtMs =
          parseIsoMs(run.payload?.workStartedAt) ||
          parseIsoMs(run.payload?.startedAt) ||
          parseIsoMs(run.requested_at) ||
          startedAtMs;

        const latestItemMs = turnItems[0] ? parseIsoMs(turnItems[0].updated_at) : 0;
        const pendingReqMs = pendingReq ? parseIsoMs(pendingReq.created_at) : 0;
        const subagentMaxMs = matchingSubagents.reduce(
          (max, s) => Math.max(max, parseIsoMs(s.updated_at)),
          0
        );
        const updatedAtMs =
          Math.max(
            latestItemMs,
            pendingReqMs,
            subagentMaxMs,
            parseIsoMs(run.completed_at),
            parseIsoMs(run.requested_at),
            parseIsoMs(thread.updated_at)
          ) || now;

        const isActiveRun = ACTIVE_RUN_STATUSES.has(runStatus);

        let status = 'idle';
        let attentionKind = null;
        let activity = '';

        if (pendingReq) {
          status = 'waiting';
          const details = extractWaitingDetails(pendingReq, turnItems);
          attentionKind = details.attentionKind;
          activity = details.activity;
        } else if (isActiveRun) {
          if (this._stuckAfterMs > 0 && now - updatedAtMs > this._stuckAfterMs) {
            status = 'waiting';
            attentionKind = 'stuck';
            activity = `Stuck ${Math.max(1, Math.round((now - updatedAtMs) / 60000))}m`;
          } else {
            status = 'running';
            const driver = run.provider_instance_id || run.provider || thread.provider_instance_id || thread.default_provider;
            const latestMeaningful = turnItems.find((it) => it.type !== 'user_message');
            if (isSwarm && swarmWorkingCount > 0 && !latestMeaningful) {
              activity = `Swarm ${swarmWorkingCount}/${swarmTotalCount}`;
            } else {
              activity = describePhoenixTurnItem(latestMeaningful, driver);
            }
          }
        } else if (runStatus === 'failed') {
          status = 'error';
          const errInfo = extractErrorDetails(run, providerSession, turnItems);
          attentionKind = errInfo.attentionKind;
          activity = errInfo.activity;
        } else if (runStatus === 'completed') {
          status = 'done';
          activity = 'Done';
        }

        if (status === 'idle') continue;
        if (this._staleAfterMs > 0 && status !== 'running' && now - updatedAtMs > this._staleAfterMs) {
          continue;
        }

        const projRec = snapshot.projects.get(thread.project_id);
        const project =
          projRec?.title ||
          (projRec?.workspaceRoot ? basename(projRec.workspaceRoot.replace(/[/\\]+$/, '')) : '') ||
          'phoenix';

        sessions.push({
          id: thread.thread_id,
          provider: this.id,
          project,
          title: thread.title || 'Phoenix thread',
          status,
          attentionKind,
          activity,
          updatedAtMs,
          startedAtMs,
          turnStartedAtMs,
          steps: itemEntry.total,
          isSwarm,
          swarmWorkingCount,
          swarmTotalCount,
        });
      }
    }

    return sessions;
  }
}

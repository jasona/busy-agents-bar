import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
export const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const fileCache = new Map();

export function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function statOf(filePath) {
  try {
    const s = statSync(filePath);
    return { mtime: s.mtimeMs, size: s.size, isDir: s.isDirectory(), isFile: s.isFile() };
  } catch {
    return { mtime: 0, size: -1, isDir: false, isFile: false };
  }
}

export function readCached(filePath, maxBytes = Infinity) {
  const s = statOf(filePath);
  if (s.size < 0 || !s.isFile) return { text: null, mtime: 0, size: -1, tooLarge: false };
  if (s.size > maxBytes) return { text: null, tooLarge: true, mtime: s.mtime, size: s.size };
  const key = `${s.mtime}:${s.size}`;
  const hit = fileCache.get(filePath);
  if (hit && hit.key === key) return { text: hit.text, tooLarge: false, mtime: s.mtime, size: s.size };
  try {
    const text = readFileSync(filePath, 'utf-8');
    if (fileCache.size > 1000) fileCache.clear();
    fileCache.set(filePath, { key, text });
    return { text, tooLarge: false, mtime: s.mtime, size: s.size };
  } catch {
    return { text: null, tooLarge: false, mtime: 0, size: -1 };
  }
}

export function uriToPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return '';
  const trimmed = uri.trim();
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return '';
    }
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : '';
}

export function normalizePathSafe(p) {
  if (!p) return '';
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function dedupeDirs(dirs) {
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    if (typeof d !== 'string' || !d) continue;
    const canon = normalizePathSafe(d);
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(d);
  }
  return out;
}

/**
 * Resolves Antigravity appData (brain roots) and projects directories.
 */
export function resolveAntigravityPaths(options = {}) {
  const homeDir = options.homeDir || homedir();
  const configDir = options.configDir || join(homeDir, '.gemini', 'config');
  const projectsDir = options.projectsDir || join(configDir, 'projects');

  let appDataDirs;
  if (Array.isArray(options.appDataDirs) && options.appDataDirs.length > 0) {
    appDataDirs = dedupeDirs(options.appDataDirs.filter(Boolean));
  } else if (typeof options.appDataDirs === 'string' && options.appDataDirs.trim()) {
    appDataDirs = dedupeDirs([options.appDataDirs.trim()]);
  } else {
    const candidates = [];
    if (
      process.env.ANTIGRAVITY_APP_DATA_DIR &&
      existsSync(join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'brain'))
    ) {
      candidates.push(process.env.ANTIGRAVITY_APP_DATA_DIR);
    }
    const geminiRoot = join(homeDir, '.gemini');
    for (const name of safeReaddir(geminiRoot).sort()) {
      const dir = join(geminiRoot, name);
      if (existsSync(join(dir, 'brain'))) {
        candidates.push(dir);
      }
    }
    appDataDirs = dedupeDirs(candidates);
  }

  return { homeDir, configDir, projectsDir, appDataDirs };
}

function extractProjectPaths(raw) {
  const paths = [];
  const resources = Array.isArray(raw?.projectResources?.resources)
    ? raw.projectResources.resources
    : [];
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const uri = r.gitFolder?.folderUri || r.folderUri || r.uri || '';
    const p = uriToPath(uri);
    if (p) paths.push(p);
  }
  for (const fallback of [raw?.workspacePath, raw?.path, raw?.folderPath]) {
    if (typeof fallback === 'string' && isAbsolute(fallback)) {
      paths.push(resolve(fallback));
    }
  }
  return [...new Set(paths)];
}

/**
 * Discovers workspace projects from ~/.gemini/config/projects/*.json, skipping sidecar pseudo-projects.
 */
export function discoverProjects(options = {}) {
  const { projectsDir } = resolveAntigravityPaths(options);
  const files = safeReaddir(projectsDir).filter((f) => f.endsWith('.json')).sort();
  const projects = [];
  const seen = new Set();

  for (const file of files) {
    const fullPath = join(projectsDir, file);
    const { text } = readCached(fullPath, 256 * 1024);
    if (!text) continue;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || Boolean(raw.sidecar)) continue;

    const paths = extractProjectPaths(raw);
    const primaryPath = paths[0] || '';
    const fallbackId = file.replace(/\.json$/i, '');
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId;
    if (!PROJECT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);

    const name =
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : primaryPath
          ? basename(primaryPath)
          : id;

    projects.push({
      id,
      name,
      path: primaryPath,
      paths,
      canonicalPaths: paths.map(normalizePathSafe).filter(Boolean),
    });
  }

  return projects;
}

/**
 * Reads optional local metadata or heading title inside a brain conversation directory.
 */
export function readConversationLocalMetadata(brainDir) {
  const result = { title: '', projectId: '', workspacePaths: [] };

  for (const rel of ['metadata.json', join('.system_generated', 'metadata.json')]) {
    const f = readCached(join(brainDir, rel), 64 * 1024);
    if (!f.text) continue;
    try {
      const md = JSON.parse(f.text);
      if (!md || typeof md !== 'object') continue;
      if (!result.title) {
        result.title = String(
          md.title || md.summary || md.name || md.conversation?.title || ''
        ).trim();
      }
      if (!result.projectId && typeof md.projectId === 'string') {
        result.projectId = md.projectId.trim();
      }
      const uris = []
        .concat(Array.isArray(md.workspace_uris) ? md.workspace_uris : [])
        .concat(Array.isArray(md.workspaceUris) ? md.workspaceUris : [])
        .concat(typeof md.workspaceUri === 'string' ? [md.workspaceUri] : [])
        .concat(typeof md.workspacePath === 'string' ? [md.workspacePath] : []);
      for (const u of uris) {
        if (typeof u !== 'string') continue;
        const p = uriToPath(u);
        if (p) result.workspacePaths.push(p);
      }
    } catch {
      // Ignore invalid metadata JSON.
    }
  }

  if (!result.title) {
    for (const mdName of ['task.md', 'implementation_plan.md']) {
      const f = readCached(join(brainDir, mdName), 32 * 1024);
      if (!f.text) continue;
      const m = f.text.match(/^\s*#\s+(.+?)\s*$/m);
      if (m && m[1]) {
        result.title = m[1].trim().slice(0, 96);
        break;
      }
    }
  }

  return result;
}

/**
 * Discovers brain conversations across all configured Antigravity appData directories.
 */
export function discoverConversations(options = {}) {
  const { appDataDirs } = resolveAntigravityPaths(options);
  const convs = [];
  const seen = new Set();

  for (const appData of appDataDirs) {
    const brainRoot = join(appData, 'brain');
    for (const id of safeReaddir(brainRoot)) {
      if (!ID_RE.test(id) || seen.has(id)) continue;
      const brainDir = join(brainRoot, id);
      const dirStat = statOf(brainDir);
      if (!dirStat.isDir) continue;
      seen.add(id);

      const logsDir = join(brainDir, '.system_generated', 'logs');
      const transcriptPath = join(logsDir, 'transcript.jsonl');
      const swarmDir = join(brainDir, '.system_generated', 'swarm');
      const membersPath = join(swarmDir, 'members.json');
      const boardPath = join(swarmDir, 'board.jsonl');

      const trStat = statOf(transcriptPath);
      const membersStat = statOf(membersPath);
      const boardStat = statOf(boardPath);

      const hasTranscript = trStat.isFile;
      const hasSwarm = membersStat.isFile;
      const mtime = Math.max(dirStat.mtime, trStat.mtime, membersStat.mtime, boardStat.mtime);
      const localMeta = readConversationLocalMetadata(brainDir);

      convs.push({
        id,
        appData,
        brainDir,
        logsDir,
        transcriptPath,
        swarmDir,
        hasTranscript,
        hasSwarm,
        mtime,
        localMeta,
      });
    }
  }

  convs.sort((a, b) => b.mtime - a.mtime);
  return convs;
}

/**
 * Matches a conversation to a discovered workspace project.
 * Prefers explicit metadata/swarm workspaces, then referenced paths (excluding plugin dirs),
 * preferring deeper nested paths only when one path encloses another, else highest match count / earliest hit.
 */
export function matchProjectName(conv, tr, swarm, projects) {
  if (conv.localMeta?.projectId) {
    const byId = projects.find((p) => p.id === conv.localMeta.projectId);
    if (byId) return byId.name;
  }

  const tiers = [
    [...(conv.localMeta?.workspacePaths || []), ...(swarm?.workspaces || [])],
    (tr?.referencedPaths || []).filter((p) => !p.includes(`${sep}.gemini${sep}config${sep}plugins${sep}`)),
  ];

  for (const tierPaths of tiers) {
    const scores = new Map(); // project.id -> { name, count, maxLen, firstIdx }
    for (let i = 0; i < tierPaths.length; i++) {
      const cand = normalizePathSafe(tierPaths[i]);
      if (!cand) continue;

      let bestForCand = null;
      for (const proj of projects) {
        for (const projPath of proj.canonicalPaths) {
          if (!projPath) continue;
          const prefix = projPath.endsWith(sep) ? projPath : projPath + sep;
          if (cand === projPath || cand.startsWith(prefix)) {
            if (!bestForCand || projPath.length > bestForCand.len) {
              bestForCand = { id: proj.id, name: proj.name, len: projPath.length };
            }
          }
        }
      }

      if (bestForCand) {
        const prev = scores.get(bestForCand.id);
        if (prev) {
          prev.count++;
        } else {
          scores.set(bestForCand.id, {
            name: bestForCand.name,
            count: 1,
            maxLen: bestForCand.len,
            firstIdx: i,
          });
        }
      }
    }

    if (scores.size > 0) {
      const ranked = [...scores.values()].sort(
        (a, b) => b.count - a.count || a.firstIdx - b.firstIdx
      );
      return ranked[0].name;
    }
  }

  return 'general';
}

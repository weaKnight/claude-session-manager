/**
 * Codex session index / Codex 会话索引
 *
 * Codex stores sessions in a date tree (~/.codex/sessions/YYYY/MM/DD/) with no
 * project directories — the working directory lives *inside* each file's
 * session_meta line. To present Codex sessions in the project-grouped UI we
 * must parse every file's meta once, group by encoded cwd, and remember which
 * absolute file each session id maps back to.
 *
 * Codex 把会话按日期分层存放，没有项目目录，工作目录写在文件内的 session_meta 行。
 * 为了在「按项目分组」的 UI 中展示，需要解析每个文件的 meta、按编码后的 cwd 分组，
 * 并记住每个 sessionId 对应的绝对文件路径。
 *
 * Caching: a single JSON file keyed by absolute path + (mtime,size). Unchanged
 * files are reused on restart so only new/modified sessions are re-streamed.
 * 缓存：单个 JSON，按绝对路径 + (mtime,size) 键入，重启后只重解析变更过的文件。
 */

import { promises as fsp, existsSync, readdirSync, statSync } from 'fs';
import type { Dirent } from 'fs';
import { join, dirname } from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { cachePaths } from '../utils/cache-paths.js';
import { parseCodexSessionMeta } from '../parser/codex-reader.js';
import { saveOffsetIndex, evictOffsets, newOffsetIndex } from './offset-cache.js';
import type { SessionMeta, ProjectInfo } from '../parser/message-types.js';

// Bumped to 2: SessionMeta now carries totalTokens parsed from Codex
// token_count events; pre-bump caches stored totalTokens=0 and must be
// discarded so every Codex file is re-parsed for real token usage.
// 升到 2：SessionMeta 新增由 token_count 解析出的 totalTokens，旧缓存里全为 0,
// 需让旧缓存失效以重新解析出真实 token 用量
const SCHEMA_VERSION = 2;
// Don't rescan the whole tree more often than this (ms) / 全树重扫节流
const REFRESH_TTL_MS = 3000;

interface CodexCacheEntry {
  mtimeMs: number;
  size: number;
  meta: SessionMeta;
}

interface CodexCache {
  schemaVersion: number;
  files: Record<string, CodexCacheEntry>; // absolute filePath → entry
}

// In-memory state / 内存状态
let cache: CodexCache = { schemaVersion: SCHEMA_VERSION, files: {} };
let loaded = false;
let lastScan = 0;
let scanInFlight: Promise<void> | null = null;

// Derived lookups, rebuilt after each scan / 每次扫描后重建的派生索引
let byProject = new Map<string, SessionMeta[]>();
let bySession = new Map<string, string>(); // sessionId → filePath

/** Codex support is on when codexDir is configured and the sessions tree exists. */
export function codexEnabled(): boolean {
  return !!config.codexDir && existsSync(join(config.codexDir, 'sessions'));
}

function sessionsRoot(): string {
  return join(config.codexDir, 'sessions');
}

/** Recursively collect rollout-*.jsonl files under the Codex sessions tree. */
function walkCodexFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkCodexFiles(full, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

async function loadCache(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const file = cachePaths.codexIndexFile();
  if (!existsSync(file)) return;
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as CodexCache;
    if (parsed?.schemaVersion === SCHEMA_VERSION && parsed.files && typeof parsed.files === 'object') {
      cache = parsed;
    }
  } catch (err) {
    logger.warn(`codex-index: cache load failed: ${err}`);
  }
}

async function saveCache(): Promise<void> {
  const file = cachePaths.codexIndexFile();
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    await fsp.mkdir(dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(cache), 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    logger.error(`codex-index: cache save failed: ${err}`);
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
  }
}

/** Rebuild the project/session lookups from the current cache. */
function rebuildDerived(): void {
  const projects = new Map<string, SessionMeta[]>();
  const sessions = new Map<string, string>();
  for (const [filePath, entry] of Object.entries(cache.files)) {
    const meta = entry.meta;
    const list = projects.get(meta.projectPath);
    if (list) list.push(meta);
    else projects.set(meta.projectPath, [meta]);
    sessions.set(meta.id, filePath);
  }
  byProject = projects;
  bySession = sessions;
}

/**
 * Scan the Codex tree, re-parsing only changed files, and refresh the derived
 * indexes. Throttled by REFRESH_TTL_MS unless `force` is set. Concurrent calls
 * share the same in-flight scan.
 * 扫描 Codex 目录树，仅重解析变更文件并刷新派生索引；带节流，并发调用共享同一次扫描。
 */
export async function refreshCodexIndex(force = false): Promise<void> {
  if (!codexEnabled()) {
    cache = { schemaVersion: SCHEMA_VERSION, files: {} };
    byProject = new Map();
    bySession = new Map();
    return;
  }
  await loadCache();

  if (!force && Date.now() - lastScan < REFRESH_TTL_MS) return;
  if (scanInFlight) return scanInFlight;

  scanInFlight = (async () => {
    const files = walkCodexFiles(sessionsRoot());
    const present = new Set(files);
    let dirty = false;

    // Drop entries for files that no longer exist / 移除已删除文件的缓存
    for (const path of Object.keys(cache.files)) {
      if (!present.has(path)) {
        delete cache.files[path];
        dirty = true;
      }
    }

    for (const filePath of files) {
      let mtimeMs = 0;
      let size = 0;
      try {
        const st = statSync(filePath);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        continue;
      }

      const cached = cache.files[filePath];
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) continue;

      try {
        const { meta, anchors } = await parseCodexSessionMeta(filePath);
        cache.files[filePath] = { mtimeMs, size, meta };
        dirty = true;

        // Persist byte-offset sidecar so paginated reads can seek directly.
        // 写入字节偏移 sidecar，供分页 seek 使用
        if (anchors.length > 0) {
          const offsetIdx = newOffsetIndex(mtimeMs, size);
          offsetIdx.anchors = anchors;
          saveOffsetIndex(meta.projectPath, meta.id, offsetIdx).catch(() => { /* logged inside */ });
        } else {
          evictOffsets(meta.projectPath, meta.id).catch(() => { /* best effort */ });
        }
      } catch (err) {
        logger.warn(`codex-index: parse failed ${filePath}: ${err}`);
      }
    }

    rebuildDerived();
    lastScan = Date.now();
    if (dirty) await saveCache();
  })();

  try {
    await scanInFlight;
  } finally {
    scanInFlight = null;
  }
}

/**
 * Snapshot of every cached Codex file (refreshes first). Used by the search
 * engine to ingest Codex sessions into the full-text index.
 * 返回所有已缓存 Codex 文件的快照（先刷新），供全文搜索索引使用。
 */
export async function listCodexFilesSnapshot(): Promise<
  Array<{ filePath: string; mtimeMs: number; size: number; meta: SessionMeta }>
> {
  if (!codexEnabled()) return [];
  await refreshCodexIndex(false);
  return Object.entries(cache.files).map(([filePath, entry]) => ({
    filePath,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    meta: entry.meta,
  }));
}

/** List Codex-derived projects (grouped by encoded cwd). */
export async function listCodexProjects(): Promise<ProjectInfo[]> {
  if (!codexEnabled()) return [];
  await refreshCodexIndex();

  const projects: ProjectInfo[] = [];
  for (const [projectPath, metas] of byProject) {
    let lastActivity = '';
    for (const m of metas) {
      if (m.lastTimestamp > lastActivity) lastActivity = m.lastTimestamp;
    }
    const decoded = projectPath.replace(/^-/, '/').replace(/-/g, '/');
    const segs = decoded.split('/').filter(Boolean);
    projects.push({
      encodedPath: projectPath,
      decodedPath: decoded,
      displayName: segs.slice(-2).join('/') || projectPath,
      sessionCount: metas.length,
      lastActivity,
      sources: ['codex'],
    });
  }
  return projects;
}

/** List Codex sessions for an encoded-cwd project id. */
export async function listCodexSessions(projectId: string): Promise<SessionMeta[]> {
  if (!codexEnabled()) return [];
  await refreshCodexIndex();
  const list = byProject.get(projectId);
  return list ? [...list] : [];
}

/** Resolve a Codex session id back to its absolute file path. */
export async function resolveCodexPath(sessionId: string): Promise<string | null> {
  if (!codexEnabled()) return null;
  await refreshCodexIndex();
  const path = bySession.get(sessionId);
  if (path && existsSync(path)) return path;
  return null;
}

/** Get a single Codex session's cached meta (parses on miss). */
export async function getCodexSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const filePath = await resolveCodexPath(sessionId);
  if (!filePath) return null;
  const entry = cache.files[filePath];
  return entry ? entry.meta : null;
}

/** Does this session id belong to a Codex session? / 该 sessionId 是否为 Codex 会话 */
export async function isCodexSession(sessionId: string): Promise<boolean> {
  return (await resolveCodexPath(sessionId)) !== null;
}

/**
 * Invalidate cache for one Codex file (called by the watcher). The next read
 * triggers a re-parse. We drop the entry and force a rescan on next access.
 * 失效单个 Codex 文件缓存（由 watcher 调用），下次读取时重新解析
 */
export function invalidateCodexFile(filePath: string): void {
  if (filePath in cache.files) {
    delete cache.files[filePath];
  }
  // Force the next refresh to re-walk rather than honour the TTL.
  // 强制下次刷新重扫，不受 TTL 节流
  lastScan = 0;
  rebuildDerived();
}

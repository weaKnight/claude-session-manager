/**
 * Persistent session metadata cache / 持久化会话元数据缓存
 *
 * One JSON file per project under cache/meta/{projectId}.json keyed by
 * mtime+size. Avoids re-streaming large .jsonl files when nothing changed.
 *
 * Design notes:
 *  - One file per project (not per session) — keeps inode count flat as the
 *    workspace grows past thousands of sessions.
 *  - Atomic writes via writeFile(tmp) + rename to avoid torn reads.
 *  - In-memory mirror of each loaded project index so listSessions does not
 *    re-read the JSON on every call.
 *  - Per-project save lock so concurrent listSessions() calls don't race.
 *
 * 每个项目一个 JSON 文件，键为 mtime+size；文件未变即复用，避免重读 60MB jsonl。
 */

import { promises as fsp, existsSync, statSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';
import { cachePaths } from '../utils/cache-paths.js';
import { parseSessionMeta } from '../parser/jsonl-reader.js';
import type { SessionMeta } from '../parser/message-types.js';
import { saveOffsetIndex, evictOffsets, newOffsetIndex } from './offset-cache.js';

const SCHEMA_VERSION = 1;

interface MetaCacheEntry {
  mtimeMs: number;
  size: number;
  meta: SessionMeta;
}

interface ProjectMetaIndex {
  schemaVersion: number;
  sessions: Record<string, MetaCacheEntry>;
}

// In-memory mirrors / 内存镜像
const indexCache = new Map<string, ProjectMetaIndex>();
const dirtyProjects = new Set<string>();
// Per-project save lock to serialize concurrent writes
// 每项目一把保存锁，串行化并发写
const saveLocks = new Map<string, Promise<void>>();

function emptyIndex(): ProjectMetaIndex {
  return { schemaVersion: SCHEMA_VERSION, sessions: {} };
}

/**
 * Load a project's meta index from disk (or return an empty one).
 * 从磁盘加载项目元数据索引；不存在或版本不匹配时返回空索引
 */
export async function loadProjectIndex(projectId: string): Promise<ProjectMetaIndex> {
  const cached = indexCache.get(projectId);
  if (cached) return cached;

  const file = cachePaths.metaIndexFile(projectId);
  if (!existsSync(file)) {
    const idx = emptyIndex();
    indexCache.set(projectId, idx);
    return idx;
  }

  try {
    const raw = await fsp.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as ProjectMetaIndex;
    if (parsed?.schemaVersion !== SCHEMA_VERSION || typeof parsed.sessions !== 'object') {
      logger.warn(`meta-cache: schema mismatch for ${projectId}, rebuilding`);
      const idx = emptyIndex();
      indexCache.set(projectId, idx);
      return idx;
    }
    indexCache.set(projectId, parsed);
    return parsed;
  } catch (err) {
    logger.warn(`meta-cache: load failed for ${projectId}: ${err}`);
    const idx = emptyIndex();
    indexCache.set(projectId, idx);
    return idx;
  }
}

/**
 * Atomically persist a project's meta index to disk.
 * 原子化写盘
 */
export async function saveProjectIndex(projectId: string): Promise<void> {
  const idx = indexCache.get(projectId);
  if (!idx) return;
  if (!dirtyProjects.has(projectId)) return;

  // Serialize concurrent saves per project / 每项目串行化并发保存
  const previous = saveLocks.get(projectId) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (!dirtyProjects.has(projectId)) return;
    const file = cachePaths.metaIndexFile(projectId);
    const tmp = `${file}.tmp.${process.pid}`;
    try {
      await fsp.mkdir(dirname(file), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(idx), 'utf-8');
      await fsp.rename(tmp, file);
      dirtyProjects.delete(projectId);
    } catch (err) {
      logger.error(`meta-cache: save failed for ${projectId}: ${err}`);
      // Best-effort cleanup; tmp may not exist / 失败清理临时文件
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
    }
  });
  saveLocks.set(projectId, next);
  await next;
}

/**
 * Return cached meta if mtime+size match, else parse from disk and update cache.
 * Caller is responsible for invoking saveProjectIndex once a batch is done.
 * 命中返回缓存；未命中则重解析并更新内存索引
 */
export async function getOrParseMeta(
  projectId: string,
  sessionId: string,
  filePath: string,
): Promise<SessionMeta> {
  const idx = await loadProjectIndex(projectId);

  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(filePath);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (err) {
    // Source missing — fall through to parser, which will raise / 源文件缺失
    logger.debug(`meta-cache: stat failed ${filePath}: ${err}`);
  }

  const entry = idx.sessions[sessionId];
  if (entry && entry.mtimeMs === mtimeMs && entry.size === size) {
    return entry.meta;
  }

  const { meta, anchors } = await parseSessionMeta(filePath);
  idx.sessions[sessionId] = { mtimeMs, size, meta };
  dirtyProjects.add(projectId);

  // Persist anchors as a sidecar so parseSessionSlice can seek directly.
  // Stale sidecars from a previous file version are also cleared here when
  // there are no anchors yet (e.g. very small session).
  // 同步刷新偏移 sidecar，旧版本对应的过期文件也在此清理
  if (mtimeMs > 0) {
    if (anchors.length > 0) {
      const offsetIdx = newOffsetIndex(mtimeMs, size);
      offsetIdx.anchors = anchors;
      saveOffsetIndex(projectId, sessionId, offsetIdx).catch(() => { /* logged inside */ });
    } else {
      evictOffsets(projectId, sessionId).catch(() => { /* best effort */ });
    }
  }

  return meta;
}

/**
 * Drop a single session from the in-memory index and mark dirty so the
 * next save flushes the change. Disk write is deferred to keep callers cheap.
 * 从内存索引移除单个会话，标记为脏供下次写盘
 */
export function evictSession(projectId: string, sessionId: string): void {
  const idx = indexCache.get(projectId);
  if (!idx) return;
  if (sessionId in idx.sessions) {
    delete idx.sessions[sessionId];
    dirtyProjects.add(projectId);
  }
}

/**
 * Drop the entire project index from memory and disk.
 * 移除整个项目的索引（内存 + 磁盘）
 */
export function evictProject(projectId: string): void {
  indexCache.delete(projectId);
  dirtyProjects.delete(projectId);
  const file = cachePaths.metaIndexFile(projectId);
  if (existsSync(file)) {
    try { fsp.unlink(file); } catch { /* fire-and-forget */ }
  }
}

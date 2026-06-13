/**
 * Full-text search engine / 全文搜索引擎
 *
 * Uses MiniSearch for in-memory indexing of session content. The index is
 * persisted as JSON under cache/search/ so process restarts don't pay the
 * cold-start rebuild cost. chokidar events feed incremental discard+add
 * updates so live writes are searchable within ~1s.
 *
 * 启动时从磁盘 loadJSON；chokidar 事件触发增量 discard+add；
 * dirty 时 30s 内 debounce 落盘；进程关闭时 flush。
 */

import MiniSearch from 'minisearch';
import { promises as fsp, readdirSync, existsSync, createReadStream, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { createInterface } from 'readline';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { cachePaths } from '../utils/cache-paths.js';
import { getProjectDisplayName } from '../parser/jsonl-reader.js';
import { extractCodexSearchText } from '../parser/codex-reader.js';
import { codexEnabled, listCodexFilesSnapshot } from './codex-index.js';
import type { SessionMeta } from '../parser/message-types.js';

const SCHEMA_VERSION = 1;

interface SearchDocument {
  id: string;           // projectId/sessionId
  projectId: string;
  projectName: string;
  sessionId: string;
  text: string;
  timestamp: string;
  summary: string;
  // Origin of the session, surfaced so the UI can badge Codex hits.
  // 会话来源，透传给前端用于显示 Codex 徽章。
  source: 'claude' | 'codex';
}

export interface SearchResult {
  projectId: string;
  projectName: string;
  sessionId: string;
  summary: string;
  timestamp: string;
  score: number;
  matchSnippet: string;
  // Origin of the matched session / 命中会话的来源
  source: 'claude' | 'codex';
}

interface IndexManifest {
  schemaVersion: number;
  builtAt: number;
  // Map of absolute path → file stat used to drive incremental reconcile.
  // 绝对路径 → mtime/size，用于增量比对
  perFile: Record<string, { mtimeMs: number; size: number; id: string }>;
}

// Mutable shape required by MiniSearch — don't make this `as const`.
// MiniSearch 接口需要可变数组类型，不要加 as const
const MINISEARCH_OPTIONS = {
  fields: ['text', 'summary', 'projectName'] as string[],
  storeFields: ['projectId', 'projectName', 'sessionId', 'summary', 'timestamp', 'source'] as string[],
  searchOptions: {
    boost: { summary: 2, projectName: 1.5 },
    fuzzy: 0.2,
    prefix: true,
  },
  // Disable async auto-vacuum: it runs in batches that yield to the event loop,
  // so a chokidar event's add()/discard() can mutate the tree mid-vacuum and
  // crash the iterator (`TreeIterator.dive: reading 'keys'`) as an *unhandled*
  // rejection. We instead vacuum at one controlled, awaited+caught point inside
  // the serialized persist (see doPersist). 关闭异步 auto-vacuum(分批让出事件循环时
  // 会与增量 add/discard 交错导致迭代器崩溃且为未捕获拒绝)，改为在串行 persist 内受控 vacuum。
  autoVacuum: false as const,
};

let index: MiniSearch<SearchDocument> | null = null;
let manifest: IndexManifest | null = null;
let isBuilding = false;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDeadline = 0;            // ms epoch — earliest time we'll let the timer push further
const PERSIST_DEBOUNCE_MS = 30_000; // settle window for bursts
const PERSIST_MAX_WAIT_MS = 60_000; // hard cap so a chatty session still flushes
// Serialize persists: overlapping persistIndex() calls (debounce timer +
// shutdown path, or a slow write during an event burst) must NOT run
// concurrently — they previously shared one temp filename (`.tmp.<pid>`) and
// raced, so the second rename hit ENOENT. We chain calls so they run one at a
// time; the `dirty` guard makes redundant queued runs no-ops.
// 串行化 persist：并发调用曾共用同名临时文件 `.tmp.<pid>` 而竞态(第二次 rename ENOENT)，
// 改为链式串行执行，配合 dirty 标志让多余的排队调用变为空操作。
let persistChain: Promise<void> = Promise.resolve();
let persistTmpSeq = 0;              // unique temp-file suffix per write

function newManifest(): IndexManifest {
  return { schemaVersion: SCHEMA_VERSION, builtAt: Date.now(), perFile: {} };
}

function ensureIndex(): MiniSearch<SearchDocument> {
  if (!index) index = new MiniSearch<SearchDocument>(MINISEARCH_OPTIONS);
  if (!manifest) manifest = newManifest();
  return index;
}

function schedulePersist(): void {
  const now = Date.now();
  if (!dirty) {
    // First dirty mark since last flush: arm the hard deadline
    // 首次脏：设置硬截止时间
    persistDeadline = now + PERSIST_MAX_WAIT_MS;
  }
  dirty = true;
  if (persistTimer) clearTimeout(persistTimer);
  // Schedule for `now + DEBOUNCE` but no later than the deadline so that a
  // continuous stream of events still flushes within MAX_WAIT.
  // 在 debounce 与 deadline 之间取较小值，避免无限推迟
  const fireIn = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, persistDeadline - now));
  persistTimer = setTimeout(() => {
    persistIndex().catch((err) => logger.error(`search persist failed: ${err}`));
  }, fireIn);
}

/**
 * Extract searchable text from a JSONL file.
 * 从 JSONL 提取可搜索文本
 */
async function extractSearchDoc(
  projectId: string,
  sessionId: string,
  filePath: string,
): Promise<SearchDocument> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const textParts: string[] = [];
  let summary = '';
  let timestamp = '';

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      if (!timestamp && entry.timestamp) {
        timestamp = entry.timestamp as string;
      }
      if (entry.type === 'summary' && entry.summary) {
        summary = entry.summary as string;
      }
      if (entry.message && typeof entry.message === 'object') {
        const msg = entry.message as Record<string, unknown>;
        const content = msg.content;
        if (typeof content === 'string') {
          textParts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'text' && typeof block.text === 'string') {
              textParts.push(block.text);
            }
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return {
    id: `${projectId}/${sessionId}`,
    projectId,
    projectName: getProjectDisplayName(projectId),
    sessionId,
    text: textParts.join(' ').slice(0, 50000),
    timestamp,
    summary: summary || textParts[0]?.slice(0, 200) || '',
    source: 'claude',
  };
}

/**
 * Build a search document from a Codex session's cached meta + file.
 * doc id mirrors the Claude scheme so locateSession can resolve hits by
 * sessionId alone (sessionId === Codex meta.id / UUID).
 * 用 Codex 会话的缓存 meta 与文件构建搜索文档；doc id 与 Claude 同构，
 * sessionId 即 Codex meta.id（UUID）。
 */
async function extractCodexSearchDoc(meta: SessionMeta, filePath: string): Promise<SearchDocument> {
  const text = await extractCodexSearchText(filePath);
  return {
    id: `${meta.projectPath}/${meta.id}`,
    projectId: meta.projectPath,
    projectName: meta.projectName,
    sessionId: meta.id,
    text,
    timestamp: meta.firstTimestamp,
    summary: meta.summary || '',
    source: 'codex',
  };
}

/**
 * Walk every project/session under ~/.claude/projects and ingest into the index.
 * 全量构建索引
 */
export async function buildIndex(): Promise<void> {
  if (isBuilding) return;
  isBuilding = true;

  logger.info('Building search index... / 正在构建搜索索引...');
  const startTime = Date.now();

  const newIndex = new MiniSearch<SearchDocument>(MINISEARCH_OPTIONS);
  const newManifestEntries: IndexManifest['perFile'] = {};

  const projectsDir = join(config.claudeDir, 'projects');
  if (!existsSync(projectsDir)) {
    index = newIndex;
    manifest = newManifest();
    isBuilding = false;
    return;
  }

  let docCount = 0;
  for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectPath = join(projectsDir, dir.name);
    const jsonlFiles = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(projectPath, file);
      try {
        const doc = await extractSearchDoc(dir.name, sessionId, filePath);
        if (doc.text.length > 0) {
          newIndex.add(doc);
          docCount++;
        }
        const st = statSync(filePath);
        newManifestEntries[filePath] = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          id: doc.id,
        };
      } catch (err) {
        logger.debug(`Index skip ${file}: ${err}`);
      }
    }
  }

  // Codex sessions: snapshot already refreshes the codex index internally.
  // Codex 会话：listCodexFilesSnapshot 内部已 refresh，无需再单独刷新。
  if (codexEnabled()) {
    const files = await listCodexFilesSnapshot();
    for (const f of files) {
      try {
        const doc = await extractCodexSearchDoc(f.meta, f.filePath);
        if (doc.text.length > 0) {
          newIndex.add(doc);
          docCount++;
        }
        newManifestEntries[f.filePath] = { mtimeMs: f.mtimeMs, size: f.size, id: doc.id };
      } catch (err) {
        logger.debug(`Index skip codex ${f.filePath}: ${err}`);
      }
    }
  }

  index = newIndex;
  manifest = { schemaVersion: SCHEMA_VERSION, builtAt: Date.now(), perFile: newManifestEntries };
  isBuilding = false;
  schedulePersist();

  const elapsed = Date.now() - startTime;
  logger.success(`Search index built: ${docCount} sessions in ${elapsed}ms`);
}

/**
 * Try to load a previously persisted index. Returns true on success, false if
 * the cache is missing or schema mismatches.
 * 启动时尝试加载磁盘索引；失败则返回 false 由调用方决定是否重建
 */
export async function loadIndex(): Promise<boolean> {
  const indexFile = cachePaths.searchIndexFile();
  const manifestFile = cachePaths.searchManifestFile();
  if (!existsSync(indexFile) || !existsSync(manifestFile)) return false;

  try {
    const [indexRaw, manifestRaw] = await Promise.all([
      fsp.readFile(indexFile, 'utf-8'),
      fsp.readFile(manifestFile, 'utf-8'),
    ]);
    const parsedManifest = JSON.parse(manifestRaw) as IndexManifest;
    if (parsedManifest?.schemaVersion !== SCHEMA_VERSION) {
      logger.warn('search-index: schema mismatch, will rebuild');
      return false;
    }
    index = MiniSearch.loadJSON<SearchDocument>(indexRaw, MINISEARCH_OPTIONS);
    manifest = parsedManifest;
    logger.success(`Search index loaded: ${Object.keys(manifest.perFile).length} sessions`);
    return true;
  } catch (err) {
    logger.warn(`search-index: load failed (${err}), will rebuild`);
    index = null;
    manifest = null;
    return false;
  }
}

/**
 * Atomically write the in-memory index to disk. Serialized: concurrent callers
 * queue behind the in-flight write rather than racing on the temp files.
 * Returns when this call's write has completed (so shutdown can await it).
 * 原子化落盘；串行执行，并发调用排队而非争用临时文件；返回时本次写入已完成(供 shutdown await)。
 */
export function persistIndex(): Promise<void> {
  // Append to the chain; run on both fulfill and reject of the prior link so a
  // failed write never stalls the queue. doPersist swallows its own errors.
  // 追加到链尾；无论上一环成功失败都继续，避免卡队列。
  persistChain = persistChain.then(doPersist, doPersist);
  return persistChain;
}

async function doPersist(): Promise<void> {
  if (!index || !manifest || !dirty) return;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }

  const indexFile = cachePaths.searchIndexFile();
  const manifestFile = cachePaths.searchManifestFile();
  // Unique per-write suffix (pid + monotonic seq) so even an unexpected overlap
  // can't collide on the temp path.
  // 每次写入唯一后缀(pid + 自增序号)，杜绝临时文件名碰撞。
  const uniq = `${process.pid}.${++persistTmpSeq}`;
  const indexTmp = `${indexFile}.tmp.${uniq}`;
  const manifestTmp = `${manifestFile}.tmp.${uniq}`;

  try {
    await fsp.mkdir(dirname(indexFile), { recursive: true });
    // Reclaim memory from discarded docs at this single serialized point (auto
    // vacuum is disabled). Caught so a rare interleave can't become an unhandled
    // rejection; also yields a smaller, dirt-free serialized index.
    // 在此唯一串行点回收已 discard 文档的内存(auto-vacuum 已关闭)；捕获异常避免未捕获拒绝。
    try { await index.vacuum(); } catch (err) { logger.debug(`search vacuum skipped: ${err}`); }
    const json = JSON.stringify(index);
    await Promise.all([
      fsp.writeFile(indexTmp, json, 'utf-8'),
      fsp.writeFile(manifestTmp, JSON.stringify(manifest), 'utf-8'),
    ]);
    await Promise.all([
      fsp.rename(indexTmp, indexFile),
      fsp.rename(manifestTmp, manifestFile),
    ]);
    dirty = false;
    persistDeadline = 0;
    logger.info(`search-index: persisted ${Object.keys(manifest.perFile).length} sessions (${(Buffer.byteLength(json) / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    logger.error(`search-index: persist failed: ${err}`);
    for (const tmp of [indexTmp, manifestTmp]) {
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
    }
  }
}

/**
 * Walk the filesystem and apply the delta against the manifest. Used right
 * after loadIndex() so changes that happened while the process was down get
 * reconciled before any search query runs.
 * 启动后调和磁盘索引与当前文件系统状态
 */
export async function reconcile(): Promise<void> {
  if (!index || !manifest) return;

  const projectsDir = join(config.claudeDir, 'projects');
  if (!existsSync(projectsDir)) return;

  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectPath = join(projectsDir, dir.name);
    let entries: string[];
    try { entries = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl')); }
    catch { continue; }

    for (const file of entries) {
      const filePath = join(projectPath, file);
      seen.add(filePath);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(filePath); } catch { continue; }
      const prior = manifest.perFile[filePath];
      if (prior && prior.mtimeMs === st.mtimeMs && prior.size === st.size) continue;

      const sessionId = file.replace('.jsonl', '');
      try {
        const doc = await extractSearchDoc(dir.name, sessionId, filePath);
        if (prior && index.has(prior.id)) index.discard(prior.id);
        if (doc.text.length > 0) index.add(doc);
        manifest.perFile[filePath] = { mtimeMs: st.mtimeMs, size: st.size, id: doc.id };
        if (prior) updated++; else added++;
      } catch (err) {
        logger.debug(`reconcile skip ${file}: ${err}`);
      }
    }
  }

  // Codex reconcile: share the same `seen` set so the delete pass below
  // covers both Claude and Codex files that disappeared while we were down.
  // Codex 对账：共用同一个 seen，使下方删除检测同时覆盖 Claude 与 Codex 被删文件。
  if (codexEnabled()) {
    const codexFiles = await listCodexFilesSnapshot();
    for (const f of codexFiles) {
      seen.add(f.filePath);
      const prior = manifest.perFile[f.filePath];
      if (prior && prior.mtimeMs === f.mtimeMs && prior.size === f.size) continue;
      try {
        const doc = await extractCodexSearchDoc(f.meta, f.filePath);
        if (prior && index.has(prior.id)) index.discard(prior.id);
        if (doc.text.length > 0) index.add(doc);
        manifest.perFile[f.filePath] = { mtimeMs: f.mtimeMs, size: f.size, id: doc.id };
        if (prior) updated++; else added++;
      } catch (err) {
        logger.debug(`reconcile skip codex ${f.filePath}: ${err}`);
      }
    }
  }

  // Drop entries whose files vanished while we were down
  // 进程下线期间被删除的文件
  for (const path of Object.keys(manifest.perFile)) {
    if (seen.has(path)) continue;
    const id = manifest.perFile[path].id;
    if (index.has(id)) index.discard(id);
    delete manifest.perFile[path];
    removed++;
  }

  if (added || updated || removed) {
    logger.info(`search-index reconcile: +${added} ~${updated} -${removed}`);
    schedulePersist();
  }
}

/**
 * Apply a single chokidar event to the live index incrementally.
 * 把单个 chokidar 事件增量应用到索引
 */
export async function onFileEvent(
  event: 'add' | 'change' | 'unlink',
  absPath: string,
): Promise<void> {
  if (!absPath.endsWith('.jsonl')) return;
  ensureIndex();

  const projectId = basename(dirname(absPath));
  const sessionId = basename(absPath, '.jsonl');
  const id = `${projectId}/${sessionId}`;

  if (event === 'unlink') {
    if (index!.has(id)) index!.discard(id);
    delete manifest!.perFile[absPath];
    schedulePersist();
    return;
  }

  try {
    const doc = await extractSearchDoc(projectId, sessionId, absPath);
    const st = statSync(absPath);
    if (index!.has(id)) index!.discard(id);
    if (doc.text.length > 0) index!.add(doc);
    manifest!.perFile[absPath] = { mtimeMs: st.mtimeMs, size: st.size, id };
    schedulePersist();
  } catch (err) {
    logger.debug(`search onFileEvent skip ${absPath}: ${err}`);
  }
}

/**
 * Apply a single Codex chokidar event to the live index incrementally.
 * unlink needs no meta; add/change require the session's meta (the caller
 * resolves it from the codex index).
 * 把单个 Codex 文件事件增量应用到索引：unlink 无需 meta；add/change 需要 meta。
 */
export async function onCodexFileEvent(
  event: 'add' | 'change' | 'unlink',
  absPath: string,
  meta?: SessionMeta,
): Promise<void> {
  if (!absPath.endsWith('.jsonl')) return;
  ensureIndex();

  if (event === 'unlink') {
    const prior = manifest!.perFile[absPath];
    if (prior) {
      if (index!.has(prior.id)) index!.discard(prior.id);
      delete manifest!.perFile[absPath];
      schedulePersist();
    }
    return;
  }

  if (!meta) return;

  try {
    const doc = await extractCodexSearchDoc(meta, absPath);
    const st = statSync(absPath);
    const prior = manifest!.perFile[absPath];
    if (prior && index!.has(prior.id)) index!.discard(prior.id);
    if (index!.has(doc.id)) index!.discard(doc.id);
    if (doc.text.length > 0) index!.add(doc);
    manifest!.perFile[absPath] = { mtimeMs: st.mtimeMs, size: st.size, id: doc.id };
    schedulePersist();
  } catch (err) {
    logger.debug(`search onCodexFileEvent skip ${absPath}: ${err}`);
  }
}

/**
 * Search sessions / 搜索会话
 */
export function search(
  query: string,
  options?: {
    projectId?: string;
    from?: string;
    to?: string;
    limit?: number;
  },
): SearchResult[] {
  if (!index) return [];

  const limit = options?.limit || 50;

  let results = index.search(query, {
    filter: (result) => {
      const doc = result as unknown as SearchDocument;
      if (options?.projectId && doc.projectId !== options.projectId) return false;
      if (options?.from && doc.timestamp < options.from) return false;
      if (options?.to && doc.timestamp > options.to) return false;
      return true;
    },
  });

  results = results.slice(0, limit);

  return results.map((r) => {
    const doc = r as unknown as SearchDocument;
    const queryLower = query.toLowerCase();
    const textLower = (doc.text || '').toLowerCase();
    const matchIdx = textLower.indexOf(queryLower);
    const snippetStart = Math.max(0, matchIdx - 60);
    const snippetEnd = Math.min((doc.text || '').length, matchIdx + query.length + 60);
    const snippet = matchIdx >= 0
      ? '...' + (doc.text || '').slice(snippetStart, snippetEnd) + '...'
      : (doc.summary || '').slice(0, 120);

    return {
      projectId: doc.projectId,
      projectName: doc.projectName,
      sessionId: doc.sessionId,
      summary: doc.summary,
      timestamp: doc.timestamp,
      score: r.score,
      matchSnippet: snippet,
      // Fallback to 'claude' for docs from a pre-source index / 旧索引无 source 时回退
      source: doc.source === 'codex' ? 'codex' : 'claude',
    };
  });
}

/**
 * Whether the index is currently loaded.
 * Replaces the legacy 5-min TTL check; refresh is now event-driven.
 * 仅判断索引是否已加载——TTL 已弃用，刷新走事件驱动
 */
export function isReady(): boolean {
  return index !== null;
}

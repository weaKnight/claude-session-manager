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

const SCHEMA_VERSION = 1;

interface SearchDocument {
  id: string;           // projectId/sessionId
  projectId: string;
  projectName: string;
  sessionId: string;
  text: string;
  timestamp: string;
  summary: string;
}

export interface SearchResult {
  projectId: string;
  projectName: string;
  sessionId: string;
  summary: string;
  timestamp: string;
  score: number;
  matchSnippet: string;
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
  storeFields: ['projectId', 'projectName', 'sessionId', 'summary', 'timestamp'] as string[],
  searchOptions: {
    boost: { summary: 2, projectName: 1.5 },
    fuzzy: 0.2,
    prefix: true,
  },
};

let index: MiniSearch<SearchDocument> | null = null;
let manifest: IndexManifest | null = null;
let isBuilding = false;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDeadline = 0;            // ms epoch — earliest time we'll let the timer push further
const PERSIST_DEBOUNCE_MS = 30_000; // settle window for bursts
const PERSIST_MAX_WAIT_MS = 60_000; // hard cap so a chatty session still flushes

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
 * Atomically write the in-memory index to disk.
 * 原子化把内存索引落盘
 */
export async function persistIndex(): Promise<void> {
  if (!index || !manifest || !dirty) return;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }

  const indexFile = cachePaths.searchIndexFile();
  const manifestFile = cachePaths.searchManifestFile();
  const indexTmp = `${indexFile}.tmp.${process.pid}`;
  const manifestTmp = `${manifestFile}.tmp.${process.pid}`;

  try {
    await fsp.mkdir(dirname(indexFile), { recursive: true });
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

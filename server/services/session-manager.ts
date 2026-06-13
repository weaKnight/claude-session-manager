/**
 * Session manager service / 会话管理服务
 * Scans ~/.claude/projects/ and provides session CRUD operations
 * 扫描 ~/.claude/projects/ 并提供会话 CRUD 操作
 */

import { readdirSync, existsSync, renameSync, unlinkSync, statSync, copyFileSync, mkdirSync } from 'fs';
import { join, basename, dirname, resolve, sep } from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import {
  parseSessionFile,
  parseSessionSlice,
  extractCommands,
  getProjectDisplayName,
} from '../parser/jsonl-reader.js';
import {
  parseCodexSessionFile,
  parseCodexSessionSlice,
} from '../parser/codex-reader.js';
import type { ParsedMessage } from '../parser/message-types.js';
import {
  getOrParseMeta,
  saveProjectIndex,
  evictSession,
  evictProject,
} from './meta-cache.js';
import {
  codexEnabled,
  listCodexProjects,
  listCodexSessions,
  resolveCodexPath,
  getCodexSessionMeta,
  invalidateCodexFile,
} from './codex-index.js';
import {
  writeTrashMetaEntry,
  removeTrashMetaEntries,
  getTrashMetaEntry,
} from './trash-meta.js';
import { loadOffsetIndex, findAnchor } from './offset-cache.js';
import { classifySession } from './invalid-detector.js';
import type { InvalidCriteria, InvalidReason } from './invalid-detector.js';
import type { ProjectInfo, SessionMeta, ParsedSession, AuditCommand, SessionSource } from '../parser/message-types.js';

/**
 * Get the projects directory path / 获取项目目录路径
 */
function getProjectsDir(): string {
  return join(config.claudeDir, 'projects');
}

/**
 * Validate session/project ID format (security: prevent path traversal)
 * 验证会话/项目 ID 格式（安全：防止路径遍历）
 */
function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(id);
}

/**
 * Security: assert that `target` resolves to a location at or under `root`.
 * Both are normalized with path.resolve; allows `target === root` or any child
 * under `root + sep`. Used by restore to prevent writing files outside the
 * source-specific whitelist root (path traversal via a tampered sidecar).
 * 安全：断言 target 规范化后位于 root 之内（含 root 本身），防止经被篡改的 sidecar
 * 把文件写到白名单根目录之外（路径穿越）。
 */
function isPathWithin(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

/**
 * A session's source + resolved absolute file path.
 * 会话来源 + 解析出的绝对文件路径
 */
interface LocatedSession {
  source: SessionSource;
  filePath: string;
}

/**
 * Resolve a (projectId, sessionId) to its source and file path. Tries the
 * Claude layout first (claudeDir/projects/<projectId>/<sessionId>.jsonl); if no
 * such file exists, falls back to the Codex index (date-tree → cwd grouping).
 * Throws when neither resolves.
 * 解析会话来源与路径：先查 Claude 布局，未命中再查 Codex 索引；都没有则抛错。
 */
async function locateSession(projectId: string, sessionId: string): Promise<LocatedSession> {
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    throw new Error('Invalid ID / 无效 ID');
  }
  const claudePath = join(getProjectsDir(), projectId, `${sessionId}.jsonl`);
  if (existsSync(claudePath)) {
    return { source: 'claude', filePath: claudePath };
  }
  if (codexEnabled()) {
    const codexPath = await resolveCodexPath(sessionId);
    if (codexPath) return { source: 'codex', filePath: codexPath };
  }
  throw new Error('Session not found / 会话不存在');
}

/**
 * List all projects / 列出所有项目
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) {
    logger.warn(`Projects directory not found: ${projectsDir}`);
    return [];
  }

  const entries = readdirSync(projectsDir, { withFileTypes: true });
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = join(projectsDir, entry.name);
    const jsonlFiles = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) continue;

    // Find most recent file / 查找最近的文件
    let lastActivity = '';
    for (const file of jsonlFiles) {
      try {
        const stat = statSync(join(dirPath, file));
        const mtime = stat.mtime.toISOString();
        if (!lastActivity || mtime > lastActivity) lastActivity = mtime;
      } catch { /* skip */ }
    }

    projects.push({
      encodedPath: entry.name,
      decodedPath: entry.name.replace(/^-/, '/').replace(/-/g, '/'),
      displayName: getProjectDisplayName(entry.name),
      sessionCount: jsonlFiles.length,
      lastActivity,
      sources: ['claude'],
    });
  }

  // Merge Codex-derived projects (grouped by encoded cwd). Same encodedPath →
  // merge counts and union the sources so the UI can badge mixed projects.
  // 合并 Codex 项目（按编码 cwd 分组）；同名项目合并计数并取来源并集
  if (codexEnabled()) {
    try {
      const codexProjects = await listCodexProjects();
      const byPath = new Map(projects.map((p) => [p.encodedPath, p]));
      for (const cp of codexProjects) {
        const existing = byPath.get(cp.encodedPath);
        if (existing) {
          existing.sessionCount += cp.sessionCount;
          if (cp.lastActivity > existing.lastActivity) existing.lastActivity = cp.lastActivity;
          existing.sources = mergeSources(existing.sources, cp.sources);
        } else {
          projects.push(cp);
          byPath.set(cp.encodedPath, cp);
        }
      }
    } catch (err) {
      logger.warn(`Failed to merge Codex projects: ${err}`);
    }
  }

  // Sort by most recent activity / 按最近活动排序
  projects.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return projects;
}

/** Union two source lists, preserving order claude→codex. / 合并来源列表 */
function mergeSources(a?: SessionSource[], b?: SessionSource[]): SessionSource[] {
  const set = new Set<SessionSource>([...(a ?? []), ...(b ?? [])]);
  return (['claude', 'codex'] as SessionSource[]).filter((s) => set.has(s));
}

/**
 * List sessions for a project / 列出项目的所有会话
 */
export async function listSessions(projectId: string): Promise<SessionMeta[]> {
  if (!isValidId(projectId)) {
    throw new Error('Invalid project ID / 无效的项目 ID');
  }

  const projectDir = join(getProjectsDir(), projectId);
  const sessions: SessionMeta[] = [];

  // Claude sessions (if a project directory exists) / Claude 会话（若目录存在）
  if (existsSync(projectDir)) {
    const jsonlFiles = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const filePath = join(projectDir, file);
      const sessionId = file.replace(/\.jsonl$/, '');
      try {
        const meta = await getOrParseMeta(projectId, sessionId, filePath);
        sessions.push({ ...meta, source: 'claude' });
      } catch (err) {
        logger.error(`Failed to parse ${file}: ${err}`);
      }
    }
    // Persist any newly parsed entries (no-op when cache was warm)
    // 持久化新解析的条目（缓存命中时为空操作）
    await saveProjectIndex(projectId).catch(() => { /* logged inside */ });
  }

  // Codex sessions for the same encoded-cwd project / 同一 cwd 项目下的 Codex 会话
  if (codexEnabled()) {
    try {
      const codexSessions = await listCodexSessions(projectId);
      sessions.push(...codexSessions);
    } catch (err) {
      logger.warn(`Failed to list Codex sessions for ${projectId}: ${err}`);
    }
  }

  // Neither source has this project / 两个来源都没有该项目
  if (sessions.length === 0 && !existsSync(projectDir)) {
    throw new Error('Project not found / 项目不存在');
  }

  // Sort by most recent / 按时间倒序
  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  return sessions;
}

/**
 * A session matched by scanInvalidSessions / scanInvalidSessions 命中的会话
 */
export interface InvalidSessionHit {
  id: string;
  summary?: string;
  messageCount: number;
  userMessageCount: number;
  lastTimestamp: string;
  fileSize: number;
  isAgent: boolean;
  reasons: InvalidReason[];
}

/**
 * Scan a project for "invalid" sessions per the given criteria.
 * Reuses the cached SessionMeta list and the pure classifySession rules.
 * 按给定 criteria 扫描项目内的"无效"会话；复用缓存的 SessionMeta + 纯判定函数
 */
export async function scanInvalidSessions(
  projectId: string,
  criteria: InvalidCriteria,
): Promise<InvalidSessionHit[]> {
  if (!isValidId(projectId)) {
    throw new Error('Invalid project ID / 无效的项目 ID');
  }

  const sessions = await listSessions(projectId);
  const hits: InvalidSessionHit[] = [];

  for (const meta of sessions) {
    const reasons = classifySession(meta, criteria);
    if (reasons.length === 0) continue;
    hits.push({
      id: meta.id,
      summary: meta.summary,
      messageCount: meta.messageCount,
      userMessageCount: meta.userMessageCount,
      lastTimestamp: meta.lastTimestamp,
      fileSize: meta.fileSize,
      isAgent: meta.isAgent,
      reasons,
    });
  }

  return hits;
}

/** Defensive cap on how many sessions one batch call may touch / 单次批量操作的上限 */
const MAX_BATCH_SESSIONS = 5000;

/**
 * Batch soft/hard-delete sessions. Each id is deleted independently and its
 * per-item result is collected; `deleted` is the count of successes.
 * readOnly is enforced by the underlying soft/hardDeleteSession.
 * 批量软/硬删除会话；逐条独立处理并收集结果，deleted 为成功条数；只读由底层拦截
 */
export async function batchDeleteSessions(
  projectId: string,
  sessionIds: string[],
  force: boolean,
): Promise<{ deleted: number; results: Array<{ sessionId: string; success: boolean; error?: string }> }> {
  const results: Array<{ sessionId: string; success: boolean; error?: string }> = [];

  // Basic input validation / 入参基本校验
  if (!Array.isArray(sessionIds)) {
    return { deleted: 0, results };
  }
  if (sessionIds.length > MAX_BATCH_SESSIONS) {
    return {
      deleted: 0,
      results: [{ sessionId: '', success: false, error: 'Too many sessions / 会话数量超过上限' }],
    };
  }

  let deleted = 0;
  for (const sessionId of sessionIds) {
    const result = force
      ? await hardDeleteSession(projectId, sessionId)
      : await softDeleteSession(projectId, sessionId);
    if (result.success) deleted++;
    results.push({ sessionId, success: result.success, error: result.error });
  }

  return { deleted, results };
}

/**
 * Get session metadata only (no message body).
 * 仅获取会话元数据
 */
export async function getSessionMeta(projectId: string, sessionId: string): Promise<SessionMeta> {
  const { source, filePath } = await locateSession(projectId, sessionId);
  if (source === 'codex') {
    return (await getCodexSessionMeta(sessionId)) ?? (await parseCodexSessionFile(filePath)).meta;
  }
  return { ...(await getOrParseMeta(projectId, sessionId, filePath)), source: 'claude' };
}

/**
 * Get a sliced range of messages.
 *
 * When `afterUuid` is provided, look up the byte-offset sidecar for an exact
 * anchor match and pass that to the parser as `seekFromByte`. Anchors are
 * placed every 100 messages by parseSessionMeta, so default-page cursors
 * (every 200) land on anchors and turn O(file) scans into O(slice).
 * 用 offset sidecar 把 cursor 命中转为直接 seek，避免大文件全扫
 */
export async function getSessionMessages(
  projectId: string,
  sessionId: string,
  opts: { afterUuid?: string; limit: number },
): Promise<{ messages: ParsedMessage[]; nextCursor: string | null }> {
  const { source, filePath } = await locateSession(projectId, sessionId);

  let seekFromByte: number | undefined;
  if (opts.afterUuid) {
    try {
      const st = statSync(filePath);
      const offsets = await loadOffsetIndex(projectId, sessionId, st.mtimeMs, st.size);
      if (offsets) {
        const anchor = findAnchor(offsets, opts.afterUuid);
        if (anchor) seekFromByte = anchor.byteOffset;
      }
    } catch {
      // Fall back to filehead scan / 失败则回退全扫
    }
  }

  return source === 'codex'
    ? parseCodexSessionSlice(filePath, { ...opts, seekFromByte })
    : parseSessionSlice(filePath, { ...opts, seekFromByte });
}

/**
 * File-stat-based identity for ETag/Last-Modified responses.
 * 用于 ETag/Last-Modified 的 stat 信息
 */
export async function getSessionStat(
  projectId: string,
  sessionId: string,
): Promise<{ mtimeMs: number; size: number }> {
  const { filePath } = await locateSession(projectId, sessionId);
  const st = statSync(filePath);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * Backwards-compatible full-session loader. Returns the entire message list.
 * Prefer getSessionMeta + getSessionMessages for paginated access.
 * 兼容旧客户端的全量加载；新客户端请改用切片接口
 */
export async function getSession(projectId: string, sessionId: string): Promise<ParsedSession> {
  const { source, filePath } = await locateSession(projectId, sessionId);
  return source === 'codex' ? parseCodexSessionFile(filePath) : parseSessionFile(filePath);
}

/**
 * Default page size for the session detail endpoint.
 * 详情接口默认页大小
 */
export const DEFAULT_MESSAGE_PAGE = 200;

/**
 * Sliced session detail: meta + first page of messages + nextCursor.
 * 切片版会话详情：元数据 + 首页消息 + nextCursor
 */
export async function getSessionPage(
  projectId: string,
  sessionId: string,
  limit = DEFAULT_MESSAGE_PAGE,
): Promise<{ meta: SessionMeta; messages: ParsedMessage[]; nextCursor: string | null }> {
  const { source, filePath } = await locateSession(projectId, sessionId);
  if (source === 'codex') {
    const meta = (await getCodexSessionMeta(sessionId)) ?? (await parseCodexSessionFile(filePath)).meta;
    const slice = await parseCodexSessionSlice(filePath, { limit });
    return { meta, messages: slice.messages, nextCursor: slice.nextCursor };
  }
  const meta = { ...(await getOrParseMeta(projectId, sessionId, filePath)), source: 'claude' as const };
  const slice = await parseSessionSlice(filePath, { limit });
  return { meta, messages: slice.messages, nextCursor: slice.nextCursor };
}

/**
 * Get audit commands for a session / 获取会话的审计命令
 */
export async function getSessionCommands(
  projectId: string,
  sessionId: string
): Promise<AuditCommand[]> {
  const session = await getSession(projectId, sessionId);
  return extractCommands(sessionId, session.messages);
}

/**
 * Soft-delete session (move to trash) / 软删除会话（移入回收站）
 */
export async function softDeleteSession(
  projectId: string,
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  if (config.readOnly) {
    return { success: false, error: 'Read-only mode / 只读模式' };
  }
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    return { success: false, error: 'Invalid ID / 无效 ID' };
  }

  // Resolve source + path via the shared locator (Claude layout, then Codex).
  // 用统一定位器取来源与路径（先 Claude 布局，再 Codex）。
  let located: LocatedSession;
  try {
    located = await locateSession(projectId, sessionId);
  } catch {
    return { success: false, error: 'Session not found / 会话不存在' };
  }
  const { source, filePath } = located;

  const deletedAt = Date.now();
  const trashFileName = `${projectId}__${sessionId}__${deletedAt}.jsonl`;
  const trashPath = join(config.trashDir, trashFileName);
  try {
    // Try rename first (same filesystem), fall back to copy (cross-fs or read-only source)
    // 先尝试 rename（同文件系统），失败则 copy（跨文件系统或只读源）
    try {
      renameSync(filePath, trashPath);
    } catch {
      // Cross-filesystem or read-only mount: copy to trash, then try to remove source
      // 跨文件系统或只读挂载：复制到回收站，再尝试删除源文件
      copyFileSync(filePath, trashPath);
      try {
        unlinkSync(filePath);
      } catch {
        // Source is read-only (e.g. Docker :ro mount) — file stays but is tracked in trash
        // 源为只读（如 Docker :ro 挂载）— 文件保留但已记录在回收站
        logger.info(`Source is read-only, session copied to trash but original preserved: ${sessionId}`);
      }
    }

    // Record provenance so restore can return the file to its exact origin.
    // 记录来源信息，使 restore 能精确还原到原始位置。
    await writeTrashMetaEntry(trashFileName, {
      source,
      originalPath: filePath,
      projectId,
      sessionId,
      deletedAt,
    });

    if (source === 'codex') {
      invalidateCodexFile(filePath);
    } else {
      evictSession(projectId, sessionId);
      saveProjectIndex(projectId).catch(() => { /* best effort */ });
    }
    logger.info(`Session soft-deleted: ${sessionId} (${source}) -> trash`);
    return { success: true };
  } catch (err) {
    logger.error(`Failed to delete session: ${err}`);
    return { success: false, error: 'Delete failed / 删除失败' };
  }
}

/**
 * Hard-delete session (permanent) / 硬删除会话（永久删除）
 */
export async function hardDeleteSession(
  projectId: string,
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  if (config.readOnly) {
    return { success: false, error: 'Read-only mode / 只读模式' };
  }
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    return { success: false, error: 'Invalid ID / 无效 ID' };
  }

  let located: LocatedSession;
  try {
    located = await locateSession(projectId, sessionId);
  } catch {
    return { success: false, error: 'Session not found / 会话不存在' };
  }
  const { source, filePath } = located;

  try {
    unlinkSync(filePath);
    if (source === 'codex') {
      invalidateCodexFile(filePath);
    } else {
      evictSession(projectId, sessionId);
      saveProjectIndex(projectId).catch(() => { /* best effort */ });
    }
    logger.info(`Session permanently deleted: ${sessionId} (${source})`);
    return { success: true };
  } catch (err) {
    // Read-only mount: cannot delete source file / 只读挂载：无法删除源文件
    logger.error(`Failed to hard-delete session (source may be read-only): ${err}`);
    return { success: false, error: 'Cannot delete: source is read-only / 无法删除：源文件只读' };
  }
}

/**
 * Trash item info / 回收站条目信息
 */
export interface TrashItem {
  fileName: string;
  projectId: string;
  sessionId: string;
  deletedAt: number;
  fileSize: number;
  // Origin of the deleted session (sidecar-backed; defaults to 'claude').
  // 被删会话的来源（来自 sidecar，缺失默认 'claude'）。
  source: SessionSource;
}

/**
 * List all items in trash / 列出回收站中的所有条目
 */
export async function listTrash(): Promise<TrashItem[]> {
  if (!existsSync(config.trashDir)) return [];

  const files = readdirSync(config.trashDir).filter((f) => f.endsWith('.jsonl'));
  const items: TrashItem[] = [];

  for (const file of files) {
    // Format: {projectId}__{sessionId}__{timestamp}.jsonl
    // 格式：{projectId}__{sessionId}__{timestamp}.jsonl
    const match = file.match(/^(.+?)__(.+?)__(\d+)\.jsonl$/);
    if (!match) continue;

    const [, projectId, sessionId, ts] = match;
    try {
      const stat = statSync(join(config.trashDir, file));
      // Source from sidecar; legacy entries with no sidecar default to claude.
      // 来源取自 sidecar；无 sidecar 的旧条目默认 claude。
      const entry = await getTrashMetaEntry(file);
      items.push({
        fileName: file,
        projectId,
        sessionId,
        deletedAt: Number(ts),
        fileSize: stat.size,
        source: entry?.source ?? 'claude',
      });
    } catch { /* skip */ }
  }

  // Sort by most recently deleted / 按删除时间倒序
  items.sort((a, b) => b.deletedAt - a.deletedAt);
  return items;
}

/**
 * Restore a session from trash / 从回收站恢复会话
 */
export async function restoreSession(fileName: string): Promise<{ success: boolean; error?: string }> {
  if (config.readOnly) {
    return { success: false, error: 'Read-only mode / 只读模式' };
  }

  // Guard against path traversal: the name must be a bare basename.
  // 防路径穿越：必须是纯 basename（不含目录分隔）。
  if (basename(fileName) !== fileName) {
    return { success: false, error: 'Invalid trash item / 无效的回收站条目' };
  }

  // Validate filename format / 验证文件名格式
  const match = fileName.match(/^(.+?)__(.+?)__(\d+)\.jsonl$/);
  if (!match) {
    return { success: false, error: 'Invalid trash item / 无效的回收站条目' };
  }

  const [, projectId, sessionId] = match;
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    return { success: false, error: 'Invalid ID / 无效 ID' };
  }

  const trashPath = join(config.trashDir, fileName);
  if (!existsSync(trashPath)) {
    return { success: false, error: 'Trash item not found / 回收站条目不存在' };
  }

  // Sidecar drives source-aware restore; absent → legacy Claude trash.
  // sidecar 决定 source-aware 还原；缺失即旧 Claude trash。
  const entry = await getTrashMetaEntry(fileName);

  // Resolve target path + the source-specific whitelist root.
  // 解析目标路径与对应来源的白名单根目录。
  let targetPath: string;
  let allowedRoot: string;
  let source: SessionSource;
  if (entry) {
    source = entry.source;
    targetPath = entry.originalPath;
    allowedRoot = entry.source === 'codex'
      ? resolve(join(config.codexDir, 'sessions'))
      : resolve(join(config.claudeDir, 'projects'));
  } else {
    // Backward-compat: legacy Claude trash → projects/<projectId>/<sessionId>.jsonl
    // 向后兼容：旧 Claude trash → projects/<projectId>/<sessionId>.jsonl
    source = 'claude';
    targetPath = join(getProjectsDir(), projectId, `${sessionId}.jsonl`);
    allowedRoot = resolve(join(config.claudeDir, 'projects'));
  }

  // Security: refuse any target outside the source-specific whitelist root.
  // 安全：拒绝任何位于白名单根目录之外的目标路径。
  if (!isPathWithin(allowedRoot, targetPath)) {
    logger.error(`restore rejected: target outside whitelist root: ${targetPath}`);
    return { success: false, error: 'Restore target out of bounds / 还原目标越界' };
  }

  // Never overwrite an existing file / 不得覆盖已存在的目标文件
  if (existsSync(targetPath)) {
    return { success: false, error: 'Session already exists at target / 目标位置已存在该会话' };
  }

  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    // Move with rename → copy+unlink fallback (cross-fs / read-only trash).
    // 移动：rename → copy+unlink 回退（跨文件系统 / 只读回收站）。
    try {
      renameSync(trashPath, targetPath);
    } catch {
      copyFileSync(trashPath, targetPath);
      try {
        unlinkSync(trashPath);
      } catch {
        logger.info(`Trash file could not be removed after restore (left in place): ${fileName}`);
      }
    }

    await removeTrashMetaEntries([fileName]);
    if (source === 'codex') {
      invalidateCodexFile(targetPath);
    }
    logger.info(`Session restored: ${sessionId} (${source}) <- trash`);
    return { success: true };
  } catch (err) {
    logger.error(`Failed to restore session: ${err}`);
    return { success: false, error: 'Restore failed / 恢复失败' };
  }
}

/**
 * Empty entire trash / 清空回收站
 */
export async function emptyTrash(): Promise<{ success: boolean; deleted: number; error?: string }> {
  if (config.readOnly) {
    return { success: false, deleted: 0, error: 'Read-only mode / 只读模式' };
  }

  if (!existsSync(config.trashDir)) {
    return { success: true, deleted: 0 };
  }

  // readdir filtered to .jsonl already excludes the .trash-meta.json sidecar.
  // 过滤 .jsonl 已天然排除 .trash-meta.json sidecar。
  const files = readdirSync(config.trashDir).filter((f) => f.endsWith('.jsonl'));
  let deleted = 0;
  const removedNames: string[] = [];

  for (const file of files) {
    try {
      unlinkSync(join(config.trashDir, file));
      deleted++;
      removedNames.push(file);
    } catch (err) {
      logger.error(`Failed to delete trash item ${file}: ${err}`);
    }
  }

  // Drop sidecar entries for the files we removed / 同步清理 sidecar 条目
  await removeTrashMetaEntries(removedNames);

  logger.info(`Trash emptied: ${deleted} items`);
  return { success: true, deleted };
}

/** Defensive cap on trash batch size / 回收站批量上限 */
const MAX_BATCH_TRASH = 5000;

/**
 * Permanently delete specific trash items by file name.
 * Each name must match the trash naming pattern and resolve to a file that
 * actually lives directly under config.trashDir — no path traversal allowed.
 * 按文件名永久删除指定回收站条目；每个名字须匹配命名规则且确实位于
 * config.trashDir 下,严禁路径穿越。
 */
export async function deleteTrashItems(
  fileNames: string[],
): Promise<{ deleted: number; results: Array<{ fileName: string; success: boolean; error?: string }> }> {
  const results: Array<{ fileName: string; success: boolean; error?: string }> = [];
  const removedNames: string[] = [];

  if (config.readOnly) {
    return {
      deleted: 0,
      results: [{ fileName: '', success: false, error: 'Read-only mode / 只读模式' }],
    };
  }

  // Basic input validation / 入参基本校验
  if (!Array.isArray(fileNames)) {
    return { deleted: 0, results };
  }
  if (fileNames.length > MAX_BATCH_TRASH) {
    return {
      deleted: 0,
      results: [{ fileName: '', success: false, error: 'Too many items / 条目数量超过上限' }],
    };
  }

  let deleted = 0;
  for (const fileName of fileNames) {
    // Validate trash naming pattern: {projectId}__{sessionId}__{timestamp}.jsonl
    // 校验回收站命名格式
    const match = typeof fileName === 'string' && fileName.match(/^(.+?)__(.+?)__(\d+)\.jsonl$/);
    if (!match) {
      results.push({ fileName, success: false, error: 'Invalid trash item / 无效的回收站条目' });
      continue;
    }

    // Guard against path traversal: the name must be a bare basename.
    // 防路径穿越：必须是纯 basename(不含目录分隔)
    if (basename(fileName) !== fileName) {
      results.push({ fileName, success: false, error: 'Invalid trash item / 无效的回收站条目' });
      continue;
    }

    const trashPath = join(config.trashDir, fileName);
    if (!existsSync(trashPath)) {
      results.push({ fileName, success: false, error: 'Trash item not found / 回收站条目不存在' });
      continue;
    }

    try {
      unlinkSync(trashPath);
      deleted++;
      removedNames.push(fileName);
      results.push({ fileName, success: true });
    } catch (err) {
      logger.error(`Failed to delete trash item ${fileName}: ${err}`);
      results.push({ fileName, success: false, error: 'Delete failed / 删除失败' });
    }
  }

  // Drop sidecar entries for the files we actually removed / 同步清理 sidecar 条目
  await removeTrashMetaEntries(removedNames);

  logger.info(`Trash items deleted: ${deleted}/${fileNames.length}`);
  return { deleted, results };
}

/**
 * Invalidate cache for an entire project (project-level events).
 * 项目级失效——丢弃整个项目的内存与磁盘索引
 */
export function invalidateProjectCache(projectId: string): void {
  evictProject(projectId);
}

/**
 * Invalidate the cache entry for a single session (file-level events).
 * 单会话失效——文件变更/删除事件调用
 */
export function invalidateSessionCache(projectId: string, sessionId: string): void {
  evictSession(projectId, sessionId);
  saveProjectIndex(projectId).catch(() => { /* best effort */ });
}

/**
 * Get global stats / 获取全局统计
 */
export async function getStats(): Promise<Record<string, unknown>> {
  const projects = await listProjects();
  let totalSessions = 0;
  let totalMessages = 0;

  for (const p of projects) {
    totalSessions += p.sessionCount;
  }

  // Try to read stats-cache.json / 尝试读取 stats-cache.json
  const statsFile = join(config.claudeDir, 'stats-cache.json');
  let nativeStats: Record<string, unknown> = {};
  if (existsSync(statsFile)) {
    try {
      nativeStats = JSON.parse(
        (await import('fs')).readFileSync(statsFile, 'utf-8')
      ) as Record<string, unknown>;
      totalMessages = (nativeStats.totalMessages as number) || 0;
    } catch { /* ignore */ }
  }

  return {
    projectCount: projects.length,
    totalSessions,
    totalMessages,
    nativeStats,
  };
}

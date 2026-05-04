/**
 * Session manager service / 会话管理服务
 * Scans ~/.claude/projects/ and provides session CRUD operations
 * 扫描 ~/.claude/projects/ 并提供会话 CRUD 操作
 */

import { readdirSync, existsSync, renameSync, unlinkSync, statSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import {
  parseSessionFile,
  parseSessionSlice,
  extractCommands,
  getProjectDisplayName,
} from '../parser/jsonl-reader.js';
import type { ParsedMessage } from '../parser/message-types.js';
import {
  getOrParseMeta,
  saveProjectIndex,
  evictSession,
  evictProject,
} from './meta-cache.js';
import { loadOffsetIndex, findAnchor } from './offset-cache.js';
import type { ProjectInfo, SessionMeta, ParsedSession, AuditCommand } from '../parser/message-types.js';

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
    });
  }

  // Sort by most recent activity / 按最近活动排序
  projects.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return projects;
}

/**
 * List sessions for a project / 列出项目的所有会话
 */
export async function listSessions(projectId: string): Promise<SessionMeta[]> {
  if (!isValidId(projectId)) {
    throw new Error('Invalid project ID / 无效的项目 ID');
  }

  const projectDir = join(getProjectsDir(), projectId);
  if (!existsSync(projectDir)) {
    throw new Error('Project not found / 项目不存在');
  }

  const jsonlFiles = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  const sessions: SessionMeta[] = [];

  for (const file of jsonlFiles) {
    const filePath = join(projectDir, file);
    const sessionId = file.replace(/\.jsonl$/, '');
    try {
      const meta = await getOrParseMeta(projectId, sessionId, filePath);
      sessions.push(meta);
    } catch (err) {
      logger.error(`Failed to parse ${file}: ${err}`);
    }
  }

  // Persist any newly parsed entries (no-op when cache was warm)
  // 持久化新解析的条目（缓存命中时为空操作）
  await saveProjectIndex(projectId).catch(() => { /* logged inside */ });

  // Sort by most recent / 按时间倒序
  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  return sessions;
}

/**
 * Resolve a session's absolute file path after validating IDs.
 * 校验 ID 后解析会话绝对路径
 */
function resolveSessionPath(projectId: string, sessionId: string): string {
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    throw new Error('Invalid ID / 无效 ID');
  }
  const filePath = join(getProjectsDir(), projectId, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) {
    throw new Error('Session not found / 会话不存在');
  }
  return filePath;
}

/**
 * Get session metadata only (no message body).
 * 仅获取会话元数据
 */
export async function getSessionMeta(projectId: string, sessionId: string): Promise<SessionMeta> {
  const filePath = resolveSessionPath(projectId, sessionId);
  return getOrParseMeta(projectId, sessionId, filePath);
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
  const filePath = resolveSessionPath(projectId, sessionId);

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

  return parseSessionSlice(filePath, { ...opts, seekFromByte });
}

/**
 * File-stat-based identity for ETag/Last-Modified responses.
 * 用于 ETag/Last-Modified 的 stat 信息
 */
export function getSessionStat(
  projectId: string,
  sessionId: string,
): { mtimeMs: number; size: number } {
  const filePath = resolveSessionPath(projectId, sessionId);
  const st = statSync(filePath);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * Backwards-compatible full-session loader. Returns the entire message list.
 * Prefer getSessionMeta + getSessionMessages for paginated access.
 * 兼容旧客户端的全量加载；新客户端请改用切片接口
 */
export async function getSession(projectId: string, sessionId: string): Promise<ParsedSession> {
  const filePath = resolveSessionPath(projectId, sessionId);
  return parseSessionFile(filePath);
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
  const filePath = resolveSessionPath(projectId, sessionId);
  const meta = await getOrParseMeta(projectId, sessionId, filePath);
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
export function softDeleteSession(projectId: string, sessionId: string): { success: boolean; error?: string } {
  if (config.readOnly) {
    return { success: false, error: 'Read-only mode / 只读模式' };
  }
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    return { success: false, error: 'Invalid ID / 无效 ID' };
  }

  const filePath = join(getProjectsDir(), projectId, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) {
    return { success: false, error: 'Session not found / 会话不存在' };
  }

  const trashPath = join(config.trashDir, `${projectId}__${sessionId}__${Date.now()}.jsonl`);
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
    evictSession(projectId, sessionId);
    saveProjectIndex(projectId).catch(() => { /* best effort */ });
    logger.info(`Session soft-deleted: ${sessionId} -> trash`);
    return { success: true };
  } catch (err) {
    logger.error(`Failed to delete session: ${err}`);
    return { success: false, error: 'Delete failed / 删除失败' };
  }
}

/**
 * Hard-delete session (permanent) / 硬删除会话（永久删除）
 */
export function hardDeleteSession(projectId: string, sessionId: string): { success: boolean; error?: string } {
  if (config.readOnly) {
    return { success: false, error: 'Read-only mode / 只读模式' };
  }
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    return { success: false, error: 'Invalid ID / 无效 ID' };
  }

  const filePath = join(getProjectsDir(), projectId, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) {
    return { success: false, error: 'Session not found / 会话不存在' };
  }

  try {
    unlinkSync(filePath);
    evictSession(projectId, sessionId);
    saveProjectIndex(projectId).catch(() => { /* best effort */ });
    logger.info(`Session permanently deleted: ${sessionId}`);
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
}

/**
 * List all items in trash / 列出回收站中的所有条目
 */
export function listTrash(): TrashItem[] {
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
      items.push({
        fileName: file,
        projectId,
        sessionId,
        deletedAt: Number(ts),
        fileSize: stat.size,
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
export function restoreSession(fileName: string): { success: boolean; error?: string } {
  if (config.readOnly) {
    return { success: false, error: 'Read-only mode / 只读模式' };
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

  const projectDir = join(getProjectsDir(), projectId);
  const targetPath = join(projectDir, `${sessionId}.jsonl`);

  // Check if session already exists at target / 检查目标位置是否已存在
  if (existsSync(targetPath)) {
    return { success: false, error: 'Session already exists at target / 目标位置已存在该会话' };
  }

  try {
    renameSync(trashPath, targetPath);
    logger.info(`Session restored: ${sessionId} <- trash`);
    return { success: true };
  } catch (err) {
    logger.error(`Failed to restore session: ${err}`);
    return { success: false, error: 'Restore failed / 恢复失败' };
  }
}

/**
 * Empty entire trash / 清空回收站
 */
export function emptyTrash(): { success: boolean; deleted: number; error?: string } {
  if (config.readOnly) {
    return { success: false, deleted: 0, error: 'Read-only mode / 只读模式' };
  }

  if (!existsSync(config.trashDir)) {
    return { success: true, deleted: 0 };
  }

  const files = readdirSync(config.trashDir).filter((f) => f.endsWith('.jsonl'));
  let deleted = 0;

  for (const file of files) {
    try {
      unlinkSync(join(config.trashDir, file));
      deleted++;
    } catch (err) {
      logger.error(`Failed to delete trash item ${file}: ${err}`);
    }
  }

  logger.info(`Trash emptied: ${deleted} items`);
  return { success: true, deleted };
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

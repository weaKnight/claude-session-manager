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
  parseSessionMeta,
  parseSessionFile,
  extractCommands,
  getProjectDisplayName,
} from '../parser/jsonl-reader.js';
import type { ProjectInfo, SessionMeta, ParsedSession, AuditCommand } from '../parser/message-types.js';

// Cache for session metadata / 会话元数据缓存
const metaCache = new Map<string, SessionMeta>();
let lastScanTime = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds / 30 秒

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

  const needsRefresh = Date.now() - lastScanTime > CACHE_TTL_MS;

  for (const file of jsonlFiles) {
    const filePath = join(projectDir, file);
    const cacheKey = filePath;

    // Use cache if available and fresh / 使用缓存（如果可用且新鲜）
    if (!needsRefresh && metaCache.has(cacheKey)) {
      sessions.push(metaCache.get(cacheKey)!);
      continue;
    }

    try {
      const meta = await parseSessionMeta(filePath);
      metaCache.set(cacheKey, meta);
      sessions.push(meta);
    } catch (err) {
      logger.error(`Failed to parse ${file}: ${err}`);
    }
  }

  if (needsRefresh) lastScanTime = Date.now();

  // Sort by most recent / 按时间倒序
  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  return sessions;
}

/**
 * Get full session detail with all messages / 获取完整会话（含所有消息）
 */
export async function getSession(projectId: string, sessionId: string): Promise<ParsedSession> {
  if (!isValidId(projectId) || !isValidId(sessionId)) {
    throw new Error('Invalid ID / 无效 ID');
  }

  const filePath = join(getProjectsDir(), projectId, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) {
    throw new Error('Session not found / 会话不存在');
  }

  return parseSessionFile(filePath);
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
    metaCache.delete(filePath);
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
    metaCache.delete(filePath);
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
 * Invalidate cache for a project (called on file change)
 * 使项目缓存失效（文件变更时调用）
 */
export function invalidateProjectCache(projectId: string): void {
  const prefix = join(getProjectsDir(), projectId);
  for (const key of metaCache.keys()) {
    if (key.startsWith(prefix)) {
      metaCache.delete(key);
    }
  }
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

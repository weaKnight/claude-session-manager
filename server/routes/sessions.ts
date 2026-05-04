/**
 * Projects & Sessions API routes / 项目与会话 API 路由
 */

import { Router } from 'express';
import {
  listProjects,
  listSessions,
  getSession,
  getSessionPage,
  getSessionMessages,
  getSessionStat,
  getSessionCommands,
  softDeleteSession,
  hardDeleteSession,
  getStats,
  listTrash,
  restoreSession,
  emptyTrash,
  DEFAULT_MESSAGE_PAGE,
} from '../services/session-manager.js';
import { etagFor, handleConditional } from '../utils/etag.js';

const router = Router();

// GET /api/v1/projects - List all projects / 列出所有项目
router.get('/projects', async (_req, res) => {
  try {
    const projects = await listProjects();
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: `Failed to list projects: ${err}` });
  }
});

// GET /api/v1/projects/:projectId/sessions - List sessions / 列出会话
router.get('/projects/:projectId/sessions', async (req, res) => {
  try {
    const sessions = await listSessions(req.params.projectId);
    res.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// GET /api/v1/sessions/:projectId/:sessionId - First page of messages + meta
// 默认返回首页消息（200 条）+ meta + nextCursor；?full=true 强制全量（兼容老客户端）
// 默认返回首页（200 条）+ meta + nextCursor；?full=true 走全量（兼容旧客户端）
router.get('/sessions/:projectId/:sessionId', async (req, res) => {
  try {
    const { projectId, sessionId } = req.params;

    // ETag short-circuit / ETag 304 短路
    try {
      const { mtimeMs, size } = getSessionStat(projectId, sessionId);
      const etag = etagFor(mtimeMs, size, 'page');
      if (handleConditional(req, res, etag, mtimeMs)) return;
    } catch { /* let main handler raise */ }

    if (req.query['full'] === 'true') {
      const session = await getSession(projectId, sessionId);
      res.json(session);
      return;
    }

    const limitRaw = req.query['limit'];
    const limit = typeof limitRaw === 'string'
      ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || DEFAULT_MESSAGE_PAGE))
      : DEFAULT_MESSAGE_PAGE;

    const page = await getSessionPage(projectId, sessionId, limit);
    res.json(page);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// GET /api/v1/sessions/:projectId/:sessionId/messages?after=<uuid>&limit=200
// 切片消息分页接口
router.get('/sessions/:projectId/:sessionId/messages', async (req, res) => {
  try {
    const { projectId, sessionId } = req.params;
    const after = typeof req.query['after'] === 'string' ? req.query['after'] : undefined;
    const limitRaw = req.query['limit'];
    const limit = typeof limitRaw === 'string'
      ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || DEFAULT_MESSAGE_PAGE))
      : DEFAULT_MESSAGE_PAGE;

    const slice = await getSessionMessages(projectId, sessionId, { afterUuid: after, limit });
    res.json(slice);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// GET /api/v1/sessions/:projectId/:sessionId/commands - Audit commands / 审计命令
router.get('/sessions/:projectId/:sessionId/commands', async (req, res) => {
  try {
    const { projectId, sessionId } = req.params;

    try {
      const { mtimeMs, size } = getSessionStat(projectId, sessionId);
      const etag = etagFor(mtimeMs, size, 'cmd');
      if (handleConditional(req, res, etag, mtimeMs)) return;
    } catch { /* fall through */ }

    const commands = await getSessionCommands(projectId, sessionId);
    res.json({ commands });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// DELETE /api/v1/sessions/:projectId/:sessionId - Soft delete / 软删除
router.delete('/sessions/:projectId/:sessionId', (req, res) => {
  const { force } = req.query;
  const { projectId, sessionId } = req.params;

  const result = force === 'true'
    ? hardDeleteSession(projectId, sessionId)
    : softDeleteSession(projectId, sessionId);

  if (result.success) {
    res.json({ success: true, method: force === 'true' ? 'hard' : 'soft' });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// GET /api/v1/trash - List trash items / 列出回收站条目
router.get('/trash', (_req, res) => {
  try {
    const items = listTrash();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: `Failed to list trash: ${err}` });
  }
});

// POST /api/v1/trash/restore - Restore from trash / 从回收站恢复
router.post('/trash/restore', (req, res) => {
  const { fileName } = req.body as { fileName?: string };
  if (!fileName) {
    res.status(400).json({ error: 'fileName is required / 缺少 fileName 参数' });
    return;
  }
  const result = restoreSession(fileName);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// DELETE /api/v1/trash - Empty trash / 清空回收站
router.delete('/trash', (_req, res) => {
  const result = emptyTrash();
  if (result.success) {
    res.json({ success: true, deleted: result.deleted });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// GET /api/v1/stats - Global statistics / 全局统计
router.get('/stats', async (_req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: `Failed to get stats: ${err}` });
  }
});

export default router;

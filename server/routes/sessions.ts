/**
 * Projects & Sessions API routes / 项目与会话 API 路由
 */

import { Router } from 'express';
import {
  listProjects,
  listSessions,
  getSession,
  getSessionCommands,
  softDeleteSession,
  hardDeleteSession,
  getStats,
  listTrash,
  restoreSession,
  emptyTrash,
} from '../services/session-manager.js';

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

// GET /api/v1/sessions/:projectId/:sessionId - Get full session / 获取完整会话
router.get('/sessions/:projectId/:sessionId', async (req, res) => {
  try {
    const session = await getSession(req.params.projectId, req.params.sessionId);
    res.json(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// GET /api/v1/sessions/:projectId/:sessionId/commands - Audit commands / 审计命令
router.get('/sessions/:projectId/:sessionId/commands', async (req, res) => {
  try {
    const commands = await getSessionCommands(req.params.projectId, req.params.sessionId);
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

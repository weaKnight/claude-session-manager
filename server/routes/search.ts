/**
 * Search API route / 搜索 API 路由
 */

import { Router } from 'express';
import { search, buildIndex, needsRebuild } from '../services/search-engine.js';

const router = Router();

// GET /api/v1/search?q=&project=&from=&to=&limit= - Full-text search / 全文搜索
router.get('/search', async (req, res) => {
  const q = req.query['q'] as string;
  if (!q || q.trim().length === 0) {
    res.status(400).json({ error: 'Query parameter "q" required / 需要查询参数 "q"' });
    return;
  }

  // Rebuild index if stale / 索引过期则重建
  if (needsRebuild()) {
    await buildIndex();
  }

  const results = search(q.trim(), {
    projectId: req.query['project'] as string | undefined,
    from: req.query['from'] as string | undefined,
    to: req.query['to'] as string | undefined,
    limit: req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : undefined,
  });

  res.json({ query: q, count: results.length, results });
});

// POST /api/v1/search/rebuild - Force rebuild index / 强制重建索引
router.post('/search/rebuild', async (_req, res) => {
  await buildIndex();
  res.json({ success: true, message: 'Index rebuilt / 索引已重建' });
});

export default router;

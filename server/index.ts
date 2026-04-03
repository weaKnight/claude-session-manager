/**
 * Claude Session Manager - Server Entry Point
 * Claude 会话管理器 - 服务器入口
 *
 * A web-based tool for browsing, searching, and auditing
 * Claude Code conversation history on headless Linux servers.
 * 一个基于 Web 的工具，用于在无桌面 Linux 服务器上
 * 浏览、搜索和审计 Claude Code 会话历史。
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'fs';
import { join } from 'path';

import { config } from './utils/config.js';
import { logger } from './utils/logger.js';
import { requireAuth } from './auth/middleware.js';
import { isSetupRequired } from './auth/service.js';
import { startWatcher, addSSEClient } from './services/file-watcher.js';
import { buildIndex } from './services/search-engine.js';

import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import searchRoutes from './routes/search.js';

const app = express();

// --- Security middleware / 安全中间件 ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      // Disable upgrade-insecure-requests for HTTP (LAN) access
      // 禁用 HTTPS 升级以支持内网 HTTP 访问
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(cors({ origin: false })); // Disable CORS in production / 生产环境禁用 CORS
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Global rate limit: 200 requests per minute / 全局速率限制：每分钟 200 请求
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests / 请求过多' },
}));

// Stricter rate limit for auth endpoints / 认证端点更严格的速率限制
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { error: 'Too many auth attempts / 认证尝试过多' },
});

// --- API Routes / API 路由 ---

// Auth routes (public, with rate limit) / 认证路由（公开，有速率限制）
app.use('/api/v1/auth', authLimiter, authRoutes);

// Protected routes / 受保护的路由
app.use('/api/v1', requireAuth, sessionRoutes);
app.use('/api/v1', requireAuth, searchRoutes);

// SSE endpoint for live updates / SSE 实时更新端点
app.get('/api/v1/events', requireAuth, (req, res) => {
  addSSEClient(res);
});

// --- Static file serving / 静态文件服务 ---

// Serve built frontend in production / 生产环境下提供构建后的前端
if (existsSync(config.clientDistPath)) {
  app.use(express.static(config.clientDistPath));

  // SPA fallback: serve index.html for all non-API routes
  // SPA 回退：所有非 API 路由返回 index.html
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found / 未找到' });
      return;
    }
    res.sendFile(join(config.clientDistPath, 'index.html'));
  });
} else {
  // Dev mode: show message / 开发模式：显示提示
  app.get('/', (_req, res) => {
    res.json({
      message: 'Claude Session Manager API',
      docs: 'Use "npm run dev" for development with hot reload',
      setupRequired: isSetupRequired(),
    });
  });
}

// --- Error handler / 错误处理 ---
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error / 服务器内部错误' });
});

// --- Start server / 启动服务器 ---

async function start(): Promise<void> {
  // Validate claude directory exists / 验证 claude 目录存在
  if (!existsSync(config.claudeDir)) {
    logger.error(`Claude directory not found: ${config.claudeDir}`);
    logger.error('Make sure Claude Code has been used on this machine.');
    logger.error('Or specify path: --claude-dir /path/to/.claude');
    process.exit(1);
  }

  const projectsDir = join(config.claudeDir, 'projects');
  if (!existsSync(projectsDir)) {
    logger.warn(`No projects directory found at ${projectsDir}`);
    logger.warn('Sessions will appear once Claude Code creates conversations.');
  }

  // Start file watcher / 启动文件监控
  if (config.enableSSE) {
    startWatcher();
  }

  // Build search index in background / 后台构建搜索索引
  if (config.enableSearch) {
    buildIndex().catch((err) => {
      logger.error(`Search index build failed: ${err}`);
    });
  }

  // Start HTTP server / 启动 HTTP 服务器
  app.listen(config.port, config.host, () => {
    const setupStatus = isSetupRequired() ? '(setup required)' : '(ready)';

    logger.success('');
    logger.success('╔══════════════════════════════════════════════╗');
    logger.success('║       Claude Session Manager  v1.0.0        ║');
    logger.success('╚══════════════════════════════════════════════╝');
    logger.success('');
    logger.info(`Server:    http://${config.host}:${config.port} ${setupStatus}`);
    logger.info(`Claude:    ${config.claudeDir}`);
    logger.info(`Data:      ${config.appDataDir}`);
    logger.info(`Read-only: ${config.readOnly}`);
    logger.success('');

    if (isSetupRequired()) {
      logger.warn('⚠  First run: open the URL above to set your password.');
      logger.warn('⚠  首次运行：打开上面的 URL 设置密码');
    }
  });
}

// Handle graceful shutdown / 优雅关闭
process.on('SIGINT', () => {
  logger.info('Shutting down... / 正在关闭...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down... / 正在关闭...');
  process.exit(0);
});

start().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});

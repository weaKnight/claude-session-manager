/**
 * File watcher service / 文件监控服务
 * Watches ~/.claude/projects/ for changes and pushes updates via SSE
 * 监控 ~/.claude/projects/ 的变更，通过 SSE 推送更新
 */

import chokidar from 'chokidar';
import { join, basename, dirname } from 'path';
import type { Response } from 'express';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { invalidateSessionCache } from './session-manager.js';
import { evictOffsets } from './offset-cache.js';
import { onFileEvent } from './search-engine.js';

// SSE client connections / SSE 客户端连接
const sseClients: Set<Response> = new Set();

let watcher: chokidar.FSWatcher | null = null;

/**
 * Start watching the projects directory / 开始监控项目目录
 */
export function startWatcher(): void {
  const projectsDir = join(config.claudeDir, 'projects');

  watcher = chokidar.watch(projectsDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 2,
    // Only watch .jsonl files / 只监控 .jsonl 文件
    ignored: (path: string) => {
      if (path === projectsDir) return false;
      // Allow directories and .jsonl files / 允许目录和 .jsonl 文件
      return !path.endsWith('.jsonl') && !path.includes('/');
    },
    // Debounce rapid changes / 防抖快速变更
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath: string) => handleChange('add', filePath));
  watcher.on('change', (filePath: string) => handleChange('change', filePath));
  watcher.on('unlink', (filePath: string) => handleChange('remove', filePath));

  watcher.on('error', (err: Error) => {
    logger.error(`File watcher error: ${err.message}`);
  });

  logger.success(`File watcher active: ${projectsDir}`);
}

/**
 * Handle file change event / 处理文件变更事件
 */
function handleChange(eventType: string, filePath: string): void {
  if (!filePath.endsWith('.jsonl')) return;

  const projectId = basename(dirname(filePath));
  const sessionId = basename(filePath, '.jsonl');

  logger.debug(`File ${eventType}: ${projectId}/${sessionId}`);

  // Invalidate just this session's meta cache (file-level granularity)
  // 仅作用到该会话——避免连带丢弃整个项目缓存
  invalidateSessionCache(projectId, sessionId);
  // Drop stale byte-offset sidecar; meta cache will rebuild it on next read
  // 同时丢弃过期的字节偏移 sidecar
  evictOffsets(projectId, sessionId).catch(() => { /* best effort */ });
  // Apply incremental delta to the search index; persist debounces on its end
  // 增量更新搜索索引，由 search-engine 自行 debounce 落盘
  onFileEvent(eventType as 'add' | 'change' | 'unlink', filePath).catch((err) => {
    logger.debug(`search onFileEvent error: ${err}`);
  });

  // Broadcast to all SSE clients / 广播到所有 SSE 客户端
  const event = {
    type: eventType,
    projectId,
    sessionId,
    timestamp: new Date().toISOString(),
  };

  broadcast(event);
}

/**
 * Send SSE event to all connected clients / 向所有连接的客户端发送 SSE 事件
 */
function broadcast(data: Record<string, unknown>): void {
  const message = `data: ${JSON.stringify(data)}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      // Client disconnected, remove / 客户端断开连接，移除
      sseClients.delete(client);
    }
  }
}

/**
 * Register a new SSE client / 注册新 SSE 客户端
 */
export function addSSEClient(res: Response): void {
  // Set SSE headers / 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering / 禁用 nginx 缓冲
  });

  // Send initial connection event / 发送初始连接事件
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  sseClients.add(res);
  logger.debug(`SSE client connected (total: ${sseClients.size})`);

  // Heartbeat every 30s to keep connection alive / 每 30 秒心跳保活
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 30_000);

  // Cleanup on disconnect / 断开连接时清理
  res.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    logger.debug(`SSE client disconnected (total: ${sseClients.size})`);
  });
}

/**
 * Stop the file watcher / 停止文件监控
 */
export function stopWatcher(): void {
  watcher?.close();
  watcher = null;
  sseClients.clear();
}

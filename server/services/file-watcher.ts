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
import { onFileEvent, onCodexFileEvent } from './search-engine.js';
import { codexEnabled, invalidateCodexFile, getCodexSessionMeta } from './codex-index.js';
import { codexSessionIdFromFile, parseCodexSessionMeta } from '../parser/codex-reader.js';

// SSE client connections / SSE 客户端连接
const sseClients: Set<Response> = new Set();

let watcher: chokidar.FSWatcher | null = null;
let codexWatcher: chokidar.FSWatcher | null = null;

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

  // Also watch the Codex sessions date-tree when enabled / 同时监控 Codex 会话目录
  if (codexEnabled()) {
    const codexDir = join(config.codexDir, 'sessions');
    codexWatcher = chokidar.watch(codexDir, {
      persistent: true,
      ignoreInitial: true,
      // YYYY/MM/DD/rollout-*.jsonl → need deeper traversal than Claude's flat layout
      depth: 4,
      ignored: (path: string) => {
        if (path === codexDir) return false;
        return !path.endsWith('.jsonl') && !path.includes('/');
      },
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    codexWatcher.on('add', (filePath: string) => { void handleCodexChange('add', filePath); });
    codexWatcher.on('change', (filePath: string) => { void handleCodexChange('change', filePath); });
    codexWatcher.on('unlink', (filePath: string) => { void handleCodexChange('remove', filePath); });
    codexWatcher.on('error', (err: Error) => {
      logger.error(`Codex watcher error: ${err.message}`);
    });

    logger.success(`Codex watcher active: ${codexDir}`);
  }
}

/**
 * Handle a Codex session file change. Invalidates the codex index so the next
 * read re-parses, and broadcasts an SSE event tagged source=codex.
 * 处理 Codex 会话文件变更：失效索引并通过 SSE 广播
 */
async function handleCodexChange(eventType: string, filePath: string): Promise<void> {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = codexSessionIdFromFile(filePath);

  logger.debug(`Codex file ${eventType}: ${sessionId}`);
  invalidateCodexFile(filePath);

  // Apply incremental delta to the search index / 增量更新搜索索引
  if (eventType === 'remove') {
    onCodexFileEvent('unlink', filePath).catch((err) => {
      logger.debug(`search onCodexFileEvent error: ${err}`);
    });
  } else {
    // Resolve meta from the codex index; fall back to parsing the file directly.
    // 优先从 codex 索引取 meta，取不到则直接解析文件。
    (async () => {
      let meta = await getCodexSessionMeta(sessionId);
      if (!meta) meta = (await parseCodexSessionMeta(filePath)).meta;
      await onCodexFileEvent(eventType as 'add' | 'change', filePath, meta);
    })().catch((err) => {
      logger.debug(`search onCodexFileEvent error: ${err}`);
    });
  }

  broadcast({
    type: eventType,
    source: 'codex',
    sessionId,
    timestamp: new Date().toISOString(),
  });
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
  codexWatcher?.close();
  codexWatcher = null;
  sseClients.clear();
}

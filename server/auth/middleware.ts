/**
 * Authentication middleware / 认证中间件
 * Protects API routes with JWT verification
 * 使用 JWT 验证保护 API 路由
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyToken, isSetupRequired } from './service.js';

/**
 * Require valid JWT for access / 要求有效 JWT 才能访问
 * Checks both Authorization header and query param (for SSE)
 * 同时检查 Authorization 头和查询参数（用于 SSE）
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Allow setup endpoint when not configured / 未配置时允许 setup 端点
  if (isSetupRequired()) {
    res.status(403).json({
      error: 'Setup required',
      message: 'Please set up a password first / 请先设置密码',
      setupRequired: true,
    });
    return;
  }

  // Extract token from header or query / 从 header 或查询参数提取 token
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // Fallback: query param (useful for SSE connections)
  // 备选：查询参数（用于 SSE 连接）
  if (!token && typeof req.query['token'] === 'string') {
    token = req.query['token'];
  }

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required / 需要认证',
    });
    return;
  }

  if (!verifyToken(token)) {
    res.status(401).json({
      error: 'Invalid token',
      message: 'Token expired or invalid / Token 已过期或无效',
    });
    return;
  }

  next();
}

/**
 * Get client IP address, respecting proxy headers
 * 获取客户端 IP 地址，支持代理头
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

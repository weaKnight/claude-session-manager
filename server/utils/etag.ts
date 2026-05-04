/**
 * Weak ETag helpers for file-backed responses
 * 基于文件 stat 的弱 ETag 辅助函数
 *
 * The ETag is derived from the underlying .jsonl mtime and size, which
 * uniquely identifies the on-disk state without hashing the contents.
 * ETag 由 jsonl 文件的 mtime 与 size 派生，无需读取内容即可唯一标识磁盘状态
 */

import type { Request, Response } from 'express';

/**
 * Build a weak ETag from file stat fields.
 * 由 stat 字段构建弱 ETag
 */
export function etagFor(mtimeMs: number, size: number, suffix?: string): string {
  const tail = suffix ? `-${suffix}` : '';
  return `W/"${size}-${Math.floor(mtimeMs)}${tail}"`;
}

/**
 * Apply ETag / Last-Modified headers and short-circuit with 304 when the
 * client already has the same version.
 * 应用 ETag / Last-Modified 头部；命中时直接返回 304
 *
 * Returns true when the response was finalized (304 sent); the caller
 * should stop further work in that case.
 * 返回 true 表示已发送 304；调用方应直接返回
 */
export function handleConditional(
  req: Request,
  res: Response,
  etag: string,
  lastModifiedMs: number,
): boolean {
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(lastModifiedMs).toUTCString());
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

  const ifNoneMatch = req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.status(304).end();
    return true;
  }

  const ifModifiedSince = req.header('if-modified-since');
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    if (Number.isFinite(since) && Math.floor(lastModifiedMs / 1000) <= Math.floor(since / 1000)) {
      res.status(304).end();
      return true;
    }
  }

  return false;
}

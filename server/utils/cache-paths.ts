/**
 * Cache directory paths / 缓存目录路径
 *
 * Centralizes the on-disk cache layout under appDataDir/cache/.
 * Phase 1 only creates the directories; later phases write to them.
 * 集中管理 appDataDir/cache/ 下的磁盘缓存布局
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

const CACHE_DIR = join(config.appDataDir, 'cache');
const META_DIR = join(CACHE_DIR, 'meta');
const SEARCH_DIR = join(CACHE_DIR, 'search');
const OFFSETS_DIR = join(CACHE_DIR, 'offsets');

export const cachePaths = {
  root: CACHE_DIR,
  meta: META_DIR,
  search: SEARCH_DIR,
  offsets: OFFSETS_DIR,

  metaIndexFile: (projectId: string): string => join(META_DIR, `${projectId}.json`),
  offsetFile: (projectId: string, sessionId: string): string =>
    join(OFFSETS_DIR, `${projectId}__${sessionId}.json`),
  searchIndexFile: (): string => join(SEARCH_DIR, 'index.json'),
  searchManifestFile: (): string => join(SEARCH_DIR, 'manifest.json'),
} as const;

/**
 * Ensure all cache subdirectories exist (idempotent)
 * 确保所有缓存子目录存在（幂等）
 */
export function ensureCacheDirs(): void {
  for (const dir of [CACHE_DIR, META_DIR, SEARCH_DIR, OFFSETS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

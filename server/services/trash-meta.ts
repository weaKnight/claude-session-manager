/**
 * Trash sidecar metadata / 回收站 sidecar 元数据
 *
 * Trash file names follow `{projectId}__{sessionId}__{timestamp}.jsonl`, which
 * cannot encode a session's original absolute path (Codex sessions live in a
 * deep date-tree under ~/.codex/sessions/YYYY/MM/DD/). To restore a file back
 * to its exact origin we keep a sidecar `config.trashDir/.trash-meta.json`
 * keyed by trash file name.
 *
 * 回收站文件名为 `{projectId}__{sessionId}__{timestamp}.jsonl`，无法编码会话的
 * 原始绝对路径（Codex 会话存于 ~/.codex/sessions/YYYY/MM/DD/ 深层目录）。为把
 * 文件精确还原到原始位置，用 sidecar `config.trashDir/.trash-meta.json` 记录，
 * key 为 trash 文件名。
 *
 * Single-process app → simple serial read-modify-write is enough, but every
 * write is atomic (tmp + rename) to avoid a torn sidecar.
 * 本项目单进程，简单串行读改写即可，但每次写都用 tmp+rename 原子化，避免写坏。
 */

import { promises as fsp, existsSync } from 'fs';
import { join, dirname } from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/** A single trash entry's provenance / 单条回收站条目的来源信息 */
export interface TrashMetaEntry {
  source: 'claude' | 'codex';
  originalPath: string;
  projectId: string;
  sessionId: string;
  deletedAt: number;
}

/** key = trash file name / key = 回收站文件名 */
export type TrashMeta = Record<string, TrashMetaEntry>;

/** Absolute path of the sidecar file / sidecar 文件绝对路径 */
function metaFilePath(): string {
  return join(config.trashDir, '.trash-meta.json');
}

/**
 * Read the full sidecar map. Missing or unparsable file → `{}`.
 * 读取全量 sidecar；不存在或解析失败返回 `{}`。
 */
export async function readTrashMeta(): Promise<TrashMeta> {
  const file = metaFilePath();
  if (!existsSync(file)) return {};
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as TrashMeta;
    }
    return {};
  } catch (err) {
    logger.warn(`trash-meta: read failed, treating as empty: ${err}`);
    return {};
  }
}

/**
 * Atomically persist the full sidecar map (tmp + rename).
 * 原子写回全量 sidecar（tmp + rename）。
 */
async function writeTrashMeta(meta: TrashMeta): Promise<void> {
  const file = metaFilePath();
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    await fsp.mkdir(dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(meta), 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    logger.error(`trash-meta: save failed: ${err}`);
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Add/replace one entry then atomically write back.
 * 读全量、加该条、原子写回。
 */
export async function writeTrashMetaEntry(fileName: string, entry: TrashMetaEntry): Promise<void> {
  const meta = await readTrashMeta();
  meta[fileName] = entry;
  await writeTrashMeta(meta);
}

/**
 * Remove multiple entries then atomically write back (used by emptyTrash /
 * deleteTrashItems / restoreSession). No-op when nothing matches.
 * 删除多条后原子写回；无匹配则空操作。
 */
export async function removeTrashMetaEntries(fileNames: string[]): Promise<void> {
  if (fileNames.length === 0) return;
  const meta = await readTrashMeta();
  let changed = false;
  for (const name of fileNames) {
    if (name in meta) {
      delete meta[name];
      changed = true;
    }
  }
  if (changed) await writeTrashMeta(meta);
}

/**
 * Look up a single entry by trash file name (null when absent).
 * 按文件名查单条（缺失返回 null）。
 */
export async function getTrashMetaEntry(fileName: string): Promise<TrashMetaEntry | null> {
  const meta = await readTrashMeta();
  return meta[fileName] ?? null;
}

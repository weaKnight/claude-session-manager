/**
 * Full-text search engine / 全文搜索引擎
 * Uses MiniSearch for in-memory indexing of session content
 * 使用 MiniSearch 进行会话内容的内存索引
 */

import MiniSearch from 'minisearch';
import { readdirSync, existsSync, createReadStream } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getProjectDisplayName } from '../parser/jsonl-reader.js';

interface SearchDocument {
  id: string;           // projectId/sessionId
  projectId: string;
  projectName: string;
  sessionId: string;
  text: string;         // Concatenated message text / 拼接的消息文本
  timestamp: string;
  summary: string;
}

export interface SearchResult {
  projectId: string;
  projectName: string;
  sessionId: string;
  summary: string;
  timestamp: string;
  score: number;
  matchSnippet: string;
}

// Search index instance / 搜索索引实例
let index: MiniSearch<SearchDocument> | null = null;
let indexBuildTime = 0;
let isBuilding = false;

/**
 * Build or rebuild the search index / 构建或重建搜索索引
 */
export async function buildIndex(): Promise<void> {
  if (isBuilding) return;
  isBuilding = true;

  logger.info('Building search index... / 正在构建搜索索引...');
  const startTime = Date.now();

  const newIndex = new MiniSearch<SearchDocument>({
    fields: ['text', 'summary', 'projectName'],
    storeFields: ['projectId', 'projectName', 'sessionId', 'summary', 'timestamp'],
    searchOptions: {
      boost: { summary: 2, projectName: 1.5 },
      fuzzy: 0.2,
      prefix: true,
    },
  });

  const projectsDir = join(config.claudeDir, 'projects');
  if (!existsSync(projectsDir)) {
    isBuilding = false;
    return;
  }

  const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  let docCount = 0;

  for (const dir of projectDirs) {
    const projectPath = join(projectsDir, dir.name);
    const jsonlFiles = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));

    for (const file of jsonlFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(projectPath, file);

      try {
        const doc = await extractSearchDoc(dir.name, sessionId, filePath);
        if (doc.text.length > 0) {
          newIndex.add(doc);
          docCount++;
        }
      } catch (err) {
        logger.debug(`Index skip ${file}: ${err}`);
      }
    }
  }

  index = newIndex;
  indexBuildTime = Date.now();
  isBuilding = false;

  const elapsed = Date.now() - startTime;
  logger.success(`Search index built: ${docCount} sessions in ${elapsed}ms`);
}

/**
 * Extract searchable text from a JSONL file / 从 JSONL 文件提取可搜索文本
 */
async function extractSearchDoc(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<SearchDocument> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const textParts: string[] = [];
  let summary = '';
  let timestamp = '';

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      if (!timestamp && entry.timestamp) {
        timestamp = entry.timestamp as string;
      }
      if (entry.type === 'summary' && entry.summary) {
        summary = entry.summary as string;
      }
      if (entry.message && typeof entry.message === 'object') {
        const msg = entry.message as Record<string, unknown>;
        const content = msg.content;
        if (typeof content === 'string') {
          textParts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'text' && typeof block.text === 'string') {
              textParts.push(block.text);
            }
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return {
    id: `${projectId}/${sessionId}`,
    projectId,
    projectName: getProjectDisplayName(projectId),
    sessionId,
    text: textParts.join(' ').slice(0, 50000), // Cap at 50k chars / 限制 5 万字符
    timestamp,
    summary: summary || textParts[0]?.slice(0, 200) || '',
  };
}

/**
 * Search sessions / 搜索会话
 */
export function search(
  query: string,
  options?: {
    projectId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }
): SearchResult[] {
  if (!index) return [];

  const limit = options?.limit || 50;

  let results = index.search(query, {
    filter: (result) => {
      const doc = result as unknown as SearchDocument;
      if (options?.projectId && doc.projectId !== options.projectId) return false;
      if (options?.from && doc.timestamp < options.from) return false;
      if (options?.to && doc.timestamp > options.to) return false;
      return true;
    },
  });

  results = results.slice(0, limit);

  return results.map((r) => {
    // Extract a match snippet / 提取匹配片段
    const doc = r as unknown as SearchDocument;
    const queryLower = query.toLowerCase();
    const textLower = (doc.text || '').toLowerCase();
    const matchIdx = textLower.indexOf(queryLower);
    const snippetStart = Math.max(0, matchIdx - 60);
    const snippetEnd = Math.min((doc.text || '').length, matchIdx + query.length + 60);
    const snippet = matchIdx >= 0
      ? '...' + (doc.text || '').slice(snippetStart, snippetEnd) + '...'
      : (doc.summary || '').slice(0, 120);

    return {
      projectId: doc.projectId,
      projectName: doc.projectName,
      sessionId: doc.sessionId,
      summary: doc.summary,
      timestamp: doc.timestamp,
      score: r.score,
      matchSnippet: snippet,
    };
  });
}

/**
 * Check if index needs rebuild / 检查索引是否需要重建
 */
export function needsRebuild(): boolean {
  return !index || Date.now() - indexBuildTime > 5 * 60 * 1000; // 5 min / 5 分钟
}

/**
 * JSONL file reader with streaming support
 * JSONL 文件流式读取器
 *
 * Reads Claude Code's .jsonl session files line-by-line
 * to avoid loading entire large files into memory.
 * 逐行读取 Claude Code 的 .jsonl 会话文件，避免大文件内存溢出
 */

import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import { basename, dirname } from 'path';
import type {
  JsonlEntry,
  SessionMeta,
  ParsedMessage,
  ParsedSession,
  ContentBlock,
  TokenUsage,
  AuditCommand,
  ToolUseContent,
} from './message-types.js';

/**
 * Decode Claude's path encoding: /home/user/project -> -home-user-project
 * 解码 Claude 的路径编码格式
 */
export function decodeProjectPath(encoded: string): string {
  // Replace leading dash and all dashes with /
  // 将前导短横线和所有短横线替换为 /
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Extract a human-readable project name from encoded path
 * 从编码路径提取人类可读的项目名
 */
export function getProjectDisplayName(encoded: string): string {
  const decoded = decodeProjectPath(encoded);
  const parts = decoded.split('/').filter(Boolean);
  // Return last 2 segments for context / 返回最后两段以提供上下文
  return parts.slice(-2).join('/') || encoded;
}

/**
 * Normalize content to ContentBlock array
 * 将内容统一为 ContentBlock 数组
 */
function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content as ContentBlock[];
  }
  return [];
}

/**
 * Stream-parse a single JSONL file and return session metadata + messages
 * 流式解析单个 JSONL 文件，返回会话元数据和消息
 */
export async function parseSessionFile(filePath: string): Promise<ParsedSession> {
  const messages: ParsedMessage[] = [];
  let firstTimestamp = '';
  let lastTimestamp = '';
  let summary = '';
  let cwd = '';
  let gitBranch = '';
  const totalTokens: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      // Skip malformed lines / 跳过格式错误的行
      continue;
    }

    lineCount++;

    // Extract metadata from first entry / 从第一条记录提取元数据
    if ('timestamp' in entry && typeof entry.timestamp === 'string') {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }

    if ('cwd' in entry && entry.cwd && !cwd) {
      cwd = entry.cwd as string;
    }
    if ('gitBranch' in entry && entry.gitBranch && !gitBranch) {
      gitBranch = entry.gitBranch as string;
    }

    // Handle summary entries / 处理摘要条目
    if ('type' in entry && entry.type === 'summary' && 'summary' in entry) {
      summary = (entry as { summary: string }).summary;
      continue;
    }

    // Handle message entries (user / assistant / system)
    // 处理消息条目（用户 / 助手 / 系统）
    if ('message' in entry && entry.message && typeof entry.message === 'object') {
      const msg = entry.message as Record<string, unknown>;
      const role = msg.role as string;

      if (role === 'user' || role === 'assistant' || role === 'system') {
        const contentBlocks = normalizeContent(msg.content);
        const usage = msg.usage as TokenUsage | undefined;

        // Accumulate token usage / 累计 token 用量
        if (usage) {
          totalTokens.input_tokens = (totalTokens.input_tokens || 0) + (usage.input_tokens || 0);
          totalTokens.output_tokens = (totalTokens.output_tokens || 0) + (usage.output_tokens || 0);
          totalTokens.cache_creation_input_tokens = (totalTokens.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
          totalTokens.cache_read_input_tokens = (totalTokens.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        }

        messages.push({
          uuid: (entry as Record<string, unknown>).uuid as string || `msg-${lineCount}`,
          parentUuid: (entry as Record<string, unknown>).parentUuid as string | undefined,
          role: role as 'user' | 'assistant' | 'system',
          timestamp: (entry as Record<string, unknown>).timestamp as string || '',
          content: contentBlocks,
          model: msg.model as string | undefined,
          usage,
          costUSD: (entry as Record<string, unknown>).costUSD as number | undefined,
          durationMs: (entry as Record<string, unknown>).durationMs as number | undefined,
        });
      }
    }
  }

  // Build metadata / 构建元数据
  const fileName = basename(filePath, '.jsonl');
  const projectDir = basename(dirname(filePath));
  let fileSize = 0;
  try {
    fileSize = statSync(filePath).size;
  } catch { /* ignore */ }

  const meta: SessionMeta = {
    id: fileName,
    projectPath: projectDir,
    projectName: getProjectDisplayName(projectDir),
    filePath,
    firstTimestamp,
    lastTimestamp,
    messageCount: messages.length,
    summary: summary || extractFirstUserMessage(messages),
    cwd,
    gitBranch,
    isAgent: fileName.startsWith('agent-'),
    totalTokens,
    fileSize,
  };

  return { meta, messages };
}

/**
 * Stream-parse a sliced range of messages from a session file.
 * 从会话文件流式读取一段消息切片
 *
 * Pagination contract:
 *  - When `afterUuid` is omitted, returns the first `limit` messages.
 *  - When `afterUuid` is provided, scans forward until the matching uuid is
 *    seen and then collects the next `limit` messages.
 *  - `nextCursor` is the uuid of the last returned message when more remain,
 *    or null when the slice reached EOF.
 *  - Optional `seekFromByte` lets callers jump to a known anchor offset; the
 *    target uuid lookup then happens within the seek window rather than from
 *    filehead. The caller (offset-cache aware) is responsible for ensuring
 *    the byte position is line-aligned and points at-or-before the cursor.
 */
export async function parseSessionSlice(
  filePath: string,
  opts: { afterUuid?: string; limit: number; seekFromByte?: number },
): Promise<{ messages: ParsedMessage[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(500, opts.limit | 0));
  const target = opts.afterUuid;
  const startByte = Math.max(0, opts.seekFromByte ?? 0);

  const fileStream = createReadStream(filePath, {
    encoding: 'utf-8',
    start: startByte,
  });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const messages: ParsedMessage[] = [];
  let lineCount = 0;
  let pastCursor = !target;
  let hasMore = false;

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // We only emit user/assistant/system messages — match parseSessionFile's
    // visible-message contract / 仅发出可见消息，与 parseSessionFile 一致
    if (!entry.message || typeof entry.message !== 'object') continue;
    const msg = entry.message as Record<string, unknown>;
    const role = msg.role as string;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

    const uuid = (entry.uuid as string) || `msg-${lineCount}`;

    if (!pastCursor) {
      if (uuid === target) pastCursor = true;
      continue;
    }

    if (messages.length >= limit) {
      hasMore = true;
      break;
    }

    const contentBlocks = normalizeContent(msg.content);
    const usage = msg.usage as TokenUsage | undefined;

    messages.push({
      uuid,
      parentUuid: entry.parentUuid as string | undefined,
      role: role as 'user' | 'assistant' | 'system',
      timestamp: (entry.timestamp as string) || '',
      content: contentBlocks,
      model: msg.model as string | undefined,
      usage,
      costUSD: entry.costUSD as number | undefined,
      durationMs: entry.durationMs as number | undefined,
    });
  }

  rl.close();
  fileStream.destroy();

  // If we requested a cursor but never matched, treat as EOF (caller decides)
  // 若给了 cursor 却未匹配到，按 EOF 处理（调用方判定）
  const nextCursor = hasMore && messages.length > 0
    ? messages[messages.length - 1].uuid
    : null;

  return { messages, nextCursor };
}

/**
 * Anchor frequency for the offset sidecar — kept in sync with offset-cache.ts
 * to avoid an import cycle. Default page size 200 is a multiple of this so
 * pagination cursors land on anchors.
 * 锚点采样频率；与 offset-cache 保持一致，默认 100
 */
const META_ANCHOR_EVERY = 100;

/**
 * Anchor produced as a side effect of parseSessionMeta. The shape mirrors
 * offset-cache's OffsetAnchor (kept duplicated to avoid an import cycle).
 * 与 offset-cache.OffsetAnchor 同形（避免循环依赖）
 */
export interface MetaAnchor { uuid: string; byteOffset: number }

/**
 * Quick-parse: read only metadata without full message parsing.
 *
 * Side effect: collects byte-offset anchors every META_ANCHOR_EVERY messages.
 * The byte offset is computed via Buffer.byteLength of each line + 1 (the
 * terminating \n). createInterface decodes UTF-8 from the source stream, so
 * line content is correct; our offset accounting assumes \n line endings
 * (true for jsonl) and is self-consistent with seek-from-byte reads.
 *
 * 快速解析：只读取元数据；同时按消息序号每 N 条采一个字节偏移锚点
 */
export async function parseSessionMeta(filePath: string): Promise<{
  meta: SessionMeta;
  anchors: MetaAnchor[];
}> {
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let firstTimestamp = '';
  let lastTimestamp = '';
  let summary = '';
  let cwd = '';
  let gitBranch = '';
  let messageCount = 0;
  const totalTokens: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let firstUserMsg = '';

  // Anchor bookkeeping / 锚点状态
  let byteOffset = 0;            // start-of-line byte position for the next line
  const anchors: MetaAnchor[] = [];

  for await (const line of rl) {
    const lineStart = byteOffset;
    byteOffset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n

    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.timestamp && typeof entry.timestamp === 'string') {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }

    if (entry.cwd && !cwd) cwd = entry.cwd as string;
    if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch as string;
    if (entry.type === 'summary' && entry.summary) {
      summary = entry.summary as string;
    }

    if (entry.message && typeof entry.message === 'object') {
      const msg = entry.message as Record<string, unknown>;
      const role = msg.role;
      const isVisible = role === 'user' || role === 'assistant' || role === 'system';

      if (role === 'user' || role === 'assistant') {
        messageCount++;
      }

      // Anchor only on visible messages — matches parseSessionSlice's emit
      // contract so cursors generated downstream are guaranteed to be uuids
      // we anchored here.
      // 仅对可见消息采点，与 slice 的发出契约对齐
      if (isVisible) {
        const uuid = (entry.uuid as string) || '';
        if (uuid && messageCount > 0 && messageCount % META_ANCHOR_EVERY === 0) {
          anchors.push({ uuid, byteOffset: lineStart });
        }
      }

      // Capture first user message for summary fallback
      // 捕获第一条用户消息作为摘要备选
      if (msg.role === 'user' && !firstUserMsg) {
        const content = msg.content;
        if (typeof content === 'string') {
          firstUserMsg = content.slice(0, 200);
        } else if (Array.isArray(content)) {
          const textBlock = (content as Array<Record<string, unknown>>).find(
            (b) => b.type === 'text'
          );
          if (textBlock && typeof textBlock.text === 'string') {
            firstUserMsg = textBlock.text.slice(0, 200);
          }
        }
      }
      // Accumulate tokens / 累计 token
      if (msg.usage && typeof msg.usage === 'object') {
        const u = msg.usage as TokenUsage;
        totalTokens.input_tokens = (totalTokens.input_tokens || 0) + (u.input_tokens || 0);
        totalTokens.output_tokens = (totalTokens.output_tokens || 0) + (u.output_tokens || 0);
      }
    }
  }

  const fileName = basename(filePath, '.jsonl');
  const projectDir = basename(dirname(filePath));
  let fileSize = 0;
  try { fileSize = statSync(filePath).size; } catch { /* ignore */ }

  const meta: SessionMeta = {
    id: fileName,
    projectPath: projectDir,
    projectName: getProjectDisplayName(projectDir),
    filePath,
    firstTimestamp,
    lastTimestamp,
    messageCount,
    summary: summary || firstUserMsg || '(empty session)',
    cwd,
    gitBranch,
    isAgent: fileName.startsWith('agent-'),
    totalTokens,
    fileSize,
  };

  return { meta, anchors };
}

/**
 * Extract tool_use commands from messages for audit
 * 从消息中提取 tool_use 命令用于审计
 *
 * Uses a single forward pass to build a tool_use_id → result map (O(N)),
 * then walks messages once. Previous implementation called messages.indexOf
 * inside the inner loop (O(N²)) which dominated audit endpoint latency on
 * large sessions.
 * 单次正向扫建立 tool_use_id → result 映射（O(N)），然后再遍历一次
 */
export function extractCommands(sessionId: string, messages: ParsedMessage[]): AuditCommand[] {
  const resultById = new Map<string, { output: string; isError: boolean }>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      if (!('tool_use_id' in block) || !block.tool_use_id) continue;

      const output = typeof block.content === 'string'
        ? block.content.slice(0, 2000)
        : JSON.stringify(block.content).slice(0, 2000);
      resultById.set(block.tool_use_id, { output, isError: block.is_error || false });
    }
  }

  const commands: AuditCommand[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      const toolBlock = block as ToolUseContent;
      const result = resultById.get(toolBlock.id);

      commands.push({
        sessionId,
        timestamp: msg.timestamp,
        toolName: toolBlock.name,
        input: toolBlock.input,
        output: result?.output ?? '',
        isError: result?.isError ?? false,
        messageUuid: msg.uuid,
      });
    }
  }

  return commands;
}

/**
 * Extract first user message text for summary fallback
 * 提取第一条用户消息文本作为摘要备选
 */
function extractFirstUserMessage(messages: ParsedMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '(empty session)';

  for (const block of first.content) {
    if (block.type === 'text') {
      return block.text.slice(0, 200);
    }
  }
  return '(no text content)';
}

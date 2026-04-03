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
 * Quick-parse: read only metadata without full message parsing
 * 快速解析：只读取元数据，不完整解析所有消息
 */
export async function parseSessionMeta(filePath: string): Promise<SessionMeta> {
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

  for await (const line of rl) {
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
      if (msg.role === 'user' || msg.role === 'assistant') {
        messageCount++;
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

  return {
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
}

/**
 * Extract tool_use commands from messages for audit
 * 从消息中提取 tool_use 命令用于审计
 */
export function extractCommands(sessionId: string, messages: ParsedMessage[]): AuditCommand[] {
  const commands: AuditCommand[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as ToolUseContent;
        // Find corresponding tool_result / 查找对应的 tool_result
        let output = '';
        let isError = false;

        // Look in next messages for result / 在后续消息中查找结果
        const msgIdx = messages.indexOf(msg);
        for (let i = msgIdx + 1; i < Math.min(msgIdx + 3, messages.length); i++) {
          for (const resultBlock of messages[i].content) {
            if (
              resultBlock.type === 'tool_result' &&
              'tool_use_id' in resultBlock &&
              resultBlock.tool_use_id === toolBlock.id
            ) {
              output = typeof resultBlock.content === 'string'
                ? resultBlock.content.slice(0, 2000)
                : JSON.stringify(resultBlock.content).slice(0, 2000);
              isError = resultBlock.is_error || false;
            }
          }
        }

        commands.push({
          sessionId,
          timestamp: msg.timestamp,
          toolName: toolBlock.name,
          input: toolBlock.input,
          output,
          isError,
          messageUuid: msg.uuid,
        });
      }
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

/**
 * Codex JSONL reader / Codex 会话记录读取器
 *
 * Codex CLI stores conversations under
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * One JSON object per line, wrapped in a {timestamp, type, payload} envelope —
 * a different shape from Claude's per-line message records. This module maps
 * Codex records onto the SAME view models (ParsedSession / ContentBlock /
 * SessionMeta) used by the Claude parser, so ChatViewer / AuditPanel / search
 * can render Codex sessions without per-component changes.
 *
 * Codex 会话按日期分层存放，每行是 {timestamp,type,payload} 信封格式（与 Claude
 * 的逐行 message 记录不同）。本模块把 Codex 记录映射到与 Claude 解析器相同的视图
 * 模型（ParsedSession / ContentBlock / SessionMeta），使前端组件无需改动即可复用。
 *
 * Mapping / 映射关系:
 *   response_item message(user/assistant) → text 消息
 *   response_item reasoning               → assistant 思考文本
 *   response_item function_call           → assistant tool_use
 *   response_item function_call_output    → user tool_result
 *   response_item custom_tool_call        → assistant tool_use（如 apply_patch）
 *   response_item custom_tool_call_output → user tool_result
 *   其余（event_msg / turn_context / session_meta / compacted）→ 忽略
 *
 * One response_item line emits at most one visible message, which keeps the
 * byte-offset anchoring (for seek-based pagination) trivial — the anchor is
 * simply that line's start offset.
 * 一条 response_item = 一行 = 至多一条可见消息，字节锚点即该行起始偏移。
 */

import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import { basename } from 'path';
import type {
  SessionMeta,
  ParsedMessage,
  ParsedSession,
  ContentBlock,
  TokenUsage,
  AuditCommand,
  ToolUseContent,
} from './message-types.js';
import type { MetaAnchor } from './jsonl-reader.js';

// Anchor frequency — kept in sync with jsonl-reader/offset-cache.
// 锚点采样频率，与 Claude 侧保持一致
const CODEX_ANCHOR_EVERY = 100;

// User response_item messages that are auto-injected system wrappers rather
// than real user input. Filtered from the transcript.
// 这些 user 消息是系统自动注入的包裹文本，并非真实用户输入，需从转录中过滤
const SYSTEM_USER_PREFIXES = [
  '<environment_context',
  '<turn_aborted',
  '<user_instructions',
  '<permissions',
  '<editor_context',
];

/**
 * Encode an absolute cwd into Claude's project-path scheme so Codex sessions
 * group alongside Claude ones: /watcherlab/safebench → -watcherlab-safebench.
 * 把绝对工作目录编码为 Claude 同款项目路径，使 Codex 会话按 cwd 合并到同一项目
 */
export function encodeProjectPath(cwd: string): string {
  if (!cwd) return 'unknown';
  return cwd.replace(/\//g, '-');
}

/**
 * Extract the session UUID from a Codex rollout filename.
 * rollout-2026-04-26T16-09-26-<uuid>.jsonl → <uuid>
 * 从 rollout 文件名提取会话 UUID
 */
export function codexSessionIdFromFile(filePath: string): string {
  const name = basename(filePath, '.jsonl');
  // The trailing 5 dash-separated groups form the UUID. Fall back to the whole
  // name if the pattern doesn't match.
  const m = name.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
  return m ? m[1] : name;
}

/** Collect plain text from a Codex content array (input_text/output_text/text). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

function isSystemWrapper(text: string): boolean {
  const trimmed = text.trimStart();
  return SYSTEM_USER_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * What a single Codex response_item line contributes to the transcript.
 * 单条 response_item 对转录的贡献
 */
interface Interpreted {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  isRealUserText: boolean; // counts toward userMessageCount / 计入真实用户消息数
  summaryText?: string;    // candidate summary source / 摘要候选文本
}

/**
 * Interpret a Codex JSONL entry into a visible message, or null if the line
 * carries no user-facing content (events, contexts, system wrappers).
 * 把一条 Codex 记录解释为可见消息；无可见内容则返回 null
 */
function interpretEntry(entry: Record<string, unknown>): Interpreted | null {
  if (entry.type !== 'response_item') return null;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return null;

  switch (payload.type) {
    case 'message': {
      const role = payload.role;
      if (role === 'assistant') {
        const text = extractText(payload.content);
        if (!text.trim()) return null;
        return { role: 'assistant', content: [{ type: 'text', text }], isRealUserText: false };
      }
      if (role === 'user') {
        const text = extractText(payload.content);
        if (!text.trim() || isSystemWrapper(text)) return null;
        return {
          role: 'user',
          content: [{ type: 'text', text }],
          isRealUserText: true,
          summaryText: text.slice(0, 200),
        };
      }
      // developer / system instructions → skip / 开发者(系统)指令跳过
      return null;
    }

    case 'reasoning': {
      const summary = payload.summary;
      let text = '';
      if (Array.isArray(summary)) {
        text = summary
          .map((s) => (s && typeof s === 'object' ? String((s as Record<string, unknown>).text ?? '') : ''))
          .filter(Boolean)
          .join('\n\n');
      }
      if (!text.trim()) return null; // encrypted-only reasoning → skip / 仅加密内容则跳过
      return { role: 'assistant', content: [{ type: 'text', text }], isRealUserText: false };
    }

    case 'function_call':
    case 'custom_tool_call': {
      const callId = (payload.call_id as string) || (payload.id as string) || '';
      const name = (payload.name as string) || 'tool';
      let input: Record<string, unknown>;
      if (payload.type === 'function_call') {
        // arguments is a JSON string / arguments 是 JSON 字符串
        const raw = payload.arguments;
        if (typeof raw === 'string') {
          try {
            input = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            input = { arguments: raw };
          }
        } else {
          input = (raw as Record<string, unknown>) || {};
        }
      } else {
        // custom_tool_call: input is a raw string payload (e.g. apply_patch diff)
        input = { input: payload.input };
      }
      const block: ToolUseContent = { type: 'tool_use', id: callId, name, input };
      return { role: 'assistant', content: [block], isRealUserText: false };
    }

    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = (payload.call_id as string) || '';
      let outputText = '';
      let isError = false;
      const out = payload.output;
      if (typeof out === 'string') {
        // Some outputs are a JSON string {output, metadata:{exit_code}}.
        // 部分输出是 JSON 字符串，含 metadata.exit_code
        try {
          const parsed = JSON.parse(out) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && 'output' in parsed) {
            outputText = String(parsed.output ?? '');
            const meta = parsed.metadata as Record<string, unknown> | undefined;
            if (meta && typeof meta.exit_code === 'number' && meta.exit_code !== 0) isError = true;
          } else {
            outputText = out;
          }
        } catch {
          outputText = out;
        }
      } else if (out != null) {
        outputText = JSON.stringify(out);
      }
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: callId, content: outputText, is_error: isError }],
        isRealUserText: false,
      };
    }

    default:
      return null;
  }
}

/** Read the session_meta line's payload (first line) for cwd/id/timestamp. */
interface CodexHeader {
  id: string;
  cwd: string;
  startTimestamp: string;
}

function readHeader(entry: Record<string, unknown>): CodexHeader | null {
  if (entry.type !== 'session_meta') return null;
  const p = entry.payload as Record<string, unknown> | undefined;
  if (!p) return null;
  return {
    id: (p.id as string) || '',
    cwd: (p.cwd as string) || '',
    startTimestamp: (p.timestamp as string) || (entry.timestamp as string) || '',
  };
}

function emptyTokens(): TokenUsage {
  // Fallback when no token_count line is present (e.g. minimal sessions).
  // 当会话中没有任何 token_count 行时的回退值，全部记为 0
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

/**
 * Map a Codex `total_token_usage` object onto the shared TokenUsage view model.
 * Codex records cumulative usage per token_count event; the last non-null one is
 * the whole-session total. reasoning_output_tokens count as output (the UI's
 * token bar sums input+output). cache_creation has no Codex equivalent → 0.
 * 把 Codex 的 total_token_usage 映射为统一的 TokenUsage：reasoning 计入 output，
 * cached 计入 cache_read，Codex 无 cache_creation 概念故记 0；字段做防御性取数。
 */
function mapCodexTokenUsage(total: Record<string, unknown>): TokenUsage {
  const num = (x: unknown) => Number(x) || 0;
  return {
    input_tokens: num(total.input_tokens),
    output_tokens: num(total.output_tokens) + num(total.reasoning_output_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: num(total.cached_input_tokens),
  };
}

/**
 * Detect a token_count event line and return its cumulative total_token_usage,
 * or null if the line is not a usable token_count record (info often null).
 * 识别 token_count 事件行并返回其累计 total_token_usage；非可用行返回 null
 */
function readTokenUsage(entry: Record<string, unknown>): TokenUsage | null {
  if (entry.type !== 'event_msg') return null;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'token_count') return null;
  const info = payload.info as Record<string, unknown> | null | undefined;
  if (!info || typeof info !== 'object') return null; // info 可能为 null，跳过
  const total = info.total_token_usage as Record<string, unknown> | undefined;
  if (!total || typeof total !== 'object') return null;
  return mapCodexTokenUsage(total);
}

/**
 * Build SessionMeta common fields from accumulated parse state.
 * 用解析过程中累计的状态构建 SessionMeta 公共字段
 */
function buildMeta(args: {
  filePath: string;
  header: CodexHeader | null;
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
  userMessageCount: number;
  summary: string;
  nonEmptyLineCount: number;
  parsedLineCount: number;
  totalTokens?: TokenUsage | null; // last cumulative token_count, if any / 最后一条累计用量
}): SessionMeta {
  const cwd = args.header?.cwd || '';
  const projectPath = encodeProjectPath(cwd);
  const id = codexSessionIdFromFile(args.filePath) || args.header?.id || basename(args.filePath, '.jsonl');
  let fileSize = 0;
  try {
    fileSize = statSync(args.filePath).size;
  } catch {
    /* ignore */
  }
  // Display name: last 2 path segments of the cwd / 显示名取 cwd 末两段
  const segs = cwd.split('/').filter(Boolean);
  const projectName = segs.slice(-2).join('/') || cwd || 'codex';

  return {
    id,
    source: 'codex',
    projectPath,
    projectName,
    filePath: args.filePath,
    firstTimestamp: args.firstTimestamp || args.header?.startTimestamp || '',
    lastTimestamp: args.lastTimestamp || args.firstTimestamp || '',
    messageCount: args.messageCount,
    summary: args.summary || '(empty session)',
    cwd,
    gitBranch: '',
    isAgent: false,
    totalTokens: args.totalTokens ?? emptyTokens(),
    fileSize,
    userMessageCount: args.userMessageCount,
    corrupt: args.nonEmptyLineCount > 0 && args.parsedLineCount === 0,
  };
}

/**
 * Full parse: stream the whole file into SessionMeta + ordered messages.
 * 全量解析：返回元数据与全部消息
 */
export async function parseCodexSessionFile(filePath: string): Promise<ParsedSession> {
  const messages: ParsedMessage[] = [];
  let header: CodexHeader | null = null;
  let firstTimestamp = '';
  let lastTimestamp = '';
  let summary = '';
  let userMessageCount = 0;
  let nonEmptyLineCount = 0;
  let parsedLineCount = 0;
  let emitSeq = 0;
  let lastTokenUsage: TokenUsage | null = null; // 最后看到的累计 token 用量

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    nonEmptyLineCount++;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    parsedLineCount++;

    if (!header) header = readHeader(entry);
    const ts = entry.timestamp as string | undefined;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // token_count events are not response_items (interpretEntry → null), so
    // capture cumulative usage here before the null-skip below.
    // token_count 不是 response_item，需在 interpretEntry 的 null 分支跳过前单独捕获
    const usage = readTokenUsage(entry);
    if (usage) lastTokenUsage = usage;

    const interpreted = interpretEntry(entry);
    if (!interpreted) continue;

    if (interpreted.isRealUserText) {
      userMessageCount++;
      if (!summary && interpreted.summaryText) summary = interpreted.summaryText;
    }

    emitSeq++;
    messages.push({
      uuid: `c-${emitSeq}`,
      role: interpreted.role,
      timestamp: ts || '',
      content: interpreted.content,
    });
  }

  const meta = buildMeta({
    filePath,
    header,
    firstTimestamp,
    lastTimestamp,
    messageCount: messages.length,
    userMessageCount,
    summary,
    nonEmptyLineCount,
    parsedLineCount,
    totalTokens: lastTokenUsage,
  });

  return { meta, messages };
}

/**
 * Meta-only parse with byte-offset anchors every CODEX_ANCHOR_EVERY messages,
 * mirroring jsonl-reader.parseSessionMeta so the offset-cache + seek-based
 * pagination work identically for Codex.
 * 仅解析元数据，并每 N 条可见消息采一个字节偏移锚点（与 Claude 侧机制一致）
 */
export async function parseCodexSessionMeta(filePath: string): Promise<{
  meta: SessionMeta;
  anchors: MetaAnchor[];
}> {
  let header: CodexHeader | null = null;
  let firstTimestamp = '';
  let lastTimestamp = '';
  let summary = '';
  let messageCount = 0;
  let userMessageCount = 0;
  let nonEmptyLineCount = 0;
  let parsedLineCount = 0;
  let emitSeq = 0;
  let byteOffset = 0;
  let lastTokenUsage: TokenUsage | null = null; // 最后看到的累计 token 用量
  const anchors: MetaAnchor[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const lineStart = byteOffset;
    byteOffset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n

    if (!line.trim()) continue;
    nonEmptyLineCount++;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    parsedLineCount++;

    if (!header) header = readHeader(entry);
    const ts = entry.timestamp as string | undefined;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // Capture cumulative token usage before interpretEntry's null-skip below.
    // 在 interpretEntry 的 null 分支跳过前单独捕获累计 token 用量
    const usage = readTokenUsage(entry);
    if (usage) lastTokenUsage = usage;

    const interpreted = interpretEntry(entry);
    if (!interpreted) continue;

    if (interpreted.isRealUserText) {
      userMessageCount++;
      if (!summary && interpreted.summaryText) summary = interpreted.summaryText;
    }

    emitSeq++;
    messageCount++;
    // Anchor on the same uuids parseCodexSessionSlice emits / 与 slice 发出的 uuid 对齐
    if (emitSeq % CODEX_ANCHOR_EVERY === 0) {
      anchors.push({ uuid: `c-${emitSeq}`, byteOffset: lineStart });
    }
  }

  const meta = buildMeta({
    filePath,
    header,
    firstTimestamp,
    lastTimestamp,
    messageCount,
    userMessageCount,
    summary,
    nonEmptyLineCount,
    parsedLineCount,
    totalTokens: lastTokenUsage,
  });

  return { meta, anchors };
}

/**
 * Sliced parse mirroring jsonl-reader.parseSessionSlice's pagination contract.
 * Synthetic uuids are `c-${emitSeq}`, assigned in emit order, so cursor
 * matching and anchor seeking line up across all three parse paths.
 * 切片解析，分页契约与 Claude 侧一致；合成 uuid 为 c-${序号}
 */
export async function parseCodexSessionSlice(
  filePath: string,
  opts: { afterUuid?: string; limit: number; seekFromByte?: number },
): Promise<{ messages: ParsedMessage[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(500, opts.limit | 0));
  const target = opts.afterUuid;
  const startByte = Math.max(0, opts.seekFromByte ?? 0);

  // When seeking from a mid-file anchor, emitSeq must resume from the anchor's
  // ordinal so synthetic uuids stay globally consistent. The anchor uuid
  // encodes that ordinal (c-<n>), so derive the base from the cursor.
  // 从中途锚点 seek 时，emitSeq 需从该锚点序号继起，使合成 uuid 保持全局一致
  let emitSeq = 0;
  if (startByte > 0 && target) {
    const m = target.match(/^c-(\d+)$/);
    if (m) emitSeq = Number(m[1]) - 1; // first emit after seek becomes the cursor itself
  }

  const fileStream = createReadStream(filePath, { encoding: 'utf-8', start: startByte });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const messages: ParsedMessage[] = [];
  let pastCursor = !target;
  let hasMore = false;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const interpreted = interpretEntry(entry);
    if (!interpreted) continue;

    emitSeq++;
    const uuid = `c-${emitSeq}`;

    if (!pastCursor) {
      if (uuid === target) pastCursor = true;
      continue;
    }

    if (messages.length >= limit) {
      hasMore = true;
      break;
    }

    messages.push({
      uuid,
      role: interpreted.role,
      timestamp: (entry.timestamp as string) || '',
      content: interpreted.content,
    });
  }

  rl.close();
  fileStream.destroy();

  const nextCursor = hasMore && messages.length > 0 ? messages[messages.length - 1].uuid : null;
  return { messages, nextCursor };
}

/**
 * Stream a Codex session file and collect only `text` content for full-text
 * search. Reuses interpretEntry but never builds a ParsedMessage[] array, so
 * large files stay cheap. Result is capped at 50000 chars to match the Claude
 * search-doc budget.
 * 流式提取 Codex 会话的纯文本用于全文搜索：复用 interpretEntry，但不构建完整
 * ParsedMessage[] 数组以省内存；结果截断到 50000 字符（与 Claude 侧一致）。
 */
export async function extractCodexSearchText(filePath: string): Promise<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const parts: string[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const interpreted = interpretEntry(entry);
    if (!interpreted) continue;
    for (const block of interpreted.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }

  return parts.join(' ').slice(0, 50000);
}

/**
 * Extract tool_use/tool_result pairs as audit commands. Identical pairing
 * logic to the Claude reader (by tool id), reused here for consistency.
 * 提取 tool_use/tool_result 作为审计命令；按 id 配对，逻辑同 Claude 侧
 */
export function extractCodexCommands(sessionId: string, messages: ParsedMessage[]): AuditCommand[] {
  const resultById = new Map<string, { output: string; isError: boolean }>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      if (!block.tool_use_id) continue;
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

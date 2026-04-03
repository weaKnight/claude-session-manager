/**
 * Type definitions for Claude Code JSONL conversation data
 * Claude Code JSONL 会话数据的类型定义
 *
 * Based on analysis of ~/.claude/projects/ JSONL file structure
 * 基于对 ~/.claude/projects/ 下 JSONL 文件结构的分析
 */

// --- Content block types / 内容块类型 ---

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;       // e.g. "Bash", "Read", "Write", "Edit", "Task", "Grep", "Glob", "LS"
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

// --- Token usage / Token 使用量 ---

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// --- Message structure / 消息结构 ---

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  id?: string;
  model?: string;
  stop_reason?: string;
  usage?: TokenUsage;
}

// --- JSONL line types / JSONL 行类型 ---

export interface UserEntry {
  type: 'user';
  message: Message;
  timestamp: string;
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  version?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface AssistantEntry {
  type: 'assistant';
  message: Message;
  timestamp: string;
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  costUSD?: number;
  durationMs?: number;
}

export interface SummaryEntry {
  type: 'summary';
  summary: string;
  timestamp: string;
  sessionId: string;
}

export interface SystemEntry {
  type: 'system';
  message: Message;
  timestamp: string;
  sessionId: string;
}

export type JsonlEntry = UserEntry | AssistantEntry | SummaryEntry | SystemEntry | Record<string, unknown>;

// --- Parsed session / 解析后的会话 ---

export interface SessionMeta {
  id: string;               // Session UUID / 会话 UUID
  projectPath: string;       // Encoded project path / 编码后的项目路径
  projectName: string;       // Decoded human-readable name / 解码后的可读名称
  filePath: string;          // Absolute path to .jsonl file / JSONL 文件绝对路径
  firstTimestamp: string;    // First message time / 首条消息时间
  lastTimestamp: string;     // Last message time / 末条消息时间
  messageCount: number;      // Total messages / 消息总数
  summary?: string;          // Auto-generated summary / 自动生成的摘要
  cwd?: string;              // Working directory / 工作目录
  gitBranch?: string;        // Git branch / Git 分支
  isAgent: boolean;          // Is sub-agent session / 是否为子 agent 会话
  totalTokens: TokenUsage;   // Aggregated token usage / 汇总 token 用量
  fileSize: number;          // File size in bytes / 文件大小（字节）
}

export interface ParsedMessage {
  uuid: string;
  parentUuid?: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  content: ContentBlock[];
  model?: string;
  usage?: TokenUsage;
  costUSD?: number;
  durationMs?: number;
}

export interface ParsedSession {
  meta: SessionMeta;
  messages: ParsedMessage[];
}

// --- Command audit types / 命令审计类型 ---

export interface AuditCommand {
  sessionId: string;
  timestamp: string;
  toolName: string;          // e.g. "Bash", "Write", "Edit"
  input: Record<string, unknown>;
  output?: string;
  isError: boolean;
  messageUuid: string;
}

// --- Project structure / 项目结构 ---

export interface ProjectInfo {
  encodedPath: string;       // Directory name (encoded) / 目录名（编码后）
  decodedPath: string;       // Original path / 原始路径
  displayName: string;       // Short name for UI / UI 显示用短名称
  sessionCount: number;      // Number of sessions / 会话数量
  lastActivity: string;      // Most recent session time / 最近会话时间
}

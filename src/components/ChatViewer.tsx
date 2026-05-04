/**
 * Chat viewer / 聊天查看器
 * Renders session messages with Markdown, code blocks, and tool use
 * Supports 3 view modes: Full, Compact (user + commands), Changes (file diffs)
 * 渲染会话消息，支持 Markdown、代码块和工具调用
 * 支持 3 种视图模式：完整、精简（用户+命令）、变更（文件差异）
 */

import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';
import {
  ArrowLeft, User, Bot, Terminal, AlertTriangle,
  Copy, Check, ChevronDown, ChevronRight, Shield,
  ArrowDown, Layers, Zap, FileCode, FileEdit, FilePlus, MessageSquare,
} from 'lucide-react';
import { sessions as sessionsApi, type ParsedMessage, type ContentBlock } from '../utils/api';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import DialogUserRow from './DialogUserRow';

type ViewMode = 'full' | 'dialog' | 'compact' | 'changes';

interface Props {
  projectId: string;
  sessionId: string;
  onBack: () => void;
  onViewAudit?: () => void;
  /**
   * Layout calls this with a `${projectId}/${sessionId}` key and a fn that
   * triggers the live-append fetch. Returning the unregister cleanup keeps
   * the contract symmetric with useEffect.
   * Layout 注入：注册当前会话的实时追加回调，返回反注册函数
   */
  registerLiveAppend?: (key: string, fn: () => void) => () => void;
}

// Configure marked for safe rendering / 配置 marked 安全渲染
marked.setOptions({ gfm: true, breaks: true });

// LRU markdown render cache. Move-to-front on hit so frequently re-rendered
// blocks survive eviction; on overflow drop the oldest single entry rather
// than wiping the whole cache (the previous clear() caused full re-parses
// for entire long sessions).
// Map iteration order is insertion order, so .keys().next() is the LRU.
// LRU markdown 缓存：命中时刷新位置；溢出时只逐出最旧一个，避免整库失效
const MD_CACHE_LIMIT = 2000;
const mdCache = new Map<string, string>();
function renderMarkdown(text: string): string {
  const cached = mdCache.get(text);
  if (cached !== undefined) {
    // Move-to-front: re-insert promotes the entry to the most recent slot
    // 移到最新位置——保持热数据不被淘汰
    mdCache.delete(text);
    mdCache.set(text, cached);
    return cached;
  }
  const raw = marked.parse(text) as string;
  // All HTML is sanitized via DOMPurify to prevent XSS
  // 所有 HTML 通过 DOMPurify 消毒以防止 XSS
  const result = DOMPurify.sanitize(raw);
  if (mdCache.size >= MD_CACHE_LIMIT) {
    const oldest = mdCache.keys().next().value;
    if (oldest !== undefined) mdCache.delete(oldest);
  }
  mdCache.set(text, result);
  return result;
}

// Page size for incremental message fetch / 切片拉取每页大小
const PAGE_SIZE = 200;

// --- Shared sub-components / 共享子组件 ---

const ToolUseBlock = memo(function ToolUseBlock({ block, defaultExpanded = false }: { block: ContentBlock; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const input = block.input || {};
  const isBash = block.name === 'Bash' || block.name === 'bash';
  const command = isBash ? (input.command as string || '') : JSON.stringify(input, null, 2);

  return (
    <div className="msg-tool rounded-md p-3 my-2 transition-all duration-150">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left cursor-pointer"
      >
        <span className="transition-transform duration-150" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <ChevronRight size={14} />
        </span>
        <Terminal size={14} style={{ color: 'var(--status-warn)' }} />
        <span className="badge badge-tool">{block.name}</span>
        {isBash && (
          <code className="text-2xs truncate flex-1" style={{ color: 'var(--txt-2)', fontFamily: 'JetBrains Mono, monospace' }}>
            {command.split('\n')[0].slice(0, 80)}
          </code>
        )}
      </button>
      {expanded && (
        <div className="animate-expand">
          <pre className="code-block mt-2 text-2xs">{command}</pre>
        </div>
      )}
    </div>
  );
});

const ToolResultBlock = memo(function ToolResultBlock({ block }: { block: ContentBlock }) {
  const [expanded, setExpanded] = useState(false);

  const content = typeof block.content === 'string'
    ? block.content
    : Array.isArray(block.content)
    ? block.content.map((c) => c.text || '').join('\n')
    : '';

  const isError = block.is_error;
  const truncated = content.length > 500;
  const display = expanded ? content : content.slice(0, 500);

  return (
    <div className={`${isError ? 'msg-error' : 'msg-tool'} rounded-md p-3 my-2`}>
      <div className="flex items-center gap-2 mb-1">
        {isError ? (
          <AlertTriangle size={14} style={{ color: 'var(--status-err)' }} />
        ) : (
          <Check size={14} style={{ color: 'var(--status-ok)' }} />
        )}
        <span className="text-2xs font-medium" style={{ color: isError ? 'var(--status-err)' : 'var(--status-ok)' }}>
          {isError ? 'Error' : 'Result'}
        </span>
      </div>
      <pre className="code-block text-2xs whitespace-pre-wrap">{display}</pre>
      {truncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="btn btn-ghost text-2xs mt-1"
        >
          {expanded ? 'Collapse' : `Show all (${content.length} chars)`}
        </button>
      )}
    </div>
  );
});

// --- Full view message bubble / 完整视图消息气泡 ---

const MessageBubble = memo(function MessageBubble({ message }: { message: ParsedMessage }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  const textContent = message.content
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');

  const toolBlocks = message.content.filter((b) => b.type === 'tool_use');
  const resultBlocks = message.content.filter((b) => b.type === 'tool_result');

  const handleCopy = () => {
    navigator.clipboard.writeText(textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const bubbleClass = isUser ? 'msg-user' : isAssistant ? 'msg-assistant' : 'msg-tool';

  const sanitizedHtml = textContent ? renderMarkdown(textContent) : '';

  return (
    <div>
      {/* Role header / 角色标头 */}
      <div className="flex items-center gap-2 mb-1.5">
        {isUser ? (
          <User size={14} style={{ color: 'var(--status-info)' }} />
        ) : isAssistant ? (
          <Bot size={14} style={{ color: 'var(--accent)' }} />
        ) : (
          <Terminal size={14} style={{ color: 'var(--txt-3)' }} />
        )}
        <span className="text-2xs font-medium" style={{ color: 'var(--txt-2)' }}>
          {isUser ? t('chat.user') : isAssistant ? t('chat.assistant') : t('chat.system')}
        </span>
        {message.model && (
          <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>{message.model}</span>
        )}
        <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>
          {message.timestamp ? new Date(message.timestamp).toLocaleTimeString() : ''}
        </span>
        {textContent && (
          <button onClick={handleCopy} className="btn btn-ghost p-1 ml-auto" title={t('chat.copy')}>
            {copied ? <Check size={12} style={{ color: 'var(--status-ok)' }} /> : <Copy size={12} />}
          </button>
        )}
      </div>

      {/* Text content (sanitized via DOMPurify) / 文本内容（已通过 DOMPurify 消毒） */}
      {sanitizedHtml && (
        <div
          className={`${bubbleClass} rounded-md p-3 markdown-body`}
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      )}

      {/* Tool use blocks / 工具调用块 */}
      {toolBlocks.map((block, i) => (
        <ToolUseBlock key={`tool-${i}`} block={block} />
      ))}

      {/* Tool result blocks / 工具结果块 */}
      {resultBlocks.map((block, i) => (
        <ToolResultBlock key={`result-${i}`} block={block} />
      ))}

      {/* Token usage / Token 用量 */}
      {message.usage && (isAssistant) && (
        <div
          className="flex items-center gap-3 mt-1.5 text-2xs"
          style={{ color: 'var(--txt-3)', fontFamily: 'JetBrains Mono, monospace' }}
        >
          <span>↓{message.usage.input_tokens || 0} ↑{message.usage.output_tokens || 0}</span>
          {message.costUSD != null && <span>${message.costUSD.toFixed(4)}</span>}
          {message.durationMs != null && <span>{(message.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      )}
    </div>
  );
}, (prev, next) => prev.message.uuid === next.message.uuid);

// --- Compact view / 精简视图 ---

interface CompactGroup {
  userMessage: ParsedMessage;
  toolBlocks: ContentBlock[];
  resultBlocks: ContentBlock[];
  assistantTextPreview: string;
  commandCount: number;
}

function buildCompactGroups(messages: ParsedMessage[]): CompactGroup[] {
  const groups: CompactGroup[] = [];
  let currentUser: ParsedMessage | null = null;
  let tools: ContentBlock[] = [];
  let results: ContentBlock[] = [];
  let textPreview = '';
  let cmdCount = 0;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (currentUser) {
        groups.push({
          userMessage: currentUser,
          toolBlocks: tools,
          resultBlocks: results,
          assistantTextPreview: textPreview.slice(0, 120),
          commandCount: cmdCount,
        });
      }
      currentUser = msg;
      tools = [];
      results = [];
      textPreview = '';
      cmdCount = 0;
    } else if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          tools.push(block);
          cmdCount++;
        } else if (block.type === 'tool_result') {
          results.push(block);
        } else if (block.type === 'text' && block.text && !textPreview) {
          textPreview = block.text;
        }
      }
    }
  }
  if (currentUser) {
    groups.push({
      userMessage: currentUser,
      toolBlocks: tools,
      resultBlocks: results,
      assistantTextPreview: textPreview.slice(0, 120),
      commandCount: cmdCount,
    });
  }
  return groups;
}

const CompactGroupView = memo(function CompactGroupView({ group }: { group: CompactGroup }) {
  const { t } = useTranslation();
  const [showAssistant, setShowAssistant] = useState(false);

  const userText = group.userMessage.content
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');

  const sanitizedUserHtml = userText ? renderMarkdown(userText) : '';
  const sanitizedAssistantHtml = showAssistant && group.assistantTextPreview
    ? renderMarkdown(group.assistantTextPreview)
    : '';

  return (
    <div className="animate-fade-in">
      {/* User input / 用户输入 */}
      <div className="flex items-center gap-2 mb-1.5">
        <User size={14} style={{ color: 'var(--status-info)' }} />
        <span className="text-2xs font-medium" style={{ color: 'var(--txt-2)' }}>{t('chat.user')}</span>
        <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>
          {group.userMessage.timestamp ? new Date(group.userMessage.timestamp).toLocaleTimeString() : ''}
        </span>
      </div>
      {sanitizedUserHtml && (
        <div className="msg-user rounded-md p-3 markdown-body" dangerouslySetInnerHTML={{ __html: sanitizedUserHtml }} />
      )}

      {/* Assistant summary (collapsed) / 助手摘要（折叠） */}
      {group.assistantTextPreview && (
        <div className="compact-summary my-2" onClick={() => setShowAssistant(!showAssistant)}>
          <Bot size={12} style={{ color: 'var(--accent)' }} />
          <span className="flex-1 truncate">
            {showAssistant ? t('chat.assistant_summary') : group.assistantTextPreview + '...'}
          </span>
          {group.commandCount > 0 && (
            <span className="badge badge-tool">
              {t('chat.commands_count', { count: group.commandCount })}
            </span>
          )}
          <ChevronDown size={12} className="transition-transform duration-150" style={{ transform: showAssistant ? 'rotate(180deg)' : 'rotate(0deg)' }} />
        </div>
      )}

      {/* Expanded assistant text (sanitized) / 展开的助手文本（已消毒） */}
      {sanitizedAssistantHtml && (
        <div className="msg-assistant rounded-md p-3 markdown-body animate-expand mb-2"
          dangerouslySetInnerHTML={{ __html: sanitizedAssistantHtml }}
        />
      )}

      {/* Tool calls / 工具调用 */}
      {group.toolBlocks.map((block, i) => (
        <ToolUseBlock key={`tool-${i}`} block={block} />
      ))}

      {/* Error results only / 只显示错误结果 */}
      {group.resultBlocks.filter((b) => b.is_error).map((block, i) => (
        <ToolResultBlock key={`err-${i}`} block={block} />
      ))}
    </div>
  );
}, (prev, next) => prev.group.userMessage.uuid === next.group.userMessage.uuid
  && prev.group.commandCount === next.group.commandCount);

// --- Changes view / 变更视图 ---

interface FileChange {
  toolName: string;
  filePath: string;
  content: string;
  timestamp: string;
  isNew: boolean;
}

function extractFileChanges(messages: ParsedMessage[]): FileChange[] {
  const changes: FileChange[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      const name = block.name || '';

      // Write tool — file creation / Write 工具 — 文件创建
      if (name === 'Write' || name === 'write') {
        const filePath = (input.file_path as string) || (input.path as string) || '';
        const content = (input.content as string) || '';
        if (filePath) {
          changes.push({
            toolName: name,
            filePath,
            content: content.slice(0, 3000),
            timestamp: msg.timestamp,
            isNew: true,
          });
        }
      }

      // Edit tool — file modification / Edit 工具 — 文件修改
      if (name === 'Edit' || name === 'edit' || name === 'MultiEdit') {
        const filePath = (input.file_path as string) || (input.path as string) || '';
        const oldStr = (input.old_string as string) || (input.old_str as string) || '';
        const newStr = (input.new_string as string) || (input.new_str as string) || '';
        if (filePath && (oldStr || newStr)) {
          const oldLines = oldStr.split('\n').map((l: string) => `- ${l}`).join('\n');
          const newLines = newStr.split('\n').map((l: string) => `+ ${l}`).join('\n');
          const diffContent = `--- ${filePath}\n+++ ${filePath}\n\n${oldLines}\n${newLines}`;
          changes.push({
            toolName: name,
            filePath,
            content: diffContent.slice(0, 3000),
            timestamp: msg.timestamp,
            isNew: false,
          });
        }
      }
    }
  }
  return changes;
}

const FileChangeCard = memo(function FileChangeCard({ change }: { change: FileChange }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  const fileName = change.filePath.split('/').pop() || change.filePath;
  const dirPath = change.filePath.replace(/\/[^/]+$/, '');

  return (
    <div className="change-card animate-fade-in">
      <div
        className="change-card-header cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {change.isNew ? (
          <FilePlus size={14} style={{ color: 'var(--status-ok)' }} />
        ) : (
          <FileEdit size={14} style={{ color: 'var(--status-info)' }} />
        )}
        <span className="font-medium" style={{ color: 'var(--txt-1)' }}>{fileName}</span>
        <span className="text-2xs truncate flex-1" style={{ color: 'var(--txt-3)' }}>{dirPath}</span>
        <span className={`change-type-badge ${change.isNew ? 'change-type-write' : 'change-type-edit'}`}>
          {change.isNew ? t('chat.file_created') : t('chat.file_modified')}
        </span>
        <span className="text-2xs" style={{ color: 'var(--txt-3)', fontFamily: 'JetBrains Mono, monospace' }}>
          {change.timestamp ? new Date(change.timestamp).toLocaleTimeString() : ''}
        </span>
        <ChevronDown size={12} className="transition-transform duration-150" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', color: 'var(--txt-3)' }} />
      </div>
      {expanded && (
        <div className="change-card-body">
          {change.content.split('\n').map((line, i) => {
            let lineColor = 'var(--txt-2)';
            if (line.startsWith('+ ')) lineColor = 'var(--status-ok)';
            else if (line.startsWith('- ')) lineColor = 'var(--status-err)';
            else if (line.startsWith('---') || line.startsWith('+++')) lineColor = 'var(--txt-3)';

            return (
              <div key={i} style={{ color: lineColor }} className="whitespace-pre-wrap">
                {line}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// --- Main component / 主组件 ---

export default function ChatViewer({ projectId, sessionId, onBack, onViewAudit, registerLiveAppend }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('full');
  const [atBottom, setAtBottom] = useState(true);
  const virtuosoRef = useRef<{ scrollToIndex: (i: { index: number; behavior?: 'smooth' | 'auto'; align?: 'start' | 'center' | 'end' }) => void } | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  // Refs for the live-append closure to read the most recent state without
  // re-subscribing on every render.
  // 实时追加闭包用 ref 读最新状态，避免每次 render 重订阅
  const messagesRef = useRef<ParsedMessage[]>([]);
  const atBottomRef = useRef(true);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { atBottomRef.current = atBottom; }, [atBottom]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setMessages([]);
    setNextCursor(null);
    cursorRef.current = null;

    sessionsApi.get(projectId, sessionId, ctrl.signal)
      .then((data) => {
        setMessages(data.messages);
        setMeta(data.meta as unknown as Record<string, unknown>);
        setNextCursor(data.nextCursor);
        cursorRef.current = data.nextCursor;
      })
      .catch((err) => {
        // Ignore abort errors triggered by quick session switches
        // 快速切换会话时忽略 abort 错误
        if ((err as { name?: string }).name === 'AbortError') return;
        setError((err as Error).message);
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [projectId, sessionId]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const cursor = cursorRef.current;
    if (!cursor) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const slice = await sessionsApi.messages(projectId, sessionId, {
        after: cursor,
        limit: PAGE_SIZE,
      });
      setMessages((prev) => prev.concat(slice.messages));
      setNextCursor(slice.nextCursor);
      cursorRef.current = slice.nextCursor;
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') {
        console.error('Failed to load more messages:', err);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [projectId, sessionId]);

  // Subscribe to SSE-driven live-append for this exact session.
  // Cursor monotonicity: only fetch after the current tail (last loaded msg).
  // If the user has paginated all the way to nextCursor=null AND there are
  // newer messages on disk, this fetch picks them up via the last uuid in state.
  // 订阅当前会话的实时追加；以已加载尾巴 uuid 作为 cursor，单调推进
  useEffect(() => {
    if (!registerLiveAppend) return;
    const key = `${projectId}/${sessionId}`;
    const append = async (): Promise<void> => {
      if (loadingMoreRef.current) return;
      const tail = messagesRef.current[messagesRef.current.length - 1];
      if (!tail) return;
      loadingMoreRef.current = true;
      try {
        const slice = await sessionsApi.messages(projectId, sessionId, {
          after: tail.uuid,
          limit: PAGE_SIZE,
        });
        if (slice.messages.length === 0) return;
        // De-dup against in-flight pagination: only append uuids we don't have
        // 去重（和 endReached 在途请求冲突时的兜底）
        const known = new Set(messagesRef.current.map((m) => m.uuid));
        const fresh = slice.messages.filter((m) => !known.has(m.uuid));
        if (fresh.length === 0) return;
        setMessages((prev) => prev.concat(fresh));
        // Only advance the user-pagination cursor if we already exhausted it;
        // otherwise the existing nextCursor still points to the user-visible tail.
        // 仅当用户翻页 cursor 已耗尽才推进；否则保持原 cursor
        if (cursorRef.current === null) {
          setNextCursor(slice.nextCursor);
          cursorRef.current = slice.nextCursor;
        }
        if (atBottomRef.current && virtuosoRef.current) {
          // Defer scroll to next frame so Virtuoso has measured the new rows
          // 推迟到下一帧，等 Virtuoso 完成测量
          setTimeout(() => virtuosoRef.current?.scrollToIndex({
            index: messagesRef.current.length - 1,
            behavior: 'smooth',
            align: 'end',
          }), 30);
        }
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') {
          console.error('live-append failed:', err);
        }
      } finally {
        loadingMoreRef.current = false;
      }
    };
    return registerLiveAppend(key, append);
  }, [projectId, sessionId, registerLiveAppend]);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: Math.max(0, messages.length - 1),
      behavior: 'smooth',
      align: 'end',
    });
  }, [messages.length]);

  const visibleMessages = useMemo(
    () => messages.filter((m) => {
      if (m.role === 'system') return false;
      return m.content.length > 0;
    }),
    [messages]
  );

  // Filter genuine user input: exclude tool_result blocks, system-injected XML tags
  // 过滤真实用户输入：排除 tool_result 块、系统注入的 XML 标签
  const userMessages = useMemo(() => visibleMessages.filter((m) => {
    if (m.role !== 'user') return false;
    // Must have at least one text block / 必须有至少一个文本块
    const textBlocks = m.content.filter((b) => b.type === 'text' && b.text);
    if (textBlocks.length === 0) return false;
    // If ALL content is tool_result, it's a tool response / 如果全部是 tool_result，是工具返回
    const hasOnlyToolResults = m.content.every((b) => b.type === 'tool_result');
    if (hasOnlyToolResults) return false;
    // Check if text is system-injected XML / 检查文本是否为系统注入的 XML
    const firstText = (textBlocks[0].text || '').trim();
    const systemPrefixes = [
      '<bash-input>', '<bash-stdout>', '<bash-stderr>',
      '<command-message>', '<command-name>', '<command-args>',
      '<local-command-caveat>', '<local-command-stdout>',
      '<task-notification>', '<system-reminder>',
      '<user-prompt-submit-hook>',
    ];
    if (systemPrefixes.some((p) => firstText.startsWith(p))) return false;
    return true;
  }), [visibleMessages]);
  const compactGroups = useMemo(() => buildCompactGroups(visibleMessages), [visibleMessages]);
  const fileChanges = useMemo(() => extractFileChanges(messages), [messages]);

  const viewModes: { id: ViewMode; icon: React.ReactNode; label: string; count?: number }[] = [
    { id: 'full', icon: <Layers size={12} />, label: t('chat.view_full') },
    { id: 'dialog', icon: <MessageSquare size={12} />, label: t('chat.view_dialog'), count: userMessages.length },
    { id: 'compact', icon: <Zap size={12} />, label: t('chat.view_compact'), count: compactGroups.length },
    { id: 'changes', icon: <FileCode size={12} />, label: t('chat.view_changes'), count: fileChanges.length },
  ];

  return (
    <div data-testid="chat-viewer" className="flex flex-col h-full relative">
      {/* Header bar / 头部栏 */}
      <div
        className="flex items-center gap-4 px-8 py-5 border-b"
        style={{ borderColor: 'var(--border-default)', background: 'var(--surface-0)' }}
      >
        <button data-testid="chat-back" onClick={onBack} className="btn btn-ghost !p-2.5">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-[17px] font-bold truncate leading-tight" style={{ color: 'var(--txt-1)', letterSpacing: '-0.018em' }}>
            {(meta as Record<string, unknown>)?.summary as string || sessionId}
          </h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-[12px] font-medium" style={{ color: 'var(--txt-3)' }}>
              {visibleMessages.length} {t('sessions.messages')}
            </span>
            {(meta as Record<string, unknown>)?.gitBranch && (
              <span className="text-[12px] font-medium font-mono px-2 py-0.5 rounded" style={{ background: 'var(--surface-2)', color: 'var(--txt-2)' }}>
                {(meta as Record<string, unknown>).gitBranch as string}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => onViewAudit?.()}
          className="btn btn-ghost !text-[13px] !font-semibold"
        >
          <Shield size={16} />
          {t('sessions.view_commands')}
        </button>
      </div>

      {/* View mode tabs / 视图模式标签 */}
      <div
        className="flex items-center gap-1.5 px-8 py-3 border-b"
        style={{ borderColor: 'var(--border-default)', background: 'var(--surface-0)' }}
      >
        {viewModes.map((mode) => (
          <button
            key={mode.id}
            data-testid={`view-tab-${mode.id}`}
            data-active={viewMode === mode.id ? 'true' : 'false'}
            onClick={() => { setViewMode(mode.id); setDisplayCount(PAGE_SIZE); }}
            className={`view-tab ${viewMode === mode.id ? 'active' : ''}`}
          >
            {mode.icon}
            <span>{mode.label}</span>
            {mode.count != null && (
              <span
                className="px-1.5 rounded"
                style={{
                  background: viewMode === mode.id ? 'var(--accent)' : 'var(--surface-2)',
                  color: viewMode === mode.id ? '#fff' : 'var(--txt-3)',
                  fontSize: '0.65rem',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontWeight: 700,
                }}
              >
                {mode.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content area / 内容区域 */}
      <div className="flex-1 overflow-hidden relative">
        {loading && (
          <div className="px-8 py-6 space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-20 rounded-md" />
            ))}
          </div>
        )}

        {error && (
          <div className="text-center p-8">
            <AlertTriangle size={24} className="mx-auto mb-2" style={{ color: 'var(--status-err)' }} />
            <p className="text-sm" style={{ color: 'var(--status-err)' }}>{error}</p>
            <button onClick={() => window.location.reload()} className="btn btn-ghost mt-2">
              {t('common.retry')}
            </button>
          </div>
        )}

        {/* Full view — virtualized / 完整视图（虚拟化） */}
        {!loading && !error && viewMode === 'full' && (
          visibleMessages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><Bot size={28} /></div>
              <p className="text-sm">{t('chat.no_messages')}</p>
            </div>
          ) : (
            <Virtuoso
              ref={virtuosoRef as never}
              style={{ height: '100%' }}
              className="px-8 py-6"
              data={visibleMessages}
              endReached={loadMore}
              increaseViewportBy={{ top: 400, bottom: 800 }}
              atBottomStateChange={setAtBottom}
              rangeChanged={(range) => setShowScrollBtn(range.endIndex < visibleMessages.length - 5)}
              computeItemKey={(_idx, msg) => msg.uuid}
              itemContent={(idx, msg) => (
                <div className="pb-5">
                  {idx > 0 && msg.role === 'user' && <div className="msg-divider" />}
                  <MessageBubble message={msg} />
                </div>
              )}
              components={{
                Footer: () => (loadingMore || nextCursor)
                  ? <div className="text-center py-4 text-2xs" style={{ color: 'var(--txt-3)' }}>
                      {loadingMore ? '...' : ''}
                    </div>
                  : null,
              }}
            />
          )
        )}

        {/* Dialog view (user input only) / 对话视图（仅用户输入；条目通常较少，不虚拟化） */}
        {!loading && !error && viewMode === 'dialog' && (
          <div className="h-full overflow-y-auto px-8 py-6 space-y-5">
            {userMessages.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon"><User size={28} /></div>
                <p className="text-sm">{t('chat.no_messages')}</p>
              </div>
            )}
            {userMessages.map((msg, idx) => (
              <DialogUserRow key={msg.uuid} msg={msg} index={idx} isLast={idx === userMessages.length - 1} />
            ))}
          </div>
        )}

        {/* Compact view — virtualized / 精简视图（虚拟化） */}
        {!loading && !error && viewMode === 'compact' && (
          compactGroups.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><Zap size={28} /></div>
              <p className="text-sm">{t('chat.no_commands_compact')}</p>
            </div>
          ) : (
            <Virtuoso
              style={{ height: '100%' }}
              className="px-8 py-6"
              data={compactGroups}
              endReached={loadMore}
              increaseViewportBy={{ top: 400, bottom: 800 }}
              computeItemKey={(_idx, group) => group.userMessage.uuid}
              itemContent={(idx, group) => (
                <div className="pb-5">
                  {idx > 0 && <div className="msg-divider" />}
                  <CompactGroupView group={group} />
                </div>
              )}
            />
          )
        )}

        {/* Changes view / 变更视图（条目数有限，不虚拟化） */}
        {!loading && !error && viewMode === 'changes' && (
          <div className="h-full overflow-y-auto px-8 py-6 space-y-5">
            {fileChanges.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon"><FileCode size={28} /></div>
                <p className="text-sm">{t('chat.no_changes')}</p>
              </div>
            )}
            {fileChanges.length > 0 && (
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <span className="text-2xs font-medium" style={{ color: 'var(--txt-2)' }}>
                  {fileChanges.length} changes
                </span>
                <span className="change-type-badge change-type-write">
                  <FilePlus size={10} className="mr-1" />
                  {fileChanges.filter((c) => c.isNew).length} created
                </span>
                <span className="change-type-badge change-type-edit">
                  <FileEdit size={10} className="mr-1" />
                  {fileChanges.filter((c) => !c.isNew).length} modified
                </span>
              </div>
            )}
            <div className="space-y-3">
              {fileChanges.map((change, idx) => (
                <FileChangeCard key={`${change.filePath}-${idx}`} change={change} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Scroll to bottom / 滚到底部 */}
      {showScrollBtn && !atBottom && (
        <button onClick={scrollToBottom} className="scroll-bottom-btn animate-fade-in" style={{ position: 'absolute', bottom: 24, right: 24 }}>
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}

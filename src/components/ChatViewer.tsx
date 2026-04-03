/**
 * Chat viewer / 聊天查看器
 * Renders session messages with Markdown, code blocks, and tool use
 * 渲染会话消息，支持 Markdown、代码块和工具调用
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, User, Bot, Terminal, AlertTriangle,
  Copy, Check, ChevronDown, ChevronRight, Shield,
  ArrowDown,
} from 'lucide-react';
import { sessions as sessionsApi, type ParsedMessage, type ContentBlock } from '../utils/api';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Props {
  projectId: string;
  sessionId: string;
  onBack: () => void;
}

// Configure marked for safe rendering / 配置 marked 安全渲染
marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string;
  return DOMPurify.sanitize(raw);
}

function ToolUseBlock({ block }: { block: ContentBlock }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  const input = block.input || {};
  // Format Bash command specially / 特殊格式化 Bash 命令
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
}

function ToolResultBlock({ block }: { block: ContentBlock }) {
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
}

function MessageBubble({ message }: { message: ParsedMessage }) {
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

  return (
    <div className="animate-fade-in">
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

      {/* Text content / 文本内容 */}
      {textContent && (
        <div
          className={`${bubbleClass} rounded-md p-3 markdown-body`}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }}
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
}

export default function ChatViewer({ projectId, sessionId, onBack }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    sessionsApi.get(projectId, sessionId)
      .then((data) => {
        setMessages(data.messages);
        setMeta(data.meta as unknown as Record<string, unknown>);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectId, sessionId]);

  // Track scroll position for scroll-to-bottom button / 跟踪滚动位置
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowScrollBtn(scrollHeight - scrollTop - clientHeight > 200);
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  // Filter out empty system messages / 过滤空系统消息
  const visibleMessages = useMemo(
    () => messages.filter((m) => {
      if (m.role === 'system') return false;
      return m.content.length > 0;
    }),
    [messages]
  );

  return (
    <div className="flex flex-col h-full relative">
      {/* Header bar / 头部栏 */}
      <div
        className="flex items-center gap-3 px-4 py-3 border-b"
        style={{ borderColor: 'var(--border-default)', background: 'var(--surface-0)' }}
      >
        <button onClick={onBack} className="btn btn-ghost p-1.5">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: 'var(--txt-1)' }}>
            {(meta as Record<string, unknown>)?.summary as string || sessionId}
          </p>
          <p className="text-2xs" style={{ color: 'var(--txt-3)' }}>
            {visibleMessages.length} {t('sessions.messages')}
            {(meta as Record<string, unknown>)?.gitBranch && (
              <span className="ml-2">
                {t('sessions.branch')}: {(meta as Record<string, unknown>).gitBranch as string}
              </span>
            )}
          </p>
        </div>
        <a
          href="#audit"
          onClick={(e) => { e.preventDefault(); /* navigate to audit view */ }}
          className="btn btn-ghost text-2xs"
        >
          <Shield size={14} />
          {t('sessions.view_commands')}
        </a>
      </div>

      {/* Messages / 消息列表 */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-5 relative">
        {loading && (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-20 rounded-md" style={{ animationDelay: `${i * 100}ms` }} />
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

        {!loading && !error && visibleMessages.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Bot size={28} />
            </div>
            <p className="text-sm">{t('chat.no_messages')}</p>
          </div>
        )}

        {visibleMessages.map((msg, idx) => (
          <div key={msg.uuid}>
            {idx > 0 && msg.role === 'user' && <div className="msg-divider" />}
            <MessageBubble message={msg} />
          </div>
        ))}
      </div>

      {/* Scroll to bottom / 滚到底部 */}
      {showScrollBtn && (
        <button onClick={scrollToBottom} className="scroll-bottom-btn animate-fade-in" style={{ position: 'absolute', bottom: 24, right: 24 }}>
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}

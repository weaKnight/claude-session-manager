/**
 * Dialog view single user row / 对话视图单条用户消息行
 *
 * Extracted into its own file so renderMarkdown's sanitized HTML can be
 * inlined without re-introducing the pattern across the main viewer.
 * 抽离到独立文件——把已 DOMPurify 消毒的 HTML 渲染集中在一处
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { User } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ParsedMessage, ContentBlock } from '../utils/api';

// Local LRU markdown cache — same contract as ChatViewer's
// 本地 LRU 缓存（语义同 ChatViewer）
const CACHE_LIMIT = 1000;
const cache = new Map<string, string>();

function render(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const html = DOMPurify.sanitize(marked.parse(text) as string);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, html);
  return html;
}

interface Props {
  msg: ParsedMessage;
  index: number;
  isLast: boolean;
}

const DialogUserRow = memo(function DialogUserRow({ msg, index, isLast }: Props) {
  const { t } = useTranslation();

  const userText = msg.content
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');

  const html = userText ? render(userText) : '';

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2 mb-1.5">
        <User size={14} style={{ color: 'var(--status-info)' }} />
        <span
          className="text-2xs font-medium px-1.5 py-0.5 rounded"
          style={{
            background: 'var(--surface-2)',
            color: 'var(--txt-3)',
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          #{index + 1}
        </span>
        <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>
          {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : t('chat.user')}
        </span>
      </div>
      {html && (
        <div
          className="msg-user rounded-md p-3 markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {!isLast && <div className="msg-divider" />}
    </div>
  );
}, (prev, next) => prev.msg.uuid === next.msg.uuid && prev.isLast === next.isLast && prev.index === next.index);

export default DialogUserRow;

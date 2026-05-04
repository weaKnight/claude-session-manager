/**
 * Session list / 会话列表
 * Shows sessions for a selected project with metadata
 * 展示选中项目的会话及元数据
 */

import { useTranslation } from 'react-i18next';
import { MessageSquare, GitBranch, Clock, Bot, Trash2 } from 'lucide-react';
import type { SessionMeta } from '../utils/api';
import { sessions as sessionsApi } from '../utils/api';
import { memo, useMemo, useState } from 'react';

interface Props {
  sessions: SessionMeta[];
  projectId: string | null;
  onSelect: (projectId: string, sessionId: string) => void;
  onRefresh: () => void;
}

function formatTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function formatTokens(tokens: SessionMeta['totalTokens']): string {
  const total = (tokens.input_tokens || 0) + (tokens.output_tokens || 0);
  if (total > 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total > 1_000) return `${(total / 1_000).toFixed(0)}K`;
  return String(total);
}

interface RowProps {
  session: SessionMeta;
  projectId: string;
  maxTokens: number;
  deleting: boolean;
  onSelect: (projectId: string, sessionId: string) => void;
  onDelete: (e: React.MouseEvent, sessionId: string) => void;
}

// Hoisted memoized row — only re-renders when its own session record changes,
// not when sibling rows mutate. Previously the parent recomputed maxTokens
// inside .map() (O(N²)).
// 提升为 memo 行——只在自身记录变更时重渲染
const SessionRow = memo(function SessionRow({ session, projectId, maxTokens, deleting, onSelect, onDelete }: RowProps) {
  const { t } = useTranslation();
  const totalTokens = (session.totalTokens.input_tokens || 0) + (session.totalTokens.output_tokens || 0);
  const tokenPct = Math.round((totalTokens / maxTokens) * 100);

  return (
    <div
      data-testid="session-item"
      data-session-id={session.id}
      onClick={() => onSelect(projectId, session.id)}
      className="group card p-6 cursor-pointer hover:translate-y-[-2px] animate-fade-in"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {session.isAgent && (
              <span className="badge badge-tool">
                <Bot size={11} className="mr-1" />
                {t('sessions.agent_session')}
              </span>
            )}
          </div>
          <p
            className="text-[16px] font-semibold truncate leading-snug group-hover:text-[color:var(--accent)] transition-colors"
            style={{ color: 'var(--txt-1)', letterSpacing: '-0.012em' }}
          >
            {session.summary || session.id}
          </p>

          <div className="flex items-center gap-4 mt-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--txt-3)' }}>
              <Clock size={13} />
              {formatTime(session.lastTimestamp)}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--txt-3)' }}>
              <MessageSquare size={13} />
              {session.messageCount} {t('sessions.messages')}
            </span>
            {session.gitBranch && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--txt-3)' }}>
                <GitBranch size={13} />
                {session.gitBranch}
              </span>
            )}
            <span
              className="text-[12px] font-bold px-2 py-0.5 rounded-md ml-auto"
              style={{ background: 'var(--surface-2)', color: 'var(--txt-2)', fontFamily: 'JetBrains Mono, monospace' }}
            >
              {formatTokens(session.totalTokens)} tok
            </span>
          </div>

          <div className="mt-4">
            <div className="token-bar !h-1.5">
              <div className="token-bar-fill" style={{ width: `${tokenPct}%` }} />
            </div>
          </div>
        </div>

        <button
          onClick={(e) => onDelete(e, session.id)}
          className="btn btn-ghost !p-2.5 opacity-0 group-hover:opacity-100 hover:!opacity-100 transition-opacity"
          style={{ color: 'var(--txt-3)' }}
          disabled={deleting}
          title={t('sessions.delete')}
        >
          {deleting ? <span className="spinner" /> : <Trash2 size={16} />}
        </button>
      </div>
    </div>
  );
}, (prev, next) =>
  prev.session.id === next.session.id
  && prev.session.lastTimestamp === next.session.lastTimestamp
  && prev.session.messageCount === next.session.messageCount
  && prev.maxTokens === next.maxTokens
  && prev.deleting === next.deleting,
);

export default function SessionList({ sessions, projectId, onSelect, onRefresh }: Props) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState<string | null>(null);

  // Hoist out of the row .map() — was O(N²) per row before
  // 从 .map() 内提取——之前每行重算一次 max
  const maxTokens = useMemo(() => {
    let max = 1;
    for (const s of sessions) {
      const t = (s.totalTokens.input_tokens || 0) + (s.totalTokens.output_tokens || 0);
      if (t > max) max = t;
    }
    return max;
  }, [sessions]);

  if (!projectId) {
    return (
      <div className="empty-state h-full">
        <div className="empty-state-icon">
          <MessageSquare size={28} />
        </div>
        <p className="text-sm">{t('projects.no_projects')}</p>
        <p className="text-2xs mt-1" style={{ color: 'var(--txt-3)' }}>
          Select a project from the sidebar
        </p>
      </div>
    );
  }

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!confirm(t('sessions.delete_confirm'))) return;
    setDeleting(sessionId);
    try {
      await sessionsApi.delete(projectId, sessionId);
      onRefresh();
    } catch (err) {
      console.error('Delete failed:', err);
    }
    setDeleting(null);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-10 pt-10 pb-6 max-w-6xl mx-auto">
        <div className="flex items-end justify-between gap-4 mb-8">
          <div>
            <h1
              className="text-4xl font-bold tracking-tight"
              style={{ color: 'var(--txt-1)', letterSpacing: '-0.035em' }}
            >
              {t('sessions.title')}
            </h1>
            <p className="text-[15px] mt-1.5" style={{ color: 'var(--txt-2)' }}>
              {sessions.length} {sessions.length === 1 ? 'conversation' : 'conversations'} in this project
            </p>
          </div>
          <span
            className="text-[12px] font-mono font-bold px-4 py-2 rounded-full"
            style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
          >
            {sessions.length.toString().padStart(2, '0')}
          </span>
        </div>

        {sessions.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">
              <MessageSquare size={32} />
            </div>
            <p className="text-[15px] mt-2">{t('sessions.no_sessions')}</p>
          </div>
        )}

        <div className="space-y-3.5">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              projectId={projectId}
              maxTokens={maxTokens}
              deleting={deleting === session.id}
              onSelect={onSelect}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

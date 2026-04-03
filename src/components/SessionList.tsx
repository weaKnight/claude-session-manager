/**
 * Session list / 会话列表
 * Shows sessions for a selected project with metadata
 * 展示选中项目的会话及元数据
 */

import { useTranslation } from 'react-i18next';
import { MessageSquare, GitBranch, Clock, Bot, Trash2 } from 'lucide-react';
import type { SessionMeta } from '../utils/api';
import { sessions as sessionsApi } from '../utils/api';
import { useState } from 'react';

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

export default function SessionList({ sessions, projectId, onSelect, onRefresh }: Props) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState<string | null>(null);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--txt-3)' }}>
        <div className="text-center">
          <MessageSquare size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('projects.no_projects')}</p>
        </div>
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
    <div className="h-full overflow-y-auto p-4">
      <h2 className="text-lg font-medium mb-4" style={{ color: 'var(--txt-1)' }}>
        {t('sessions.title')}
        <span className="text-sm font-normal ml-2" style={{ color: 'var(--txt-3)' }}>
          ({sessions.length})
        </span>
      </h2>

      {sessions.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--txt-3)' }}>{t('sessions.no_sessions')}</p>
      )}

      <div className="space-y-2">
        {sessions.map((session) => (
          <div
            key={session.id}
            onClick={() => onSelect(projectId, session.id)}
            className="card p-4 cursor-pointer transition-all hover:translate-x-0.5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                {/* Summary / 摘要 */}
                <p className="text-sm font-medium truncate" style={{ color: 'var(--txt-1)' }}>
                  {session.isAgent && (
                    <span className="badge badge-tool mr-2">
                      <Bot size={10} className="mr-1" />
                      {t('sessions.agent_session')}
                    </span>
                  )}
                  {session.summary || session.id}
                </p>

                {/* Metadata row / 元数据行 */}
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-2xs" style={{ color: 'var(--txt-3)' }}>
                    <Clock size={12} />
                    {formatTime(session.lastTimestamp)}
                  </span>
                  <span className="inline-flex items-center gap-1 text-2xs" style={{ color: 'var(--txt-3)' }}>
                    <MessageSquare size={12} />
                    {session.messageCount} {t('sessions.messages')}
                  </span>
                  {session.gitBranch && (
                    <span className="inline-flex items-center gap-1 text-2xs" style={{ color: 'var(--txt-3)' }}>
                      <GitBranch size={12} />
                      {session.gitBranch}
                    </span>
                  )}
                  <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>
                    {formatTokens(session.totalTokens)} {t('sessions.tokens')}
                  </span>
                </div>
              </div>

              {/* Delete button / 删除按钮 */}
              <button
                onClick={(e) => handleDelete(e, session.id)}
                className="btn btn-ghost p-1.5 opacity-0 group-hover:opacity-100 hover:!opacity-100"
                style={{ color: 'var(--txt-3)' }}
                disabled={deleting === session.id}
                title={t('sessions.delete')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

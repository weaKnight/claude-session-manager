/**
 * Trash panel / 回收站面板
 * Shows deleted sessions with restore and empty actions
 * 展示已删除的会话，支持恢复和清空操作
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, RotateCcw, AlertTriangle } from 'lucide-react';
import { trash as trashApi, type TrashItem } from '../utils/api';

export default function TrashPanel() {
  const { t } = useTranslation();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  const loadTrash = useCallback(async () => {
    try {
      const { items } = await trashApi.list();
      setItems(items);
    } catch (err) {
      console.error('Failed to load trash:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTrash(); }, [loadTrash]);

  // Restore a session / 恢复会话
  const handleRestore = async (fileName: string) => {
    setRestoring(fileName);
    try {
      await trashApi.restore(fileName);
      await loadTrash();
    } catch (err) {
      console.error('Restore failed:', err);
    }
    setRestoring(null);
  };

  // Empty entire trash / 清空回收站
  const handleEmpty = async () => {
    if (!confirm(t('trash.empty_confirm'))) return;
    try {
      await trashApi.empty();
      setItems([]);
    } catch (err) {
      console.error('Empty trash failed:', err);
    }
  };

  // Format deleted time / 格式化删除时间
  const formatDeletedAt = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  // Format file size / 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
    return `${bytes} B`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="spinner" style={{ width: 24, height: 24 }} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium" style={{ color: 'var(--txt-1)' }}>
          {t('trash.title')}
          <span className="text-sm font-normal ml-2" style={{ color: 'var(--txt-3)' }}>
            ({items.length})
          </span>
        </h2>
        {items.length > 0 && (
          <button
            onClick={handleEmpty}
            className="btn btn-ghost text-xs flex items-center gap-1.5 px-3 py-1.5"
            style={{ color: 'var(--status-error)' }}
          >
            <AlertTriangle size={14} />
            {t('trash.empty')}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Trash2 size={28} />
          </div>
          <p className="text-sm">{t('trash.no_items')}</p>
          <p className="text-2xs mt-1" style={{ color: 'var(--txt-3)' }}>
            Deleted sessions will appear here
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div
              key={item.fileName}
              className="group card p-4 animate-fade-in"
              style={{ animationDelay: `${idx * 40}ms` }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--txt-1)' }}>
                    {item.sessionId}
                  </p>
                  <div className="flex items-center gap-3 mt-1 text-2xs" style={{ color: 'var(--txt-3)' }}>
                    <span className="font-medium" style={{ color: 'var(--txt-2)' }}>{item.projectId}</span>
                    <span>{formatDeletedAt(item.deletedAt)}</span>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{formatSize(item.fileSize)}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleRestore(item.fileName)}
                  disabled={restoring === item.fileName}
                  className="btn btn-ghost p-2 flex items-center gap-1.5 text-xs opacity-0 group-hover:opacity-100 hover:!opacity-100 transition-opacity"
                  style={{ color: 'var(--accent)' }}
                  title={t('trash.restore')}
                >
                  <RotateCcw size={14} className={restoring === item.fileName ? 'animate-spin' : ''} />
                  {t('trash.restore')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

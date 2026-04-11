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
    <div className="h-full overflow-y-auto px-10 pt-10 pb-6 max-w-6xl mx-auto w-full">
      <div className="flex items-end justify-between gap-4 mb-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight" style={{ color: 'var(--txt-1)', letterSpacing: '-0.035em' }}>
            {t('trash.title')}
          </h1>
          <p className="text-[15px] mt-1.5" style={{ color: 'var(--txt-2)' }}>
            {items.length} deleted {items.length === 1 ? 'session' : 'sessions'} — restorable until purged
          </p>
        </div>
        {items.length > 0 && (
          <button
            onClick={handleEmpty}
            className="btn btn-ghost !text-[13px] !font-semibold"
            style={{ color: 'var(--status-err)' }}
          >
            <AlertTriangle size={16} />
            {t('trash.empty')}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Trash2 size={32} />
          </div>
          <p className="text-[15px] mt-2">{t('trash.no_items')}</p>
          <p className="text-[12px] mt-1" style={{ color: 'var(--txt-3)' }}>
            Deleted sessions will appear here
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div
              key={item.fileName}
              className="group card p-5 animate-fade-in"
              style={{ animationDelay: `${idx * 40}ms` }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold truncate" style={{ color: 'var(--txt-1)', letterSpacing: '-0.012em' }}>
                    {item.sessionId}
                  </p>
                  <div className="flex items-center gap-3 mt-2 text-[12px] font-medium" style={{ color: 'var(--txt-3)' }}>
                    <span className="font-semibold" style={{ color: 'var(--txt-2)' }}>{item.projectId}</span>
                    <span>{formatDeletedAt(item.deletedAt)}</span>
                    <span className="px-2 py-0.5 rounded font-bold" style={{ background: 'var(--surface-2)', color: 'var(--txt-2)', fontFamily: 'JetBrains Mono, monospace' }}>{formatSize(item.fileSize)}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleRestore(item.fileName)}
                  disabled={restoring === item.fileName}
                  className="btn btn-ghost flex items-center gap-2 !text-[13px] !font-semibold opacity-0 group-hover:opacity-100 hover:!opacity-100 transition-opacity"
                  style={{ color: 'var(--accent)' }}
                  title={t('trash.restore')}
                >
                  <RotateCcw size={16} className={restoring === item.fileName ? 'animate-spin' : ''} />
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

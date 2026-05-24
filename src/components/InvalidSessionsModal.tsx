/**
 * Invalid sessions cleanup modal / 清理无效会话模态框
 * Scans a project for sessions that are likely safe to remove (empty, very
 * short, no real user input, or corrupt), then lets the user soft-delete the
 * selected ones into the trash (restorable).
 * 扫描项目中可安全移除的会话（空、极短、无真实用户输入、损坏），让用户把选中的
 * 软删除到回收站（可恢复）。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, X, Loader2, Bot } from 'lucide-react';
import { sessions as sessionsApi, type InvalidReason, type InvalidSessionHit } from '../utils/api';

interface InvalidSessionsModalProps {
  projectId: string;
  onClose: () => void;
  onDeleted: () => void;
}

// Scan criteria flags / 扫描条件标志
interface Criteria {
  empty: boolean;
  tooShort: boolean;
  noUserInput: boolean;
  corrupt: boolean;
  threshold: number;
}

const REASON_KEYS: Record<InvalidReason, string> = {
  empty: 'cleanup.reason_empty',
  too_short: 'cleanup.reason_too_short',
  no_user_input: 'cleanup.reason_no_user_input',
  corrupt: 'cleanup.reason_corrupt',
};

export default function InvalidSessionsModal({ projectId, onClose, onDeleted }: InvalidSessionsModalProps) {
  const { t } = useTranslation();

  // All four criteria default to checked / 四个条件默认全部勾选
  const [criteria, setCriteria] = useState<Criteria>({
    empty: true,
    tooShort: true,
    noUserInput: true,
    corrupt: true,
    threshold: 1,
  });

  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [hits, setHits] = useState<InvalidSessionHit[]>([]);
  // Selected session ids in the result list / 结果列表中选中的会话 id
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Close on Escape / 按 Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const allSelected = hits.length > 0 && selected.size === hits.length;

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(hits.map((h) => h.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleScan = async () => {
    if (scanning) return;
    setError(null);
    setScanning(true);
    try {
      const { sessions: found } = await sessionsApi.scanInvalid(projectId, criteria);
      setHits(found);
      // Pre-select every hit by default / 默认全选所有命中项
      setSelected(new Set(found.map((h) => h.id)));
      setScanned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setScanning(false);
    }
  };

  const handleDelete = async () => {
    if (deleting || selected.size === 0) return;
    const ids = Array.from(selected);
    if (!confirm(t('cleanup.delete_confirm', { count: ids.length }))) return;
    setError(null);
    setDeleting(true);
    try {
      // No force → soft delete to trash / 不传 force → 软删到回收站
      await sessionsApi.batchDelete(projectId, ids);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setDeleting(false);
    }
  };

  // The very-short threshold input is only usable when "too short" is on.
  // 极短阈值输入框仅在勾选「极短」时可用。
  const thresholdDisabled = !criteria.tooShort;

  const checkboxStyle = { accentColor: 'var(--accent)' } as const;

  const criteriaRows = useMemo(
    () => [
      { key: 'empty' as const, label: t('cleanup.criteria_empty') },
      { key: 'tooShort' as const, label: t('cleanup.criteria_too_short') },
      { key: 'noUserInput' as const, label: t('cleanup.criteria_no_user_input') },
      { key: 'corrupt' as const, label: t('cleanup.criteria_corrupt') },
    ],
    [t],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
      data-testid="invalid-sessions-modal"
    >
      <div
        className="card w-full max-w-lg p-7 flex flex-col"
        style={{ animation: 'fade-in-scale 0.25s ease-out', boxShadow: 'var(--shadow-xl)', maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header / 头部 */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-xl"
              style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
            >
              <Eraser size={18} />
            </div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--txt-1)' }}>
              {t('cleanup.title')}
            </h2>
          </div>
          <button onClick={onClose} className="btn btn-ghost !p-2" title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        {/* Criteria area / 条件区 */}
        <p className="text-[13px] mb-3" style={{ color: 'var(--txt-2)' }}>
          {t('cleanup.desc')}
        </p>
        <div className="space-y-2.5 mb-4">
          {criteriaRows.map((row) => (
            <label key={row.key} className="flex items-center gap-2.5 cursor-pointer text-[14px]" style={{ color: 'var(--txt-1)' }}>
              <input
                type="checkbox"
                checked={criteria[row.key]}
                onChange={(e) => setCriteria((c) => ({ ...c, [row.key]: e.target.checked }))}
                style={checkboxStyle}
              />
              {row.label}
            </label>
          ))}
          <div className="flex items-center gap-2.5 pt-1">
            <span className="text-[13px]" style={{ color: thresholdDisabled ? 'var(--txt-3)' : 'var(--txt-2)' }}>
              {t('cleanup.threshold_label')}
            </span>
            <input
              type="number"
              min={0}
              value={criteria.threshold}
              disabled={thresholdDisabled}
              onChange={(e) => setCriteria((c) => ({ ...c, threshold: Math.max(0, Number(e.target.value) || 0) }))}
              className="input !w-24 !py-2 !px-3 !text-[14px]"
              style={{ opacity: thresholdDisabled ? 0.5 : 1 }}
            />
          </div>
        </div>

        <button
          onClick={handleScan}
          className="btn btn-primary w-full !py-2.5 mb-4"
          disabled={scanning}
          style={{ opacity: scanning ? 0.6 : 1 }}
          data-testid="invalid-scan-btn"
        >
          {scanning ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" />
              {t('cleanup.scanning')}
            </span>
          ) : (
            t('cleanup.scan')
          )}
        </button>

        {/* Results area / 结果区 */}
        {scanned && (
          <div className="flex flex-col min-h-0 flex-1">
            {hits.length === 0 ? (
              <div className="empty-state !py-8">
                <p className="text-[14px]">{t('cleanup.no_hits')}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--txt-2)' }}>
                    {t('cleanup.results_count', { count: hits.length })}
                  </span>
                  <button onClick={toggleSelectAll} className="btn btn-ghost !py-1 !px-2 !text-[12px]">
                    {allSelected ? t('cleanup.deselect_all') : t('cleanup.select_all')}
                  </button>
                </div>
                <div className="overflow-y-auto space-y-2 pr-1" style={{ maxHeight: '34vh' }}>
                  {hits.map((hit) => (
                    <label
                      key={hit.id}
                      data-testid="invalid-session-row"
                      className="flex items-start gap-2.5 p-3 rounded-lg cursor-pointer"
                      style={{ background: 'var(--surface-2)' }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(hit.id)}
                        onChange={() => toggleOne(hit.id)}
                        className="mt-0.5"
                        style={checkboxStyle}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {hit.isAgent && (
                            <span className="badge badge-tool">
                              <Bot size={11} className="mr-1" />
                              {t('sessions.agent_session')}
                            </span>
                          )}
                          <span className="text-[14px] font-medium truncate" style={{ color: 'var(--txt-1)' }}>
                            {hit.summary || hit.id}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className="text-[12px]" style={{ color: 'var(--txt-3)' }}>
                            {hit.messageCount} {t('sessions.messages')}
                          </span>
                          {hit.reasons.map((r) => (
                            <span key={r} className="badge badge-error">
                              {t(REASON_KEYS[r])}
                            </span>
                          ))}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {error && (
          <p
            data-testid="invalid-sessions-error"
            className="text-[14px] font-medium px-3 py-2 rounded-lg mt-3"
            style={{ color: 'var(--status-err)', background: 'var(--role-error)' }}
          >
            {error}
          </p>
        )}

        {/* Footer actions / 底部操作 */}
        {scanned && hits.length > 0 && (
          <div className="flex gap-2 pt-4">
            <button type="button" onClick={onClose} className="btn btn-ghost flex-1 !py-2.5">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="btn btn-danger flex-1 !py-2.5"
              disabled={deleting || selected.size === 0}
              style={{ opacity: deleting || selected.size === 0 ? 0.5 : 1 }}
              data-testid="invalid-delete-btn"
            >
              {deleting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {t('common.loading')}
                </span>
              ) : (
                t('cleanup.delete_selected', { count: selected.size })
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Audit panel / 审计面板
 * Displays all tool_use commands from a session in a timeline view
 * 以时间线展示会话中所有 tool_use 命令，便于安全审计
 */

import { useState, useEffect, useMemo, memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';
import {
  Terminal, FileEdit, FileText, FolderSearch, AlertTriangle,
  CheckCircle, XCircle, Filter,
} from 'lucide-react';
import { sessions as sessionsApi, type AuditCommand } from '../utils/api';

interface Props {
  projectId: string;
  sessionId: string;
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Bash: <Terminal size={14} />,
  bash: <Terminal size={14} />,
  Write: <FileEdit size={14} />,
  Edit: <FileEdit size={14} />,
  MultiEdit: <FileEdit size={14} />,
  Read: <FileText size={14} />,
  Grep: <FolderSearch size={14} />,
  Glob: <FolderSearch size={14} />,
  LS: <FolderSearch size={14} />,
};

const TOOL_COLORS: Record<string, string> = {
  Bash: 'var(--status-warn)',
  bash: 'var(--status-warn)',
  Write: 'var(--status-info)',
  Edit: 'var(--status-info)',
  Read: 'var(--txt-3)',
  Grep: 'var(--txt-3)',
  Task: 'var(--accent)',
};

interface RowProps {
  cmd: AuditCommand;
  idx: number;
  expanded: boolean;
  onToggle: (idx: number) => void;
}

const TimelineRow = memo(function TimelineRow({ cmd, idx, expanded, onToggle }: RowProps) {
  return (
    <div className="relative pl-10 pb-3 animate-fade-in">
      <div
        className="absolute left-2.5 top-3 w-3 h-3 rounded-full border-2"
        style={{
          borderColor: cmd.isError ? 'var(--status-err)' : TOOL_COLORS[cmd.toolName] || 'var(--txt-3)',
          background: 'var(--surface-0)',
        }}
      />
      <div className="card p-3 cursor-pointer" onClick={() => onToggle(idx)}>
        <div className="flex items-center gap-2">
          <span style={{ color: TOOL_COLORS[cmd.toolName] || 'var(--txt-3)' }}>
            {TOOL_ICONS[cmd.toolName] || <Terminal size={14} />}
          </span>
          <span className="badge badge-tool">{cmd.toolName}</span>
          {cmd.isError ? (
            <XCircle size={12} style={{ color: 'var(--status-err)' }} />
          ) : (
            <CheckCircle size={12} style={{ color: 'var(--status-ok)' }} />
          )}
          <span className="text-2xs ml-auto" style={{ color: 'var(--txt-3)', fontFamily: 'JetBrains Mono, monospace' }}>
            {cmd.timestamp ? new Date(cmd.timestamp).toLocaleTimeString() : ''}
          </span>
        </div>
        {(cmd.toolName === 'Bash' || cmd.toolName === 'bash') && cmd.input.command && (
          <code
            className="block text-2xs mt-1.5 truncate"
            style={{ color: 'var(--txt-2)', fontFamily: "'JetBrains Mono', monospace" }}
          >
            $ {(cmd.input.command as string).split('\n')[0].slice(0, 100)}
          </code>
        )}
        {expanded && (
          <div className="mt-3 space-y-2">
            <div>
              <span className="text-2xs font-medium" style={{ color: 'var(--txt-3)' }}>Input:</span>
              <pre className="code-block text-2xs mt-1">
                {JSON.stringify(cmd.input, null, 2)}
              </pre>
            </div>
            {cmd.output && (
              <div>
                <span className="text-2xs font-medium" style={{ color: 'var(--txt-3)' }}>Output:</span>
                <pre className="code-block text-2xs mt-1 max-h-48 overflow-y-auto">
                  {cmd.output}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) => prev.cmd.messageUuid === next.cmd.messageUuid && prev.idx === next.idx && prev.expanded === next.expanded);

export default function AuditPanel({ projectId, sessionId }: Props) {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<AuditCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toolFilter, setToolFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    sessionsApi.commands(projectId, sessionId, ctrl.signal)
      .then((data) => setCommands(data.commands))
      .catch((err) => {
        if ((err as { name?: string }).name === 'AbortError') return;
        setError((err as Error).message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [projectId, sessionId]);

  // Get unique tool names for filter / 获取唯一工具名用于筛选
  const toolNames = useMemo(
    () => ['all', ...new Set(commands.map((c) => c.toolName))],
    [commands]
  );

  // Filtered commands / 筛选后的命令
  const filtered = useMemo(
    () => toolFilter === 'all' ? commands : commands.filter((c) => c.toolName === toolFilter),
    [commands, toolFilter]
  );

  const toggleExpand = useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  // Stats / 统计
  const errorCount = commands.filter((c) => c.isError).length;
  const bashCount = commands.filter((c) => c.toolName === 'Bash' || c.toolName === 'bash').length;

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-16 rounded-md" />)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <AlertTriangle size={24} className="mx-auto mb-2" style={{ color: 'var(--status-err)' }} />
        <p className="text-sm" style={{ color: 'var(--status-err)' }}>{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header / 头部 */}
      <div className="px-8 py-6 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <h1 className="text-3xl font-bold tracking-tight" style={{ color: 'var(--txt-1)', letterSpacing: '-0.03em' }}>
          {t('audit.title')}
        </h1>
        <p className="text-[14px] mt-1" style={{ color: 'var(--txt-2)' }}>
          Every command executed in this session, in chronological order
        </p>

        {/* Stats strip / 统计条 */}
        <div className="flex items-center gap-3 mt-5">
          <span
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-bold"
            style={{ background: 'var(--surface-2)', color: 'var(--txt-2)', fontFamily: 'JetBrains Mono, monospace' }}
          >
            {commands.length} COMMANDS
          </span>
          <span
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-bold"
            style={{ background: 'rgba(124, 106, 10, 0.1)', color: 'var(--status-warn)', fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Terminal size={12} />
            {bashCount} SHELL
          </span>
          {errorCount > 0 && (
            <span
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-bold"
              style={{ background: 'var(--role-error)', color: 'var(--status-err)', fontFamily: 'JetBrains Mono, monospace' }}
            >
              <AlertTriangle size={12} />
              {errorCount} {(t('audit.error') as string).toUpperCase()}
            </span>
          )}
        </div>

        {/* Tool filter / 工具筛选 */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <Filter size={16} style={{ color: 'var(--txt-3)' }} />
          {toolNames.map((name) => (
            <button
              key={name}
              onClick={() => setToolFilter(name)}
              className={`inline-flex items-center px-3 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer transition-all ${toolFilter === name ? 'badge-tool' : ''}`}
              style={toolFilter !== name ? { background: 'var(--surface-2)', color: 'var(--txt-2)' } : {}}
            >
              {name === 'all' ? t('audit.filter_tool') : name}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline — virtualized / 虚拟化时间线 */}
      <div className="flex-1 overflow-hidden relative">
        {filtered.length === 0 ? (
          <p className="text-sm text-center py-4" style={{ color: 'var(--txt-3)' }}>
            {t('audit.no_commands')}
          </p>
        ) : (
          <Virtuoso
            style={{ height: '100%' }}
            className="px-8 py-6"
            data={filtered}
            computeItemKey={(idx, cmd) => `${cmd.messageUuid}-${idx}`}
            itemContent={(idx, cmd) => (
              <TimelineRow cmd={cmd} idx={idx} expanded={expanded.has(idx)} onToggle={toggleExpand} />
            )}
          />
        )}
      </div>
    </div>
  );
}

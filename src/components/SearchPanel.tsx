/**
 * Search panel / 搜索面板
 * Full-text search across all sessions
 * 全文搜索所有会话
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Clock, ArrowRight, Loader2 } from 'lucide-react';
import { search as searchApi, type SearchResult } from '../utils/api';

interface Props {
  onNavigate: (projectId: string, sessionId: string) => void;
}

export default function SearchPanel({ onNavigate }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const data = await searchApi.query(query.trim());
      setResults(data.results);
    } catch (err) {
      console.error('Search failed:', err);
      setResults([]);
    }
    setLoading(false);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="h-full flex flex-col px-10 pt-10 pb-6 max-w-6xl mx-auto w-full">
      {/* Header / 头部 */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold tracking-tight" style={{ color: 'var(--txt-1)', letterSpacing: '-0.035em' }}>
          {t('nav.search')}
        </h1>
        <p className="text-[15px] mt-1.5" style={{ color: 'var(--txt-2)' }}>
          Full-text search across every conversation in your workspace
        </p>
      </div>

      {/* Search bar / 搜索栏 */}
      <div className="flex gap-3 mb-6">
        <div className="relative flex-1">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--txt-3)' }}
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="input !pl-12 !py-3.5 !text-base"
            placeholder={t('search.placeholder')}
            autoFocus
          />
        </div>
        <button onClick={handleSearch} className="btn btn-primary !px-7" disabled={loading}>
          {loading ? <Loader2 size={17} className="animate-spin" /> : t('nav.search')}
        </button>
      </div>

      {/* Results / 结果 */}
      <div className="flex-1 overflow-y-auto -mx-2 px-2">
        {searched && !loading && results.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Search size={32} />
            </div>
            <p className="text-[15px] mt-2">{t('search.no_results')}</p>
          </div>
        )}

        {results.length > 0 && (
          <p className="text-[12px] font-semibold uppercase tracking-wider mb-4" style={{ color: 'var(--txt-3)' }}>
            {t('search.results_count', { count: results.length })}
          </p>
        )}

        <div className="space-y-3">
          {results.map((result, idx) => (
            <div
              key={`${result.sessionId}-${idx}`}
              onClick={() => onNavigate(result.projectId, result.sessionId)}
              className="card p-5 cursor-pointer group hover:translate-y-[-2px]"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold truncate group-hover:text-[color:var(--accent)] transition-colors" style={{ color: 'var(--txt-1)', letterSpacing: '-0.012em' }}>
                    {result.summary || result.sessionId}
                  </p>
                  <p className="text-[12px] mt-1 font-bold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>
                    {result.projectName}
                  </p>
                  {result.matchSnippet && (
                    <p className="text-[13px] mt-2 line-clamp-2 leading-relaxed" style={{ color: 'var(--txt-2)' }}>
                      {result.matchSnippet}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-[11px] font-medium" style={{ color: 'var(--txt-3)', fontFamily: 'JetBrains Mono, monospace' }}>
                    <Clock size={12} className="inline mr-1" />
                    {result.timestamp ? new Date(result.timestamp).toLocaleDateString() : ''}
                  </span>
                  <ArrowRight size={16} style={{ color: 'var(--txt-3)' }} className="group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

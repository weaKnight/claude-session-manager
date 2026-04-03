/**
 * Search panel / 搜索面板
 * Full-text search across all sessions
 * 全文搜索所有会话
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Clock, ArrowRight } from 'lucide-react';
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
    <div className="h-full flex flex-col p-4">
      {/* Search bar / 搜索栏 */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--txt-3)' }}
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="input pl-10"
            placeholder={t('search.placeholder')}
            autoFocus
          />
        </div>
        <button onClick={handleSearch} className="btn btn-primary" disabled={loading}>
          {loading ? '...' : t('nav.search')}
        </button>
      </div>

      {/* Results / 结果 */}
      <div className="flex-1 overflow-y-auto">
        {searched && !loading && results.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: 'var(--txt-3)' }}>
            {t('search.no_results')}
          </p>
        )}

        {results.length > 0 && (
          <p className="text-2xs mb-3" style={{ color: 'var(--txt-3)' }}>
            {t('search.results_count', { count: results.length })}
          </p>
        )}

        <div className="space-y-2">
          {results.map((result, idx) => (
            <div
              key={`${result.sessionId}-${idx}`}
              onClick={() => onNavigate(result.projectId, result.sessionId)}
              className="card p-3 cursor-pointer"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--txt-1)' }}>
                    {result.summary || result.sessionId}
                  </p>
                  <p className="text-2xs mt-0.5" style={{ color: 'var(--accent)' }}>
                    {result.projectName}
                  </p>
                  {result.matchSnippet && (
                    <p className="text-2xs mt-1.5 line-clamp-2" style={{ color: 'var(--txt-2)' }}>
                      {result.matchSnippet}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>
                    <Clock size={10} className="inline mr-1" />
                    {result.timestamp ? new Date(result.timestamp).toLocaleDateString() : ''}
                  </span>
                  <ArrowRight size={14} style={{ color: 'var(--txt-3)' }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

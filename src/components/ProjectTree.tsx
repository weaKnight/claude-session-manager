/**
 * Project tree / 项目树
 * Displays projects as a file-manager-style list
 * 以文件管理器样式展示项目列表
 */

import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen } from 'lucide-react';
import type { ProjectInfo } from '../utils/api';

interface Props {
  projects: ProjectInfo[];
  selectedProject: string | null;
  onSelect: (encodedPath: string) => void;
}

export default function ProjectTree({ projects, selectedProject, onSelect }: Props) {
  const { t } = useTranslation();

  if (projects.length === 0) {
    return (
      <div className="empty-state py-8">
        <Folder size={24} className="empty-state-icon p-2" />
        <p className="text-sm">{t('projects.no_projects')}</p>
      </div>
    );
  }

  const maxSessions = Math.max(...projects.map((p) => p.sessionCount), 1);

  return (
    <div className="py-2">
      <div className="section-label">{t('projects.title')}</div>
      {projects.map((project, idx) => {
        const isActive = selectedProject === project.encodedPath;
        const pct = Math.round((project.sessionCount / maxSessions) * 100);
        return (
          <button
            key={project.encodedPath}
            onClick={() => onSelect(project.encodedPath)}
            className={`sidebar-item w-full ${isActive ? 'active' : ''} animate-fade-in`}
            style={{ animationDelay: `${idx * 30}ms` }}
          >
            {isActive ? (
              <FolderOpen size={16} style={{ flexShrink: 0 }} />
            ) : (
              <Folder size={16} style={{ flexShrink: 0 }} />
            )}
            <div className="flex-1 text-left min-w-0">
              <div className="truncate text-sm">{project.displayName}</div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>
                  {project.sessionCount} {t('projects.sessions')}
                </span>
                <div className="token-bar flex-1" style={{ maxWidth: 48 }}>
                  <div className="token-bar-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

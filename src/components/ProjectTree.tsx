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
      <div className="p-4 text-center">
        <p className="text-sm" style={{ color: 'var(--txt-3)' }}>{t('projects.no_projects')}</p>
      </div>
    );
  }

  return (
    <div className="py-2">
      <div className="section-label">{t('projects.title')}</div>
      {projects.map((project) => {
        const isActive = selectedProject === project.encodedPath;
        return (
          <button
            key={project.encodedPath}
            onClick={() => onSelect(project.encodedPath)}
            className={`sidebar-item w-full ${isActive ? 'active' : ''}`}
          >
            {isActive ? (
              <FolderOpen size={16} style={{ flexShrink: 0 }} />
            ) : (
              <Folder size={16} style={{ flexShrink: 0 }} />
            )}
            <div className="flex-1 text-left min-w-0">
              <div className="truncate text-sm">{project.displayName}</div>
              <div className="text-2xs" style={{ color: 'var(--txt-3)' }}>
                {project.sessionCount} {t('projects.sessions')}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

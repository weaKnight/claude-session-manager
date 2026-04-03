/**
 * Main layout / 主布局
 * Sidebar + content area shell
 * 侧边栏 + 内容区域外壳
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderTree, Search, Shield, BarChart3, LogOut,
  Sun, Moon, ChevronLeft, Menu, Wifi, WifiOff,
} from 'lucide-react';
import { projects as projectsApi, type ProjectInfo, type SessionMeta } from '../utils/api';
import { useSSE } from '../hooks/useSSE';
import ProjectTree from './ProjectTree';
import SessionList from './SessionList';
import ChatViewer from './ChatViewer';
import SearchPanel from './SearchPanel';
import AuditPanel from './AuditPanel';

type View = 'projects' | 'search' | 'audit' | 'stats';

interface LayoutProps {
  onLogout: () => void;
}

export default function Layout({ onLogout }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const [dark, setDark] = useState(() =>
    localStorage.getItem('csm_dark') === 'true' ||
    (!localStorage.getItem('csm_dark') && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<View>('projects');
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<{ projectId: string; sessionId: string } | null>(null);
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);

  // Dark mode toggle / 暗色模式切换
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('csm_dark', String(dark));
  }, [dark]);

  // Load projects / 加载项目列表
  const loadProjects = useCallback(async () => {
    try {
      const { projects } = await projectsApi.list();
      setProjectList(projects);
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // SSE live updates / SSE 实时更新
  const { connected } = useSSE((event) => {
    if (event.type === 'add' || event.type === 'change' || event.type === 'remove') {
      loadProjects();
      if (selectedProject === event.projectId) {
        handleSelectProject(event.projectId!);
      }
    }
  });

  // Select project → load sessions / 选择项目 → 加载会话
  const handleSelectProject = async (encodedPath: string) => {
    setSelectedProject(encodedPath);
    setSelectedSession(null);
    try {
      const { sessions } = await projectsApi.sessions(encodedPath);
      setSessionList(sessions);
    } catch (err) {
      console.error('Failed to load sessions:', err);
      setSessionList([]);
    }
  };

  // Select session / 选择会话
  const handleSelectSession = (projectId: string, sessionId: string) => {
    setSelectedSession({ projectId, sessionId });
    setView('projects');
  };

  // Language toggle / 语言切换
  const toggleLang = () => {
    const next = i18n.language.startsWith('zh') ? 'en' : 'zh';
    i18n.changeLanguage(next);
  };

  // Nav items / 导航项
  const navItems: { id: View; icon: React.ReactNode; label: string }[] = [
    { id: 'projects', icon: <FolderTree size={18} />, label: t('nav.projects') },
    { id: 'search', icon: <Search size={18} />, label: t('nav.search') },
    { id: 'audit', icon: <Shield size={18} />, label: t('nav.audit') },
    { id: 'stats', icon: <BarChart3 size={18} />, label: t('nav.stats') },
  ];

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--surface-1)' }}>
      {/* Sidebar / 侧边栏 */}
      <aside
        className="flex flex-col transition-all duration-200 border-r"
        style={{
          width: sidebarOpen ? 280 : 0,
          minWidth: sidebarOpen ? 280 : 0,
          borderColor: 'var(--border-default)',
          background: 'var(--surface-0)',
          overflow: 'hidden',
        }}
      >
        {/* App header / 应用头部 */}
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--border-default)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--accent-muted)' }}
            >
              <span style={{ color: 'var(--accent)', fontSize: 14, fontWeight: 600 }}>C</span>
            </div>
            <span className="text-sm font-medium truncate" style={{ color: 'var(--txt-1)' }}>
              {t('app.title')}
            </span>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="btn-ghost p-1 rounded">
            <ChevronLeft size={16} style={{ color: 'var(--txt-3)' }} />
          </button>
        </div>

        {/* Navigation / 导航 */}
        <nav className="p-2 space-y-0.5">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={`sidebar-item w-full ${view === item.id ? 'active' : ''}`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {/* Project tree / 项目树 */}
        {view === 'projects' && (
          <div className="flex-1 overflow-y-auto border-t" style={{ borderColor: 'var(--border-default)' }}>
            <ProjectTree
              projects={projectList}
              selectedProject={selectedProject}
              onSelect={handleSelectProject}
            />
          </div>
        )}

        {/* Bottom controls / 底部控制 */}
        <div className="p-3 border-t space-y-1" style={{ borderColor: 'var(--border-default)' }}>
          {/* Connection status / 连接状态 */}
          <div className="flex items-center gap-2 px-2 py-1">
            {connected ? (
              <Wifi size={14} style={{ color: 'var(--status-ok)' }} />
            ) : (
              <WifiOff size={14} style={{ color: 'var(--txt-3)' }} />
            )}
            <span className="text-2xs" style={{ color: 'var(--txt-3)' }}>
              {connected ? 'Live' : 'Offline'}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button onClick={() => setDark(!dark)} className="btn btn-ghost p-2 flex-1">
              {dark ? <Sun size={14} /> : <Moon size={14} />}
              <span className="text-2xs">{dark ? t('common.light_mode') : t('common.dark_mode')}</span>
            </button>
            <button onClick={toggleLang} className="btn btn-ghost p-2">
              <span className="text-2xs">{i18n.language.startsWith('zh') ? 'EN' : '中'}</span>
            </button>
            <button onClick={onLogout} className="btn btn-ghost p-2" title={t('auth.logout')}>
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content area / 主内容区 */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar when sidebar closed / 侧边栏关闭时的顶栏 */}
        {!sidebarOpen && (
          <div className="flex items-center gap-2 p-2 border-b" style={{ borderColor: 'var(--border-default)' }}>
            <button onClick={() => setSidebarOpen(true)} className="btn btn-ghost p-2">
              <Menu size={16} />
            </button>
            <span className="text-sm font-medium" style={{ color: 'var(--txt-2)' }}>
              {t('app.title')}
            </span>
          </div>
        )}

        {/* Content router / 内容路由 */}
        <div className="flex-1 overflow-hidden">
          {view === 'projects' && !selectedSession && (
            <SessionList
              sessions={sessionList}
              projectId={selectedProject}
              onSelect={handleSelectSession}
              onRefresh={() => selectedProject && handleSelectProject(selectedProject)}
            />
          )}
          {view === 'projects' && selectedSession && (
            <ChatViewer
              projectId={selectedSession.projectId}
              sessionId={selectedSession.sessionId}
              onBack={() => setSelectedSession(null)}
            />
          )}
          {view === 'search' && (
            <SearchPanel onNavigate={handleSelectSession} />
          )}
          {view === 'audit' && selectedSession && (
            <AuditPanel
              projectId={selectedSession.projectId}
              sessionId={selectedSession.sessionId}
            />
          )}
          {view === 'audit' && !selectedSession && (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--txt-3)' }}>
              <p className="text-sm">{t('sessions.no_sessions')}</p>
            </div>
          )}
          {view === 'stats' && (
            <div className="p-6">
              <h2 className="text-lg font-medium mb-4">{t('stats.title')}</h2>
              <div className="grid grid-cols-3 gap-4">
                <div className="card p-4 text-center">
                  <div className="text-2xl font-medium" style={{ color: 'var(--accent)' }}>{projectList.length}</div>
                  <div className="text-sm mt-1" style={{ color: 'var(--txt-2)' }}>{t('stats.total_projects')}</div>
                </div>
                <div className="card p-4 text-center">
                  <div className="text-2xl font-medium" style={{ color: 'var(--accent)' }}>
                    {projectList.reduce((s, p) => s + p.sessionCount, 0)}
                  </div>
                  <div className="text-sm mt-1" style={{ color: 'var(--txt-2)' }}>{t('stats.total_sessions')}</div>
                </div>
                <div className="card p-4 text-center">
                  <div className="text-2xl font-medium" style={{ color: 'var(--accent)' }}>—</div>
                  <div className="text-sm mt-1" style={{ color: 'var(--txt-2)' }}>{t('stats.total_messages')}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

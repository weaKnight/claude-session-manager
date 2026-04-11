/**
 * Main layout / 主布局
 * Sidebar + content area shell
 * 侧边栏 + 内容区域外壳
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderTree, Search, Shield, BarChart3, Trash2, LogOut,
  Sun, Moon, ChevronLeft, Menu, WifiOff,
  TrendingUp, Activity, Database,
} from 'lucide-react';
import { projects as projectsApi, type ProjectInfo, type SessionMeta } from '../utils/api';
import { useSSE } from '../hooks/useSSE';
import ProjectTree from './ProjectTree';
import SessionList from './SessionList';
import ChatViewer from './ChatViewer';
import SearchPanel from './SearchPanel';
import AuditPanel from './AuditPanel';
import TrashPanel from './TrashPanel';

type View = 'projects' | 'search' | 'audit' | 'trash' | 'stats';

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
    { id: 'projects', icon: <FolderTree size={20} />, label: t('nav.projects') },
    { id: 'search', icon: <Search size={20} />, label: t('nav.search') },
    { id: 'audit', icon: <Shield size={20} />, label: t('nav.audit') },
    { id: 'trash', icon: <Trash2 size={20} />, label: t('trash.title') },
    { id: 'stats', icon: <BarChart3 size={20} />, label: t('nav.stats') },
  ];

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--surface-1)' }}>
      {/* Sidebar / 侧边栏 */}
      <aside
        className="flex flex-col transition-all duration-200 border-r"
        style={{
          width: sidebarOpen ? 320 : 0,
          minWidth: sidebarOpen ? 320 : 0,
          borderColor: 'var(--border-default)',
          background: 'var(--surface-0)',
          overflow: 'hidden',
        }}
      >
        {/* App header / 应用头部 */}
        <div className="flex items-center justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-default)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 relative overflow-hidden"
              style={{
                background: 'var(--gradient-accent)',
                boxShadow: '0 8px 24px -6px var(--accent-glow), 0 2px 6px rgba(0,0,0,0.08)',
              }}
            >
              <span style={{ color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: '-0.04em' }}>C</span>
              <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/10 to-white/20 pointer-events-none" />
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-bold truncate leading-tight" style={{ color: 'var(--txt-1)', letterSpacing: '-0.02em' }}>
                {t('app.title')}
              </div>
              <div className="text-[11px] font-medium tracking-wide truncate" style={{ color: 'var(--txt-3)' }}>
                Session Intelligence
              </div>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="btn-ghost p-2 rounded-lg">
            <ChevronLeft size={18} style={{ color: 'var(--txt-3)' }} />
          </button>
        </div>

        {/* Navigation / 导航 */}
        <nav className="px-3 py-4 space-y-1">
          <div className="section-label">Workspace</div>
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
        <div className="p-4 border-t space-y-3" style={{ borderColor: 'var(--border-default)' }}>
          {/* Connection status / 连接状态 */}
          <div
            className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl"
            style={{
              background: connected ? 'rgba(15, 138, 95, 0.08)' : 'var(--surface-2)',
              border: `1px solid ${connected ? 'rgba(15, 138, 95, 0.18)' : 'var(--border-default)'}`,
            }}
          >
            {connected ? (
              <span className="live-dot" />
            ) : (
              <WifiOff size={14} style={{ color: 'var(--txt-3)' }} />
            )}
            <span className="text-[12px] font-semibold tracking-wide" style={{ color: connected ? 'var(--status-ok)' : 'var(--txt-3)' }}>
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
            {connected && (
              <Activity size={12} className="ml-auto" style={{ color: 'var(--status-ok)', opacity: 0.6 }} />
            )}
          </div>

          {/* Controls / 控制栏 */}
          <div className="flex items-center gap-1.5">
            <button onClick={() => setDark(!dark)} className="btn btn-ghost flex-1 !py-2.5 !px-3">
              {dark ? <Sun size={16} /> : <Moon size={16} />}
              <span className="text-[12px] font-semibold">{dark ? t('common.light_mode') : t('common.dark_mode')}</span>
            </button>
            <button onClick={toggleLang} className="btn btn-ghost !py-2.5 !px-3" title="Language">
              <span className="text-[12px] font-bold">{i18n.language.startsWith('zh') ? 'EN' : '中'}</span>
            </button>
            <button onClick={onLogout} className="btn btn-ghost !py-2.5 !px-3" title={t('auth.logout')}>
              <LogOut size={16} />
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
              onViewAudit={() => setView('audit')}
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
            <div className="empty-state h-full">
              <div className="empty-state-icon">
                <Shield size={28} />
              </div>
              <p className="text-sm">{t('audit.title')}</p>
              <p className="text-2xs mt-1" style={{ color: 'var(--txt-3)' }}>
                Select a session first, then click "View Commands"
              </p>
            </div>
          )}
          {view === 'trash' && (
            <TrashPanel />
          )}
          {view === 'stats' && (
            <div className="p-10 max-w-6xl mx-auto overflow-y-auto h-full">
              <div className="flex items-center gap-5 mb-10">
                <div
                  className="p-4 rounded-2xl flex-shrink-0"
                  style={{
                    background: 'var(--gradient-accent)',
                    boxShadow: '0 12px 32px -8px var(--accent-glow), 0 4px 12px rgba(0,0,0,0.08)',
                  }}
                >
                  <BarChart3 size={28} style={{ color: '#fff' }} />
                </div>
                <div>
                  <h1 className="text-4xl font-bold tracking-tight" style={{ color: 'var(--txt-1)', letterSpacing: '-0.035em' }}>
                    {t('stats.title')}
                  </h1>
                  <p className="text-[15px] mt-1" style={{ color: 'var(--txt-2)' }}>
                    Overview of your Claude Code usage and session activity
                  </p>
                </div>
              </div>

              {/* KPI cards / KPI 卡片 */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-10">
                <div className="kpi-card animate-count-up" style={{ animationDelay: '0ms' }}>
                  <div className="flex items-center justify-between mb-5 relative">
                    <div
                      className="p-2.5 rounded-xl"
                      style={{ background: 'var(--accent-muted)' }}
                    >
                      <FolderTree size={20} style={{ color: 'var(--accent)' }} />
                    </div>
                    <span
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full"
                      style={{ background: 'rgba(15, 138, 95, 0.1)', color: 'var(--status-ok)' }}
                    >
                      <TrendingUp size={11} />
                      Active
                    </span>
                  </div>
                  <div className="kpi-value">{projectList.length}</div>
                  <div className="kpi-label">{t('stats.total_projects')}</div>
                </div>

                <div className="kpi-card animate-count-up" style={{ animationDelay: '80ms' }}>
                  <div className="flex items-center justify-between mb-5 relative">
                    <div
                      className="p-2.5 rounded-xl"
                      style={{ background: 'var(--accent-muted)' }}
                    >
                      <Database size={20} style={{ color: 'var(--accent)' }} />
                    </div>
                    <span
                      className="text-[11px] font-mono font-semibold"
                      style={{ color: 'var(--txt-3)' }}
                    >
                      {projectList.length > 0
                        ? `~${Math.round(projectList.reduce((s, p) => s + p.sessionCount, 0) / projectList.length)}/proj`
                        : '—'}
                    </span>
                  </div>
                  <div className="kpi-value">
                    {projectList.reduce((s, p) => s + p.sessionCount, 0)}
                  </div>
                  <div className="kpi-label">{t('stats.total_sessions')}</div>
                </div>

                <div className="kpi-card animate-count-up" style={{ animationDelay: '160ms' }}>
                  <div className="flex items-center justify-between mb-5 relative">
                    <div
                      className="p-2.5 rounded-xl"
                      style={{ background: 'var(--accent-muted)' }}
                    >
                      <Activity size={20} style={{ color: 'var(--accent)' }} />
                    </div>
                    <span
                      className="text-[11px] font-semibold px-2 py-1 rounded-full"
                      style={{ background: 'var(--surface-2)', color: 'var(--txt-3)' }}
                    >
                      Soon
                    </span>
                  </div>
                  <div className="kpi-value">—</div>
                  <div className="kpi-label">{t('stats.total_messages')}</div>
                </div>
              </div>

              {/* Project breakdown / 项目分布 */}
              {projectList.length > 0 && (
                <div className="card p-8">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className="text-xl font-bold tracking-tight" style={{ color: 'var(--txt-1)', letterSpacing: '-0.025em' }}>
                        Project Breakdown
                      </h3>
                      <p className="text-[13px] mt-0.5" style={{ color: 'var(--txt-3)' }}>
                        Top projects by session count
                      </p>
                    </div>
                    <span
                      className="text-[11px] font-mono font-semibold px-3 py-1.5 rounded-full"
                      style={{ background: 'var(--surface-2)', color: 'var(--txt-2)' }}
                    >
                      TOP {Math.min(8, projectList.length)}
                    </span>
                  </div>
                  <div className="space-y-5">
                    {projectList
                      .sort((a, b) => b.sessionCount - a.sessionCount)
                      .slice(0, 8)
                      .map((project) => {
                        const maxSessions = Math.max(...projectList.map((p) => p.sessionCount), 1);
                        const pct = Math.round((project.sessionCount / maxSessions) * 100);
                        return (
                          <div
                            key={project.encodedPath}
                            className="group cursor-pointer"
                            onClick={() => { setView('projects'); handleSelectProject(project.encodedPath); }}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span
                                className="text-[14px] font-medium truncate flex-1 group-hover:text-[color:var(--accent)] transition-colors"
                                style={{ color: 'var(--txt-1)' }}
                              >
                                {project.displayName}
                              </span>
                              <span
                                className="text-[12px] font-bold ml-3 px-2.5 py-0.5 rounded-md"
                                style={{ background: 'var(--surface-2)', color: 'var(--txt-2)', fontFamily: 'JetBrains Mono, monospace' }}
                              >
                                {project.sessionCount}
                              </span>
                            </div>
                            <div className="token-bar !h-1.5">
                              <div className="token-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

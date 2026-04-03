/**
 * App root / 应用根组件
 * Handles auth state and routes between Login and main Layout
 * 管理认证状态，在登录页和主布局间切换
 */

import { useAuth } from './hooks/useAuth';
import Login from './components/Login';
import Layout from './components/Layout';

export default function App() {
  const { isLoading, isAuthenticated, setupRequired, error, login, setup, logout } = useAuth();

  // Loading state / 加载状态
  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--surface-1)' }}
      >
        <div className="text-center">
          <div
            className="w-10 h-10 rounded-xl mx-auto mb-3 animate-pulse-slow"
            style={{ background: 'var(--accent-muted)' }}
          />
          <p className="text-sm" style={{ color: 'var(--txt-3)' }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Auth gate / 认证拦截
  if (!isAuthenticated) {
    return (
      <Login
        setupRequired={setupRequired}
        onLogin={login}
        onSetup={setup}
        error={error}
      />
    );
  }

  // Main app / 主应用
  return <Layout onLogout={logout} />;
}

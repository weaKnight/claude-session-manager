/**
 * Login / Setup page / 登录/设置页面
 * Handles first-time password setup and subsequent logins
 * 处理首次密码设置和后续登录
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Eye, EyeOff, Terminal, Loader2 } from 'lucide-react';

interface LoginProps {
  setupRequired: boolean;
  onLogin: (password: string) => Promise<boolean>;
  onSetup: (password: string) => Promise<boolean>;
  error: string | null;
}

export default function Login({ setupRequired, onLogin, onSetup, error }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || loading) return;

    setLoading(true);
    const fn = setupRequired ? onSetup : onLogin;
    await fn(password);
    setLoading(false);
  };

  const toggleLang = () => {
    const next = i18n.language.startsWith('zh') ? 'en' : 'zh';
    i18n.changeLanguage(next);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
      style={{ background: 'var(--surface-1)' }}
    >
      {/* Subtle grid background / 淡网格背景 */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(var(--txt-1) 1px, transparent 1px),
            linear-gradient(90deg, var(--txt-1) 1px, transparent 1px)
          `,
          backgroundSize: '48px 48px',
        }}
      />
      {/* Gradient orb / 渐变光球 */}
      <div
        className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full opacity-[0.06] blur-3xl pointer-events-none"
        style={{ background: 'var(--accent)' }}
      />

      <div className="w-full max-w-md relative z-10">
        {/* Header / 头部 */}
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center justify-center w-20 h-20 rounded-3xl mb-7 relative overflow-hidden"
            style={{
              background: 'var(--gradient-accent)',
              boxShadow: '0 24px 48px -12px var(--accent-glow), 0 8px 24px rgba(0,0,0,0.12)',
            }}
          >
            <Terminal size={36} style={{ color: '#fff' }} strokeWidth={2.25} />
            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/10 to-white/25 pointer-events-none" />
          </div>
          <h1
            data-testid="auth-heading"
            data-mode={setupRequired ? 'setup' : 'login'}
            className="text-4xl font-bold tracking-tight"
            style={{ color: 'var(--txt-1)', letterSpacing: '-0.04em' }}
          >
            {setupRequired ? t('auth.setup_title') : t('auth.login_title')}
          </h1>
          <p className="text-[15px] mt-3 max-w-sm mx-auto leading-relaxed" style={{ color: 'var(--txt-2)' }}>
            {setupRequired ? t('auth.setup_desc') : t('auth.login_desc')}
          </p>
        </div>

        {/* Form / 表单 */}
        <form onSubmit={handleSubmit}>
          <div className="card p-8" style={{ animation: 'fade-in-scale 0.35s ease-out', boxShadow: 'var(--shadow-xl)' }}>
            <label
              className="block text-[13px] font-bold uppercase tracking-wider mb-3"
              style={{ color: 'var(--txt-2)' }}
            >
              {t('auth.password')}
            </label>
            <div className="relative">
              <div
                className="absolute left-4 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--txt-3)' }}
              >
                <Lock size={17} />
              </div>
              <input
                data-testid="password-input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input !pl-11 !pr-11 !py-3.5 !text-base"
                placeholder={setupRequired ? t('auth.password_min') : '••••••••'}
                autoFocus
                minLength={setupRequired ? 8 : 1}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--txt-3)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>

            {error && (
              <p
                data-testid="auth-error"
                className="text-[14px] mt-4 font-medium px-3 py-2 rounded-lg"
                style={{ color: 'var(--status-err)', background: 'var(--role-error)' }}
              >
                {error}
              </p>
            )}

            <button
              data-testid="submit-btn"
              type="submit"
              className="btn btn-primary w-full mt-6 !py-3.5 !text-base"
              disabled={loading || !password}
              style={{ opacity: loading || !password ? 0.5 : 1 }}
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={17} className="animate-spin" />
                  {t('common.loading')}
                </span>
              ) : setupRequired ? t('auth.setup_btn') : t('auth.login_btn')}
            </button>
          </div>
        </form>

        {/* Footer / 底部 */}
        <div className="text-center mt-8 space-y-3">
          <button
            onClick={toggleLang}
            className="btn btn-ghost !text-[13px] !font-semibold"
          >
            {i18n.language.startsWith('zh') ? 'English' : '中文'}
          </button>
          <p className="text-[11px] tracking-wider" style={{ color: 'var(--txt-3)', fontFamily: 'JetBrains Mono, monospace' }}>
            v1.0 &middot; CLAUDE SESSION MANAGER
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Login / Setup page / 登录/设置页面
 * Handles first-time password setup and subsequent logins
 * 处理首次密码设置和后续登录
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Eye, EyeOff, Terminal } from 'lucide-react';

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

      <div className="w-full max-w-sm relative z-10">
        {/* Header / 头部 */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5"
            style={{
              background: 'var(--accent-muted)',
              border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-md)',
            }}
          >
            <Terminal size={26} style={{ color: 'var(--accent)' }} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--txt-1)' }}>
            {setupRequired ? t('auth.setup_title') : t('auth.login_title')}
          </h1>
          <p className="text-sm mt-2" style={{ color: 'var(--txt-2)' }}>
            {setupRequired ? t('auth.setup_desc') : t('auth.login_desc')}
          </p>
        </div>

        {/* Form / 表单 */}
        <form onSubmit={handleSubmit}>
          <div className="card p-6" style={{ animation: 'fade-in-scale 0.3s ease-out' }}>
            <label
              className="block text-sm font-medium mb-2"
              style={{ color: 'var(--txt-2)' }}
            >
              {t('auth.password')}
            </label>
            <div className="relative">
              <div
                className="absolute left-3.5 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--txt-3)' }}
              >
                <Lock size={15} />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-10 pr-10"
                placeholder={setupRequired ? t('auth.password_min') : '••••••••'}
                autoFocus
                minLength={setupRequired ? 8 : 1}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--txt-3)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            {error && (
              <p className="text-sm mt-3 font-medium" style={{ color: 'var(--status-err)' }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              className="btn btn-primary w-full mt-5"
              disabled={loading || !password}
              style={{ opacity: loading || !password ? 0.5 : 1 }}
            >
              {loading ? t('common.loading') : setupRequired ? t('auth.setup_btn') : t('auth.login_btn')}
            </button>
          </div>
        </form>

        {/* Language toggle / 语言切换 */}
        <div className="text-center mt-6">
          <button
            onClick={toggleLang}
            className="btn btn-ghost text-2xs"
          >
            {i18n.language.startsWith('zh') ? 'English' : '中文'}
          </button>
        </div>
      </div>
    </div>
  );
}

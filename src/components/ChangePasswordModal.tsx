/**
 * Change password modal / 修改密码模态框
 * Lets an authenticated user change their password. On success the server
 * rotates its JWT secret (invalidating other sessions) and returns a fresh
 * token, which we store silently so the current window stays logged in.
 * 已登录用户修改密码。成功时服务端轮换 JWT 密钥（使其它会话失效）并回发新
 * token，前端静默存储，当前窗口保持登录。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Lock, Eye, EyeOff, X, Loader2, CheckCircle2 } from 'lucide-react';
import { auth as authApi, setToken } from '../utils/api';

interface ChangePasswordModalProps {
  onClose: () => void;
}

interface PasswordFieldProps {
  testId: string;
  label: string;
  value: string;
  placeholder?: string;
  autoFocus?: boolean;
  onChange: (v: string) => void;
}

// Single password input with its own show/hide toggle / 带独立显隐切换的密码输入
function PasswordField({ testId, label, value, placeholder, autoFocus, onChange }: PasswordFieldProps) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block text-[13px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--txt-2)' }}>
        {label}
      </label>
      <div className="relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: 'var(--txt-3)' }}>
          <Lock size={16} />
        </div>
        <input
          data-testid={testId}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input !pl-11 !pr-11 !py-3"
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-4 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--txt-3)', background: 'none', border: 'none', cursor: 'pointer' }}
          tabIndex={-1}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

export default function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Close on Escape / 按 Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // New password must be ≥ 8 and match confirmation / 新密码须 ≥ 8 位且两次一致
  const canSubmit = current.length > 0 && next.length >= 8 && confirm.length >= 8 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);

    if (next !== confirm) {
      setError(t('auth.password_mismatch'));
      return;
    }

    setLoading(true);
    try {
      const res = await authApi.changePassword(current, next);
      if (res.success && res.token) {
        // Swap in the re-issued token so the current session survives rotation
        // 换入重新签发的 token，使当前会话在密钥轮换后仍有效
        setToken(res.token);
        setSuccess(true);
        setTimeout(onClose, 1400);
      } else {
        setError(res.error || t('common.error'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
      data-testid="change-pw-modal"
    >
      <div
        className="card w-full max-w-md p-7"
        style={{ animation: 'fade-in-scale 0.25s ease-out', boxShadow: 'var(--shadow-xl)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header / 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-xl"
              style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
            >
              <KeyRound size={18} />
            </div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--txt-1)' }}>
              {t('auth.change_password')}
            </h2>
          </div>
          <button onClick={onClose} className="btn btn-ghost !p-2" title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        {success ? (
          <div className="flex flex-col items-center text-center py-6" data-testid="change-pw-success">
            <CheckCircle2 size={40} style={{ color: 'var(--status-ok)' }} />
            <p className="mt-3 text-sm font-medium" style={{ color: 'var(--txt-2)' }}>
              {t('auth.change_success')}
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <PasswordField
              testId="change-pw-current"
              label={t('auth.current_password')}
              value={current}
              onChange={setCurrent}
              autoFocus
            />
            <PasswordField
              testId="change-pw-new"
              label={t('auth.new_password')}
              value={next}
              onChange={setNext}
              placeholder={t('auth.password_min')}
            />
            <PasswordField
              testId="change-pw-confirm"
              label={t('auth.confirm_password')}
              value={confirm}
              onChange={setConfirm}
            />

            {error && (
              <p
                data-testid="change-pw-error"
                className="text-[14px] font-medium px-3 py-2 rounded-lg"
                style={{ color: 'var(--status-err)', background: 'var(--role-error)' }}
              >
                {error}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="btn btn-ghost flex-1 !py-3">
                {t('common.cancel')}
              </button>
              <button
                data-testid="change-pw-submit"
                type="submit"
                className="btn btn-primary flex-1 !py-3"
                disabled={!canSubmit}
                style={{ opacity: canSubmit ? 1 : 0.5 }}
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    {t('common.loading')}
                  </span>
                ) : (
                  t('auth.change_btn')
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

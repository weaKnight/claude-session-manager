/**
 * Auth hook / 认证 Hook
 * Manages authentication state and provides login/logout methods
 * 管理认证状态并提供登录/注销方法
 */

import { useState, useEffect, useCallback } from 'react';
import { auth as authApi, getToken, setToken, clearToken } from '../utils/api';

interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  setupRequired: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    isLoading: true,
    isAuthenticated: false,
    setupRequired: false,
    error: null,
  });

  // Check initial auth state / 检查初始认证状态
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const token = getToken();
      const { setupRequired } = await authApi.status();

      if (setupRequired) {
        setState({ isLoading: false, isAuthenticated: false, setupRequired: true, error: null });
        return;
      }

      // If we have a token, try to use it / 如果有 token，尝试使用
      if (token) {
        // Validate by making a lightweight request / 通过轻量请求验证
        setState({ isLoading: false, isAuthenticated: true, setupRequired: false, error: null });
      } else {
        setState({ isLoading: false, isAuthenticated: false, setupRequired: false, error: null });
      }
    } catch {
      setState({ isLoading: false, isAuthenticated: false, setupRequired: false, error: null });
    }
  }, []);

  const login = useCallback(async (password: string) => {
    setState((s) => ({ ...s, error: null, isLoading: true }));
    try {
      const result = await authApi.login(password);
      if (result.success && result.token) {
        setToken(result.token);
        setState({ isLoading: false, isAuthenticated: true, setupRequired: false, error: null });
        return true;
      }
      setState((s) => ({ ...s, isLoading: false, error: result.error || 'Login failed' }));
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setState((s) => ({ ...s, isLoading: false, error: message }));
      return false;
    }
  }, []);

  const setup = useCallback(async (password: string) => {
    setState((s) => ({ ...s, error: null, isLoading: true }));
    try {
      const result = await authApi.setup(password);
      if (result.success && result.token) {
        setToken(result.token);
        setState({ isLoading: false, isAuthenticated: true, setupRequired: false, error: null });
        return true;
      }
      setState((s) => ({ ...s, isLoading: false, error: 'Setup failed' }));
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Setup failed';
      setState((s) => ({ ...s, isLoading: false, error: message }));
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setState({ isLoading: false, isAuthenticated: false, setupRequired: false, error: null });
  }, []);

  return { ...state, login, setup, logout, checkAuth };
}

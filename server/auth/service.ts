/**
 * Authentication service / 认证服务
 * Handles password hashing, JWT generation, and rate limiting
 * 处理密码哈希、JWT 生成和速率限制
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

interface AuthData {
  passwordHash: string;
  jwtSecret: string;
  createdAt: string;
}

interface LoginAttempt {
  count: number;
  lockedUntil: number | null;
}

// In-memory login attempt tracker / 内存中的登录尝试追踪器
const loginAttempts: Map<string, LoginAttempt> = new Map();

/**
 * Check if initial setup is required / 检查是否需要初始设置
 */
export function isSetupRequired(): boolean {
  return !existsSync(config.authFile);
}

/**
 * Get or generate JWT secret / 获取或生成 JWT 密钥
 */
function getJwtSecret(): string {
  if (config.jwtSecret) return config.jwtSecret;

  if (existsSync(config.authFile)) {
    const data = JSON.parse(readFileSync(config.authFile, 'utf-8')) as AuthData;
    return data.jwtSecret;
  }

  return randomBytes(32).toString('hex');
}

/**
 * Setup initial password / 设置初始密码
 */
export async function setupPassword(password: string): Promise<{ success: boolean; error?: string }> {
  if (!isSetupRequired()) {
    return { success: false, error: 'Password already configured / 密码已配置' };
  }

  if (password.length < 8) {
    return { success: false, error: 'Password must be at least 8 characters / 密码至少 8 位' };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const jwtSecret = config.jwtSecret || randomBytes(32).toString('hex');

  const authData: AuthData = {
    passwordHash,
    jwtSecret,
    createdAt: new Date().toISOString(),
  };

  writeFileSync(config.authFile, JSON.stringify(authData, null, 2), { mode: 0o600 });
  logger.success('Password configured successfully / 密码设置成功');

  return { success: true };
}

/**
 * Verify password and return JWT token / 验证密码并返回 JWT token
 */
export async function login(
  password: string,
  clientIp: string
): Promise<{ success: boolean; token?: string; error?: string; lockedUntil?: number }> {
  // Check lockout / 检查是否被锁定
  const attempt = loginAttempts.get(clientIp);
  if (attempt?.lockedUntil && Date.now() < attempt.lockedUntil) {
    const remaining = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
    return {
      success: false,
      error: `Account locked. Try again in ${remaining} min / 账户已锁定，${remaining} 分钟后重试`,
      lockedUntil: attempt.lockedUntil,
    };
  }

  if (!existsSync(config.authFile)) {
    return { success: false, error: 'Setup required / 需要先设置密码' };
  }

  const authData = JSON.parse(readFileSync(config.authFile, 'utf-8')) as AuthData;
  const valid = await bcrypt.compare(password, authData.passwordHash);

  if (!valid) {
    // Track failed attempts / 记录失败次数
    const current = loginAttempts.get(clientIp) || { count: 0, lockedUntil: null };
    current.count++;

    if (current.count >= config.maxLoginAttempts) {
      current.lockedUntil = Date.now() + config.lockoutMinutes * 60 * 1000;
      loginAttempts.set(clientIp, current);
      logger.warn(`IP ${clientIp} locked out after ${current.count} failed attempts`);
      return {
        success: false,
        error: `Too many attempts. Locked for ${config.lockoutMinutes} min / 尝试次数过多，锁定 ${config.lockoutMinutes} 分钟`,
        lockedUntil: current.lockedUntil,
      };
    }

    loginAttempts.set(clientIp, current);
    return {
      success: false,
      error: `Invalid password (${config.maxLoginAttempts - current.count} attempts left) / 密码错误（剩余 ${config.maxLoginAttempts - current.count} 次）`,
    };
  }

  // Success - reset attempts / 成功 - 重置尝试次数
  loginAttempts.delete(clientIp);

  const secret = getJwtSecret();
  const token = jwt.sign(
    { iss: 'claude-session-manager', iat: Math.floor(Date.now() / 1000) },
    secret,
    { expiresIn: config.jwtExpiry }
  );

  logger.info(`Login successful from ${clientIp}`);
  return { success: true, token };
}

/**
 * Verify JWT token / 验证 JWT token
 */
export function verifyToken(token: string): boolean {
  try {
    const secret = getJwtSecret();
    jwt.verify(token, secret);
    return true;
  } catch {
    return false;
  }
}

/**
 * Change password / 修改密码
 */
export async function changePassword(
  oldPassword: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  if (!existsSync(config.authFile)) {
    return { success: false, error: 'Not configured / 未配置' };
  }

  if (newPassword.length < 8) {
    return { success: false, error: 'New password must be at least 8 characters / 新密码至少 8 位' };
  }

  const authData = JSON.parse(readFileSync(config.authFile, 'utf-8')) as AuthData;
  const valid = await bcrypt.compare(oldPassword, authData.passwordHash);
  if (!valid) {
    return { success: false, error: 'Current password incorrect / 当前密码错误' };
  }

  authData.passwordHash = await bcrypt.hash(newPassword, 12);
  writeFileSync(config.authFile, JSON.stringify(authData, null, 2), { mode: 0o600 });
  logger.success('Password changed / 密码已修改');

  return { success: true };
}

/**
 * Server configuration / 服务器配置
 * Loads from environment variables and CLI arguments
 * 从环境变量和命令行参数加载配置
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// Parse CLI arguments / 解析命令行参数
function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      args[key] = val;
      if (val !== 'true') i++;
    }
  }
  return args;
}

const cliArgs = parseArgs();

// Resolve frontend dist path / 解析前端构建目录
// Tries (in order): explicit env override, alongside binary, alongside binary (flat),
// then cwd-relative for `npm start`. Lets the same code run as a Bun-compiled
// single binary or under regular Node.
// 优先级：显式环境变量 > 二进制同级 > 当前工作目录（npm start 模式）
function resolveClientDistPath(): string {
  const binDir = dirname(process.execPath);
  const candidates = [
    process.env['CSM_CLIENT_DIST'],
    join(binDir, 'dist', 'client'),
    join(binDir, 'client'),
    join(process.cwd(), 'dist', 'client'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall back to cwd-relative even if missing — server logs a warning later
  // 即使不存在也回退到 cwd 相对路径，server 启动时会打印警告
  return join(process.cwd(), 'dist', 'client');
}

// Default Claude data directory / 默认 Claude 数据目录
const defaultClaudeDir = join(homedir(), '.claude');

// App data directory (separate from .claude to avoid pollution)
// 应用数据目录（与 .claude 分离，避免污染）
const appDataDir = join(homedir(), '.claude-session-manager');
if (!existsSync(appDataDir)) {
  mkdirSync(appDataDir, { recursive: true });
}

export const config = {
  // Server / 服务器
  port: parseInt(cliArgs['port'] || process.env['CSM_PORT'] || '3727', 10),
  host: cliArgs['host'] || process.env['CSM_HOST'] || '0.0.0.0',

  // Paths / 路径
  claudeDir: cliArgs['claude-dir'] || process.env['CSM_CLAUDE_DIR'] || defaultClaudeDir,
  appDataDir,
  authFile: join(appDataDir, 'auth.json'),
  trashDir: join(appDataDir, 'trash'),

  // Security / 安全
  jwtSecret: process.env['CSM_SECRET'] || '',
  jwtExpiry: process.env['CSM_JWT_EXPIRY'] || '24h',
  maxLoginAttempts: 5,
  lockoutMinutes: 15,

  // Features / 功能
  enableSSE: true,
  enableSearch: true,
  readOnly: cliArgs['read-only'] === 'true' || process.env['CSM_READ_ONLY'] === 'true',

  // Client build path / 前端构建路径
  clientDistPath: resolveClientDistPath(),
} as const;

// Ensure trash directory exists / 确保回收站目录存在
if (!existsSync(config.trashDir)) {
  mkdirSync(config.trashDir, { recursive: true });
}

export type Config = typeof config;

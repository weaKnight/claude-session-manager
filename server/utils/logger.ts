/**
 * Simple logger with colored output / 简易日志（带颜色输出）
 * No external dependencies / 无外部依赖
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export const logger = {
  info(msg: string, ...args: unknown[]) {
    console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.cyan}INFO${COLORS.reset}  ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    console.warn(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}WARN${COLORS.reset}  ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]) {
    console.error(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red}ERROR${COLORS.reset} ${msg}`, ...args);
  },
  success(msg: string, ...args: unknown[]) {
    console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.green}OK${COLORS.reset}    ${msg}`, ...args);
  },
  debug(msg: string, ...args: unknown[]) {
    if (process.env['CSM_DEBUG'] === 'true') {
      console.log(`${COLORS.dim}${timestamp()} DEBUG ${msg}${COLORS.reset}`, ...args);
    }
  },
};

/**
 * Playwright E2E test configuration / Playwright E2E 测试配置
 *
 * Isolates test state via HOME override:
 * 通过覆盖 HOME 隔离测试状态：
 *  - appDataDir  -> tests/fixtures/home/.claude-session-manager/
 *  - claudeDir   -> tests/fixtures/home/.claude/
 */

import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_HOME = join(__dirname, 'tests', 'fixtures', 'home');
const STORAGE_STATE = join(__dirname, 'tests', 'fixtures', '.auth', 'user.json');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  // Serialize workers: shared auth.json state makes parallel runs unsafe
  // 序列化 worker：共享 auth.json 状态，并行不安全
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  globalSetup: './tests/e2e/global-setup.ts',
  projects: [
    // Setup project: performs first-time password setup via UI
    // 设置项目：通过 UI 完成首次密码设置
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Main suite: depends on setup, reuses saved storage state
    // 主测试套件：依赖 setup 项目，复用保存的 storage state
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // Strip proxies so Playwright's health probe doesn't hit a local HTTP proxy
    // that happily answers for any host (returns 400 → false positive "available").
    // 清除代理，避免 Playwright 健康探测被本地代理误判为 webServer 已就绪。
    env: {
      ...process.env,
      HOME: TEST_HOME,
      CSM_CLAUDE_DIR: join(TEST_HOME, '.claude'),
      CSM_PORT: '3727',
      CSM_HOST: '127.0.0.1',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    },
  },
});

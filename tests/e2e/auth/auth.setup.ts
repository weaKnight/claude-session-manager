/**
 * Playwright setup project / Playwright setup 项目
 *
 * Runs ONCE before the chromium project.
 * 在 chromium 项目之前运行一次。
 *
 * Performs first-time password setup through the UI and persists
 * the resulting storage state so subsequent tests start authenticated.
 * 通过 UI 完成首次密码设置，并持久化 storage state 供后续测试复用。
 */

import { test as setup, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LoginPage } from '../pages/LoginPage';
import { TEST_PASSWORD } from './credentials';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE = join(__dirname, '..', '..', 'fixtures', '.auth', 'user.json');

setup('first-time password setup', async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();

  // Setup mode is expected on a fresh install
  // 干净安装下预期为 setup 模式
  expect(await login.mode()).toBe('setup');

  await login.submit(TEST_PASSWORD);

  // Layout renders once setup + auto-login completes
  // setup + 自动登录完成后渲染主布局
  await page.getByTestId('project-item').first().waitFor({ state: 'visible', timeout: 15_000 });

  await page.context().storageState({ path: STORAGE_STATE });
});

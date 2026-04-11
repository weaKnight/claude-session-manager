/**
 * Login flow tests / 登录流程测试
 *
 * This spec does NOT inherit storage state: it starts unauthenticated to
 * exercise the wrong-password error path and a subsequent successful login.
 * 本 spec 不继承 storage state：从未认证状态开始，
 * 覆盖密码错误路径和随后的成功登录。
 */

import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { TEST_PASSWORD } from './credentials';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

test('rejects wrong password', async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();

  // Setup is already done by the setup project, so we should be in login mode
  // setup 项目已完成首次设置，应处于 login 模式
  expect(await login.mode()).toBe('login');

  await login.submit('not-the-real-password');

  await expect(login.errorMessage).toBeVisible();
  // Still on login page / 仍停留在登录页
  await expect(login.heading).toBeVisible();
});

test('logs in with the correct password', async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();

  expect(await login.mode()).toBe('login');

  await login.submit(TEST_PASSWORD);

  // Reaches main layout / 进入主布局
  await expect(page.getByTestId('project-item').first()).toBeVisible({ timeout: 15_000 });
});

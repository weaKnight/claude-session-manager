/**
 * Change password flow tests / 修改密码流程测试
 *
 * Self-contained and state-restoring: this spec does NOT inherit storage
 * state, exercises the change-password modal end-to-end, and in afterAll
 * resets the password back to TEST_PASSWORD and refreshes the saved storage
 * state. Necessary because changing the password rotates the JWT secret,
 * which would otherwise invalidate the shared storage-state token used by
 * downstream feature specs.
 * 自包含且复原状态：本 spec 不继承 storage state，端到端验证修改密码模态框，
 * 并在 afterAll 把密码改回 TEST_PASSWORD、刷新保存的 storage state。
 * 因为改密会轮换 JWT 密钥，否则会使 features 用例复用的共享 token 失效。
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LoginPage } from '../pages/LoginPage';
import { TEST_PASSWORD } from './credentials';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE = join(__dirname, '..', '..', 'fixtures', '.auth', 'user.json');

const NEW_PASSWORD = 'e2e-new-pass-2026';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

// Log in via the UI, then open the change-password modal
// 通过 UI 登录后打开修改密码模态框
async function loginAndOpenModal(page: import('@playwright/test').Page, password: string) {
  const login = new LoginPage(page);
  await login.goto();
  expect(await login.mode()).toBe('login');
  await login.submit(password);
  await page.getByTestId('project-item').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('open-change-pw').click();
  await expect(page.getByTestId('change-pw-modal')).toBeVisible();
}

test('rejects a wrong current password', async ({ page }) => {
  await loginAndOpenModal(page, TEST_PASSWORD);

  await page.getByTestId('change-pw-current').fill('definitely-not-the-password');
  await page.getByTestId('change-pw-new').fill(NEW_PASSWORD);
  await page.getByTestId('change-pw-confirm').fill(NEW_PASSWORD);
  await page.getByTestId('change-pw-submit').click();

  // Error shown, no success, modal stays open / 显示错误、无成功态、模态框不关闭
  await expect(page.getByTestId('change-pw-error')).toBeVisible();
  await expect(page.getByTestId('change-pw-success')).toHaveCount(0);
});

test('blocks mismatched new passwords before any request', async ({ page }) => {
  await loginAndOpenModal(page, TEST_PASSWORD);

  await page.getByTestId('change-pw-current').fill(TEST_PASSWORD);
  await page.getByTestId('change-pw-new').fill(NEW_PASSWORD);
  await page.getByTestId('change-pw-confirm').fill('a-different-password');
  await page.getByTestId('change-pw-submit').click();

  await expect(page.getByTestId('change-pw-error')).toBeVisible();
  await expect(page.getByTestId('change-pw-success')).toHaveCount(0);
});

test('changes the password and invalidates the old one', async ({ page }) => {
  await loginAndOpenModal(page, TEST_PASSWORD);

  await page.getByTestId('change-pw-current').fill(TEST_PASSWORD);
  await page.getByTestId('change-pw-new').fill(NEW_PASSWORD);
  await page.getByTestId('change-pw-confirm').fill(NEW_PASSWORD);
  await page.getByTestId('change-pw-submit').click();

  // Success state shown / 显示成功态
  await expect(page.getByTestId('change-pw-success')).toBeVisible();

  // Backend now accepts the new password and rejects the old one
  // 后端此时接受新密码、拒绝旧密码
  const withNew = await page.request.post('/api/v1/auth/login', {
    data: { password: NEW_PASSWORD },
  });
  expect(withNew.ok()).toBeTruthy();

  const withOld = await page.request.post('/api/v1/auth/login', {
    data: { password: TEST_PASSWORD },
  });
  expect(withOld.status()).toBe(401);
});

// Restore shared state so downstream specs keep working / 复原共享状态
test.afterAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Change back to TEST_PASSWORD. If the change-test didn't run (e.g. earlier
  // failure), oldPassword=NEW_PASSWORD simply fails harmlessly and the
  // password is already TEST_PASSWORD.
  // 改回 TEST_PASSWORD；若改密未发生则此请求无害失败，密码本就是 TEST_PASSWORD。
  await page.request.post('/api/v1/auth/change-password', {
    data: { oldPassword: NEW_PASSWORD, newPassword: TEST_PASSWORD },
  });

  // Re-login with the restored password and refresh the saved storage state
  // (the secret rotation invalidated the previous token).
  // 用复原后的密码重新登录并刷新 storage state（密钥轮换已使旧 token 失效）。
  const login = new LoginPage(page);
  await login.goto();
  await login.submit(TEST_PASSWORD);
  await page.getByTestId('project-item').first().waitFor({ state: 'visible', timeout: 15_000 });
  await context.storageState({ path: STORAGE_STATE });

  await context.close();
});

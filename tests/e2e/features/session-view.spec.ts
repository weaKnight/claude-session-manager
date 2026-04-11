/**
 * Session viewer tests / 会话查看器测试
 *
 * Exercises ChatViewer rendering and the four view modes.
 * 覆盖 ChatViewer 渲染及四种视图模式切换。
 */

import { test, expect } from '@playwright/test';
import { LayoutPage } from '../pages/LayoutPage';

const FIXTURE_PROJECT_ID = '-tmp-e2e-fixture';
const FIXTURE_SESSION_ID = 'e2e00001-0000-0000-0000-000000000001';

test('opens fixture session and renders chat viewer', async ({ page }) => {
  const layout = new LayoutPage(page);
  await layout.goto();
  await layout.openProject(FIXTURE_PROJECT_ID);
  await layout.openSession(FIXTURE_SESSION_ID);

  await expect(layout.chatViewer).toBeVisible();

  // "full" is the default active view / 默认视图为 full
  await expect(layout.viewTab('full')).toHaveAttribute('data-active', 'true');
});

test('switches through all four view modes', async ({ page }) => {
  const layout = new LayoutPage(page);
  await layout.goto();
  await layout.openProject(FIXTURE_PROJECT_ID);
  await layout.openSession(FIXTURE_SESSION_ID);

  for (const mode of ['dialog', 'compact', 'changes', 'full'] as const) {
    await layout.selectView(mode);
    await expect(layout.viewTab(mode)).toHaveAttribute('data-active', 'true');
  }
});

test('chat back button returns to session list', async ({ page }) => {
  const layout = new LayoutPage(page);
  await layout.goto();
  await layout.openProject(FIXTURE_PROJECT_ID);
  await layout.openSession(FIXTURE_SESSION_ID);

  await layout.chatBack.click();
  await expect(layout.sessionItems.first()).toBeVisible();
});

/**
 * Projects list tests / 项目列表测试
 */

import { test, expect } from '@playwright/test';
import { LayoutPage } from '../pages/LayoutPage';

const FIXTURE_PROJECT_ID = '-tmp-e2e-fixture';

test('lists the seeded fixture project', async ({ page }) => {
  const layout = new LayoutPage(page);
  await layout.goto();

  const count = await layout.projectItems.count();
  expect(count).toBeGreaterThanOrEqual(1);

  const fixture = page.locator(
    `[data-testid="project-item"][data-project-id="${FIXTURE_PROJECT_ID}"]`
  );
  await expect(fixture).toBeVisible();
});

test('opens project and reveals session list', async ({ page }) => {
  const layout = new LayoutPage(page);
  await layout.goto();

  await layout.openProject(FIXTURE_PROJECT_ID);

  const count = await layout.sessionItems.count();
  expect(count).toBeGreaterThanOrEqual(1);
});

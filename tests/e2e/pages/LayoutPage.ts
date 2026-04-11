/**
 * Main layout page object / 主布局页面对象
 *
 * Covers project list, session list, and ChatViewer interactions.
 * 覆盖项目列表、会话列表和 ChatViewer 交互。
 */

import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

type ViewMode = 'full' | 'dialog' | 'compact' | 'changes';

export class LayoutPage {
  readonly page: Page;
  readonly projectItems: Locator;
  readonly sessionItems: Locator;
  readonly chatViewer: Locator;
  readonly chatBack: Locator;

  constructor(page: Page) {
    this.page = page;
    this.projectItems = page.getByTestId('project-item');
    this.sessionItems = page.getByTestId('session-item');
    this.chatViewer = page.getByTestId('chat-viewer');
    this.chatBack = page.getByTestId('chat-back');
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    // Wait for projects API round-trip to settle
    // 等待项目 API 往返完成
    await this.page.waitForResponse(
      (resp) => resp.url().includes('/api/v1/projects') && resp.status() === 200,
      { timeout: 15_000 }
    );
    await this.projectItems.first().waitFor({ state: 'visible' });
  }

  async openProject(encodedPath: string): Promise<void> {
    const item = this.page.locator(`[data-testid="project-item"][data-project-id="${encodedPath}"]`);
    // Register the response listener BEFORE click to avoid a race:
    // the API can respond before waitForResponse has subscribed.
    // 必须先注册监听再点击，否则响应可能早于监听注册到达。
    await Promise.all([
      this.page.waitForResponse(
        (resp) =>
          resp.url().includes(`/projects/${encodedPath}/sessions`) && resp.status() === 200,
        { timeout: 10_000 }
      ),
      item.click(),
    ]);
    // Session list card must be visible before we interact with it
    // 会话卡片渲染后再继续
    await this.sessionItems.first().waitFor({ state: 'visible', timeout: 5_000 });
  }

  async openSession(sessionId: string): Promise<void> {
    const item = this.page.locator(`[data-testid="session-item"][data-session-id="${sessionId}"]`);
    await Promise.all([
      this.page.waitForResponse(
        (resp) =>
          resp.url().includes('/sessions/') &&
          resp.url().includes(sessionId) &&
          resp.status() === 200,
        { timeout: 10_000 }
      ),
      item.click(),
    ]);
    await this.chatViewer.waitFor({ state: 'visible' });
  }

  viewTab(mode: ViewMode): Locator {
    return this.page.getByTestId(`view-tab-${mode}`);
  }

  async selectView(mode: ViewMode): Promise<void> {
    const tab = this.viewTab(mode);
    await tab.click();
    await expect(tab).toHaveAttribute('data-active', 'true');
  }
}

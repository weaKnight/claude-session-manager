/**
 * Login page object / 登录页面对象
 */

import type { Locator, Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly passwordInput: Locator;
  readonly submitBtn: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByTestId('auth-heading');
    this.passwordInput = page.getByTestId('password-input');
    this.submitBtn = page.getByTestId('submit-btn');
    this.errorMessage = page.getByTestId('auth-error');
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    await this.heading.waitFor({ state: 'visible' });
  }

  async mode(): Promise<'setup' | 'login'> {
    const mode = await this.heading.getAttribute('data-mode');
    return mode === 'setup' ? 'setup' : 'login';
  }

  async submit(password: string): Promise<void> {
    await this.passwordInput.fill(password);
    await this.submitBtn.click();
  }
}

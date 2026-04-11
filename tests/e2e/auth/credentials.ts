/**
 * Shared test credentials / 共享测试凭据
 *
 * Kept in a plain module (not a spec) so both setup and login tests can
 * import without Playwright's spec-import guard complaining.
 * 使用普通模块存放，避免 Playwright 的 spec 导入守卫报错。
 */

export const TEST_PASSWORD = 'e2e-test-pass-2026';

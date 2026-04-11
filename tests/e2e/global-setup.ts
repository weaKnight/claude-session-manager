/**
 * Global setup / 全局初始化
 *
 * Runs ONCE before the entire test run.
 * 在整个测试运行之前执行一次。
 *
 * Responsibilities / 职责:
 *  1. Reset the isolated test HOME (delete auth.json, trash)
 *     重置隔离的测试 HOME（删除 auth.json 和回收站）
 *  2. Seed a deterministic .claude fixture with one project + session
 *     写入确定性的 .claude fixture（一个项目 + 一个会话）
 *  3. Ensure storageState directory exists
 *     确保 storageState 目录存在
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const TEST_HOME = join(REPO_ROOT, 'tests', 'fixtures', 'home');
const APP_DATA_DIR = join(TEST_HOME, '.claude-session-manager');
const CLAUDE_DIR = join(TEST_HOME, '.claude');
const PROJECT_ID = '-tmp-e2e-fixture';
const PROJECT_DIR = join(CLAUDE_DIR, 'projects', PROJECT_ID);
const SESSION_ID = 'e2e00001-0000-0000-0000-000000000001';
const SESSION_FILE = join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
const STORAGE_DIR = join(REPO_ROOT, 'tests', 'fixtures', '.auth');

function resetAppData(): void {
  // Wipe auth.json so first-run setup flow applies
  // 清空 auth.json 以触发首次安装流程
  if (existsSync(APP_DATA_DIR)) {
    rmSync(APP_DATA_DIR, { recursive: true, force: true });
  }
  mkdirSync(APP_DATA_DIR, { recursive: true });
}

function seedClaudeFixture(): void {
  // Always regenerate to guarantee deterministic content
  // 总是重新生成，确保内容确定性
  if (existsSync(CLAUDE_DIR)) {
    rmSync(CLAUDE_DIR, { recursive: true, force: true });
  }
  mkdirSync(PROJECT_DIR, { recursive: true });

  const entries = [
    {
      type: 'summary',
      summary: 'E2E fixture session for Playwright',
      timestamp: '2026-04-01T10:00:00.000Z',
      sessionId: SESSION_ID,
    },
    {
      type: 'user',
      message: { role: 'user', content: 'Hello from the e2e fixture' },
      timestamp: '2026-04-01T10:00:01.000Z',
      uuid: 'fixture-user-1',
      sessionId: SESSION_ID,
      cwd: '/tmp/e2e-fixture',
      gitBranch: 'main',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Acknowledged. This is a deterministic fixture reply.' }],
        usage: { input_tokens: 10, output_tokens: 8 },
      },
      timestamp: '2026-04-01T10:00:02.000Z',
      uuid: 'fixture-assistant-1',
      sessionId: SESSION_ID,
    },
    {
      type: 'user',
      message: { role: 'user', content: 'Please run ls to list files' },
      timestamp: '2026-04-01T10:00:03.000Z',
      uuid: 'fixture-user-2',
      sessionId: SESSION_ID,
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running ls.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
        usage: { input_tokens: 20, output_tokens: 12 },
      },
      timestamp: '2026-04-01T10:00:04.000Z',
      uuid: 'fixture-assistant-2',
      sessionId: SESSION_ID,
    },
  ];

  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(SESSION_FILE, jsonl, 'utf-8');
}

function ensureStorageDir(): void {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(TEST_HOME, { recursive: true });
  resetAppData();
  seedClaudeFixture();
  ensureStorageDir();
}

export { PROJECT_ID, SESSION_ID, TEST_HOME };

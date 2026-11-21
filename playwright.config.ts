import { defineConfig } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'story-builder-e2e-'));
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
const port = Number(process.env.STORY_E2E_PORT ?? '4311');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    env: { STORY_HTTP_PORT: String(port), STORY_HOST: '127.0.0.1', STORY_DB: join(directory, 'story.sqlite') },
  },
});

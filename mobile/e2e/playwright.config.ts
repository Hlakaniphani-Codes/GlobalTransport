import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: 'screenshots',
  testMatch: 'layout.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    cwd: '..',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

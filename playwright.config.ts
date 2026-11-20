import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  use: { baseURL: 'http://localhost:5199', launchOptions: { args: ['--enable-unsafe-webgpu'] } },
  webServer: { command: 'pnpm vite --port 5199 --strictPort', url: 'http://localhost:5199', reuseExistingServer: true },
});

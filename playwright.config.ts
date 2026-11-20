import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  // channel 'chromium' = full Chromium in new headless mode, which keeps a real GPU (WebGPU) on macOS;
  // the default headless shell loses its WebGPU device right after init.
  use: { baseURL: 'http://localhost:5199', channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } },
  webServer: { command: 'pnpm vite --port 5199 --strictPort', url: 'http://localhost:5199', reuseExistingServer: true },
});

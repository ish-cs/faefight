import { defineConfig } from '@playwright/test';

// Each run starts its own dev server (never reuses one), so a server left running by another
// worktree on the same port can't make tests silently run against the wrong code. Set E2E_PORT to
// run two checkouts' e2e suites side by side.
const port = Number(process.env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  // channel 'chromium' = full Chromium in new headless mode, which keeps a real GPU (WebGPU) on macOS;
  // the default headless shell loses its WebGPU device right after init.
  use: { baseURL: `http://localhost:${port}`, channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] } },
  webServer: { command: `pnpm vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false },
});

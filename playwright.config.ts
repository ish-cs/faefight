import { defineConfig } from '@playwright/test';

// Each run starts its own dev server (never reuses one), so a server left running by another
// worktree on the same port can't make tests silently run against the wrong code. Set E2E_PORT to
// run two checkouts' e2e suites side by side.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const port = Number(env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  // channel 'chromium' = full Chromium in new headless mode, which keeps a real GPU (WebGPU) on macOS;
  // the default headless shell loses its WebGPU device right after init.
  // Every test starts as a returning player (How to play already seen) so the first-launch card doesn't
  // cover the menu; tests/e2e/menuExtras.spec.ts clears this to test the first launch itself.
  use: {
    baseURL: `http://localhost:${port}`, channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] },
    storageState: { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'faefight.settings.v1', value: JSON.stringify({ v: 2, onboarding: { howToSeen: true } }) }] }] },
  },
  webServer: { command: `pnpm vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false },
});

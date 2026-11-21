import { defineConfig } from '@playwright/test';

// Each run starts its own dev server (never reuses one), so a server left running by another
// worktree on the same port can't make tests silently run against the wrong code. Set E2E_PORT to
// run two checkouts' e2e suites side by side.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const port = Number(env.E2E_PORT ?? 5199);
const CI = !!env.CI;

// Local (macOS): channel 'chromium' = full Chromium in new headless mode, which keeps a real GPU (WebGPU);
// the default headless shell loses its WebGPU device right after init.
// CI (GitHub Linux runners, no GPU): no WebGPU adapter, so three/webgpu's WebGPURenderer falls back to
// WebGL2, rendered in software by SwiftShader through ANGLE. Slower, so CI gets a longer test timeout.
const launchArgs = env.E2E_CHROME_ARGS ? env.E2E_CHROME_ARGS.split(' ').filter(Boolean)
  : CI ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--enable-unsafe-webgpu'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: CI ? 180_000 : 90_000,
  // Software GL frames are slow, so state changes take longer to show up: wait longer, check the same thing.
  ...(CI ? { expect: { timeout: 15_000 } } : {}),
  // CI: one retry, so a one-off runner hiccup doesn't block a merge; Playwright still reports it as "flaky".
  retries: CI ? 1 : 0,
  // Each worker runs a 3D game in its own browser: at most 2 locally (many agents share one Mac), 1 on CI (software GL).
  workers: CI ? 1 : 2,
  ...(CI ? { reporter: [['list'], ['html', { open: 'never' }]] as const } : {}),
  // Every test starts as a returning player (How to play already seen) so the first-launch card doesn't
  // cover the menu; tests/e2e/menuExtras.spec.ts clears this to test the first launch itself.
  // CI also starts on the low preset at half resolution: software GL is otherwise too slow to load a match
  // and keep the frame rate the gameplay tests rely on.
  use: {
    baseURL: `http://localhost:${port}`, channel: 'chromium', launchOptions: { args: launchArgs },
    storageState: { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'faefight.settings.v1', value: JSON.stringify({
      v: 2, onboarding: { howToSeen: true }, ...(CI ? { video: { quality: 'low', resolutionScale: 0.5 } } : {}),
    }) }] }] },
    ...(CI ? { trace: 'retain-on-failure' as const } : {}),
  },
  webServer: { command: `pnpm vite --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false, timeout: 120_000 },
});

import { test } from '@playwright/test';

// TEMPORARY: measures which software GL path is fast enough on CI. Removed before merge.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
test.skip(!env.GL_PROBE, 'probe only');
test('gl probe', async ({ page }) => {
  test.setTimeout(240_000);
  const logs: string[] = [];
  page.on('console', (m) => { if (/loading|warmup|renderer|WebGPU|WebGL|backend/i.test(m.text())) logs.push(m.text().slice(0, 200)); });
  await page.goto('/?debug=1');
  const info = await page.evaluate(async () => {
    const c = document.createElement('canvas').getContext('webgl2');
    const ext = c?.getExtension('WEBGL_debug_renderer_info');
    const gl = c && ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'none';
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    const ad = gpu ? await gpu.requestAdapter().catch(() => null) as { info?: { vendor: string; architecture: string; description: string } } | null : null;
    return { gl, webgpu: !!gpu, adapter: ad ? JSON.stringify(ad.info ?? {}) : 'none', cores: navigator.hardwareConcurrency };
  });
  console.log('[probe] env', JSON.stringify(info));
  const t0 = Date.now();
  await page.getByTestId('play-medium').click();
  await page.getByTestId('cash').filter({ hasText: '$50' }).waitFor({ timeout: 200_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading FAEFight"]')?.checkVisibility?.(), null, { timeout: 200_000 }).catch(() => {});
  const load = Date.now() - t0;
  const fps = await page.evaluate(() => new Promise<number>((res) => {
    let n = 0; const s = performance.now();
    const f = () => { n++; if (performance.now() - s < 5000) requestAnimationFrame(f); else res((n * 1000) / (performance.now() - s)); };
    requestAnimationFrame(f);
  }));
  const backend = await page.evaluate(() => (window as unknown as { __faefight: { renderInfo(): { backend: string } } }).__faefight.renderInfo().backend);
  console.log(`[probe] RESULT load=${load}ms fps=${fps.toFixed(1)} backend=${backend}`);
  console.log('[probe] logs\n' + logs.join('\n'));
});

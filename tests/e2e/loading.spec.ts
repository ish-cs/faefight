import { expect, test } from '@playwright/test';

type LoadEvent = { kind: 'show' | 'progress' | 'hide'; phase?: string; frac?: number; total: number; label?: string; t: number };

/**
 * Match loading screen: the painted bar never moves backwards, every phase dot ends done, the shader
 * compile reports N/M, and the game is only revealed once the warm-up (shaders + hidden frames) finished.
 */
test('match loading: monotonic bar, step dots, reveal only after warm-up', async ({ page }) => {
  test.setTimeout(90_000);
  // Sample the painted percentage every animation frame from page start.
  await page.addInitScript(() => {
    const w = window as unknown as { __bar: number[] };
    w.__bar = [];
    const f = () => {
      const el = document.getElementById('loading');
      if (el?.isConnected && !el.classList.contains('boot')) w.__bar.push(Number(el.getAttribute('aria-valuenow')));
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('loading-step-shaders')).toBeAttached();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 45_000 });
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 30_000 });

  const bar = await page.evaluate(() => (window as unknown as { __bar: number[] }).__bar);
  expect(bar.length).toBeGreaterThan(10);
  for (let i = 1; i < bar.length; i++) expect(bar[i], `frame ${i}: ${bar[i - 1]} → ${bar[i]}`).toBeGreaterThanOrEqual(bar[i - 1]);
  expect(bar.at(-1)).toBe(100);

  const all = await page.evaluate(() => (window as unknown as { __faefightLoading: { events(): LoadEvent[] } }).__faefightLoading.events());
  const ev = all.slice(all.map((e) => e.kind).lastIndexOf('show'));
  const hide = ev.findIndex((e) => e.kind === 'hide');
  expect(hide).toBeGreaterThan(0);
  const before = ev.slice(0, hide);
  // Revealed only after the shader warm-up and the hidden frames completed.
  expect(before.some((e) => e.phase === 'shaders' && e.frac === 1)).toBe(true);
  expect(before.some((e) => e.phase === 'frames' && e.frac === 1)).toBe(true);
  expect(before.some((e) => /^Compiling shaders \d+\/\d+$/.test(e.label ?? ''))).toBe(true);
  const totals = before.filter((e) => e.kind === 'progress').map((e) => e.total);
  for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1]);
});

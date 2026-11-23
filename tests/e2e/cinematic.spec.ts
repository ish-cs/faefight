import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

// Cinematic mode (src/client/cinematic): WATCH BOTS starts an all-bot match under the broadcast director.
const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;

type Cine = { active: boolean; cuts: number; shot: { kind: string; reason: string; playerId: number } | null };
const cine = (page: Page) => page.evaluate(() => {
  const d = (window as unknown as { __cinematic?: { active: boolean; cuts: number; shot: Cine['shot'] } }).__cinematic;
  return d ? { active: d.active, cuts: d.cuts, shot: d.shot ? { kind: d.shot.kind, reason: d.shot.reason, playerId: d.shot.playerId } : null } : null;
});

test('the menu offers Watch bots with lobby size and difficulty (8 PRO by default)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('watch-bots')).toBeVisible();
  await expect(page.getByTestId('watch-count')).toHaveValue('8');
  await expect(page.getByTestId('watch-difficulty')).toHaveValue('pro');
});

test.describe('in a match', () => {
  test.skip(ON_CI, NEEDS_GPU);

  test('Watch bots: the director cuts between shots for 60 s with no input, no errors and a steady frame rate', async ({ page }) => {
    test.setTimeout(200_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      const w = window as unknown as { __frames: number[] };
      w.__frames = [];
      const loop = (t: number) => { w.__frames.push(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?debug=1');
    await page.getByTestId('watch-bots').click();
    await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(async () => (await cine(page))?.active, { timeout: 30_000 }).toBe(true);
    // Clean broadcast HUD: the lower third, no hotbar / own stats / spectate banner.
    await expect(page.getByTestId('cinematic-overlay')).toBeVisible();
    await expect(page.getByTestId('cinematic-alive')).toHaveText(/\d+ ALIVE/);
    await expect(page.getByTestId('hotbar')).toBeHidden();
    await expect(page.getByTestId('spectate-banner')).toBeHidden();

    const t0 = await page.evaluate(() => performance.now());
    const kinds = new Set<string>();
    for (let s = 0; s < 60; s += 2) {
      await page.waitForTimeout(2000);
      const c = await cine(page);
      if (c?.shot) kinds.add(c.shot.kind);
      if (SHOTS && s % 12 === 0) await page.screenshot({ path: `${SHOTS}/cinematic-${s}s-${c?.shot?.kind}-${c?.shot?.reason}.png` });
    }
    const c = (await cine(page))!;
    const frames = await page.evaluate((from) => {
      const f = (window as unknown as { __frames: number[] }).__frames.filter((t) => t >= from);
      const ints = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
      return { n: ints.length, p95: ints[Math.floor(ints.length * 0.95)], max: ints[ints.length - 1], fps: ints.length / ((f[f.length - 1] - f[0]) / 1000) };
    }, t0);
    console.info(`[cinematic] ${c.cuts} cuts in 60 s, kinds ${[...kinds].join(',')}; ${frames.fps.toFixed(0)} fps, p95 ${frames.p95.toFixed(1)} ms, max ${frames.max.toFixed(0)} ms`);
    expect(c.cuts).toBeGreaterThanOrEqual(5);
    expect(kinds.size).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    expect(frames.p95).toBeLessThanOrEqual(50);
    expect(frames.max).toBeLessThanOrEqual(250);
  });

  test('spectating in a vs-bot match: N toggles the cinematic camera, Esc leaves it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?debug=1&bots=3');
    await page.getByTestId('play-easy').click();
    await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
    await page.locator('canvas.game').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type('/spectate');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('spectate-banner')).toContainText('N cinematic', { timeout: 15_000 });
    await page.locator('canvas.game').focus();
    await page.keyboard.press('KeyN');
    await expect.poll(async () => (await cine(page))?.active, { timeout: 10_000 }).toBe(true);
    await expect(page.getByTestId('cinematic-overlay')).toBeVisible();
    await expect(page.getByTestId('spectate-banner')).toBeHidden();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/cinematic-toggle.png` });
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await cine(page))?.active, { timeout: 10_000 }).toBe(false);
    await expect(page.getByTestId('cinematic-overlay')).toBeHidden();
  });
});

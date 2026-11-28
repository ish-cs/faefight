import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';
import { BLUR_BYPASS } from '../../src/client/world/motionBlur';

test.skip(ON_CI, NEEDS_GPU);
test.skip(BLUR_BYPASS, 'motion blur bypassed (hotfix stopgap, world/motionBlur.ts BLUR_BYPASS)');

type Blur = { on: number; shutter: number; radial: number; hold: number; ctx: 'play' | 'spectate' | 'killcam'; play: string; spectate: string };
const blur = (page: Page) => page.evaluate(() => (window as unknown as { __faefight: { motionBlur(): Blur } }).__faefight.motionBlur());
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('faefight.settings.v1') ?? 'null'));

test('motion blur: Settings toggle, off by default while playing, toggling mid-match never hitches', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1&bots=3');
  await expect(page.getByTestId('play-easy')).toBeVisible();

  // Settings → Video: both rows, defaults Off (playing) / Auto (spectating)
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-video').click();
  const play = page.getByTestId('set-mblur'), spec = page.getByTestId('set-mblur-spec');
  await expect(play.getByRole('button', { name: 'Off', exact: true })).toHaveClass(/\bon\b/);
  await expect(spec.getByRole('button', { name: 'Auto', exact: true })).toHaveClass(/\bon\b/);
  await play.getByRole('button', { name: 'High', exact: true }).click();
  expect((await stored(page)).video.motionBlur).toBe('high');
  await play.getByRole('button', { name: 'Off', exact: true }).click();
  expect((await stored(page)).video.motionBlur).toBe('off');
  await page.keyboard.press('Escape');

  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 90_000 });
  await expect.poll(async () => (await blur(page)).ctx, { timeout: 20_000 }).toBe('play');
  expect((await blur(page)).on).toBe(0); // default: no blur while playing

  // Toggle repeatedly mid-match while turning: uniforms only, so no frame takes longer than 50 ms.
  const r = await page.evaluate(async () => {
    const f = (window as unknown as { __faefight: { updateSettings(m: (s: { video: { motionBlur: string } }) => void): void; motionBlur(): Blur; input: { yaw: number } } }).__faefight;
    const ts: number[] = [], seen: number[] = [];
    let run = true;
    const t0 = performance.now(), y0 = f.input.yaw;
    const loop = (t: number) => { ts.push(t); f.input.yaw = y0 + 2 * (t - t0) / 1000; if (run) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    await new Promise((res) => setTimeout(res, 500));
    for (const lvl of ['high', 'off', 'low', 'off', 'high', 'low']) {
      f.updateSettings((s) => { s.video.motionBlur = lvl; });
      await new Promise((res) => setTimeout(res, 350));
      seen.push(f.motionBlur().on);
    }
    run = false;
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    return { maxGap: Math.max(...gaps.slice(2)), seen, frames: ts.length };
  });
  expect(r.seen).toEqual([1, 0, 1, 0, 1, 1]); // the default High preset compiles the pass: every level change applies live
  expect(r.frames).toBeGreaterThan(30);
  expect(r.maxGap).toBeLessThan(50);
  const b = await blur(page);
  expect(b.play).toBe('low');
  expect(b.hold).toBeGreaterThan(0.5); // the crosshair area keeps most of its sharpness
  expect(errors).toEqual([]);
});

test('motion blur: on by default while spectating (cinematic director and free camera)', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1&bots=3');
  await page.getByTestId('watch-bots').click();
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 90_000 });
  await expect.poll(async () => (await blur(page)).ctx, { timeout: 30_000 }).toBe('spectate');
  await expect.poll(async () => (await blur(page)).on, { timeout: 10_000 }).toBe(1);
  // the spectating level is its own setting: Off turns it off without touching the playing one
  await page.evaluate(() => (window as unknown as { __faefight: { updateSettings(m: (s: { video: { motionBlurSpectate: string } }) => void): void } }).__faefight
    .updateSettings((s) => { s.video.motionBlurSpectate = 'off'; }));
  await expect.poll(async () => (await blur(page)).on, { timeout: 5_000 }).toBe(0);
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';
import { LIFECYCLE } from '../../src/sim/constants';
import { KILLCAM_SEC, SLOW_LEAD_MIN, SLOWMO } from '../../src/client/qol/killcamBuffer';

const RESPAWN_MS = LIFECYCLE.respawnSec * 1000;

test.skip(ON_CI, NEEDS_GPU); // plays a match

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type P = { id: number; alive: boolean };
type Snap = { time: number; players: P[] };
type KcInfo = {
  active: boolean; started: boolean; reason: string; plan: { duration: number; real: number; lead: number } | null; frames: number; killer: number | null;
  real: number; slow: number; stats: { frames: number; blocked: number; maxStep: number; slowFrames: number; clampMax: number; sideSwitches: number; slowReal: number };
};
type Spec = { active: boolean; mode: string; followId: number | null; killcam: boolean };

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SHOTS = ENV.E2E_SHOTS;
/** Where the three killcam frames go (establishing / glide / slow beat): KILLCAM_SHOTS, else E2E_SHOTS. */
const KC_SHOTS = ENV.KILLCAM_SHOTS ?? SHOTS;
/** A frame sequence of the slow-motion section (motion blur) goes here when set. */
const KC_SEQ = ENV.KILLCAM_SEQ;

test('dying shows the killcam cinematic, it ends before the respawn; any key / click skips; kill feed lines', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() =>
    !(window as unknown as { __faefightLoading?: { visible(): boolean } }).__faefightLoading?.visible()), { timeout: 60_000 }).toBe(true);
  const me = await dbg<number>(page, 'humanId');
  const bot = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id !== me)!.id;
  // A few seconds of history to replay.
  await expect.poll(async () => (await dbg<KcInfo>(page, 'killcam')).frames, { timeout: 15_000 }).toBeGreaterThan(90);

  // Your kill: a highlighted feed line.
  await dbg(page, 'kill', bot, me);
  const mine = page.locator('[data-testid="feed-entry"].mine');
  await expect(mine).toBeVisible();
  await expect(mine).toContainText('You');
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === bot)!.alive, { timeout: RESPAWN_MS + 5_000 }).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol2-killfeed.png` });

  // Killed by the bot: the killcam plays, then ends by itself before the respawn.
  await page.waitForTimeout(RESPAWN_MS + 500); // fresh history with the bot alive again
  const diedAt = Date.now();
  // Longest frame gap around the killcam's start (the blur is compiled in up front: no shader build here).
  await page.evaluate(() => {
    const w = window as unknown as { __kcGap: number };
    w.__kcGap = 0;
    let last = performance.now();
    const end = last + 1500;
    const tick = (t: number) => { w.__kcGap = Math.max(w.__kcGap, t - last); last = t; if (t < end) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await dbg(page, 'kill', me, bot);
  const kc = page.getByTestId('killcam');
  await expect(kc).toBeVisible({ timeout: 5_000 });
  await expect(kc).toContainText('Killed by');
  await expect(page.locator('[data-testid="feed-entry"].me')).toBeVisible();
  const info = await dbg<KcInfo>(page, 'killcam');
  expect(info.started).toBe(true);
  expect(info.plan!.duration).toBeLessThan(LIFECYCLE.respawnSec); // fits in the respawn wait
  expect(info.plan!.real).toBeLessThanOrEqual(KILLCAM_SEC + 0.05); // ≤ 6 s, slow beat included
  expect(info.plan!.lead).toBeGreaterThanOrEqual(SLOW_LEAD_MIN - 1e-6); // held slow-mo before the shot
  // Three frames: the establishing angle, the glide in, and the slow-motion beat on the kill.
  const plan = info.plan!;
  const shot = async (name: string, until: (i: KcInfo) => boolean) => {
    await expect.poll(async () => { const i = await dbg<KcInfo>(page, 'killcam'); return !i.active || until(i); }, { timeout: 6_000, intervals: [30] }).toBe(true);
    if (KC_SHOTS && (await dbg<KcInfo>(page, 'killcam')).active) await page.screenshot({ path: `${KC_SHOTS}/killcam-${name}.png` });
  };
  await shot('1-establishing', (i) => i.real > 0.45);
  await shot('2-glide', (i) => i.real > plan.real * 0.5);
  if (KC_SEQ) {
    // The slow-motion section as rendered (a screencast: screenshots would stall the frames), until it eases back out.
    const { writeFileSync } = await import('node:fs');
    await expect.poll(async () => { const i = await dbg<KcInfo>(page, 'killcam'); return !i.active || i.slow > 0.02; }, { timeout: 6_000, intervals: [20] }).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    let n = 0;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      writeFileSync(`${KC_SEQ}/slowmo-${String(n++).padStart(3, '0')}.jpg`, Buffer.from(f.data, 'base64'));
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
    await expect.poll(async () => { const i = await dbg<KcInfo>(page, 'killcam'); return !i.active || i.slow < 0.02; }, { timeout: 8_000, intervals: [50] }).toBe(true);
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
  }
  await shot('3-slowmo', (i) => i.slow > 0.9);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol2-killcam.png` });
  await expect(kc).toBeHidden({ timeout: 5_000 });
  const done = await dbg<KcInfo>(page, 'killcam');
  console.log('[killcam e2e] stats', JSON.stringify(done.stats), 'real', done.plan!.real.toFixed(2));
  expect(done.reason).toBe('ended');
  expect(done.stats.slowFrames).toBeGreaterThan(5); // the slow beat played
  // The slow-motion window happened: held at ~SLOWMO for the final shot(s) (lead + hold after, slowed), within frame jitter.
  expect(done.stats.slowReal).toBeGreaterThan(((done.plan!.lead + 0.12) / SLOWMO) * 0.8);
  const gap = await page.evaluate(() => (window as unknown as { __kcGap: number }).__kcGap);
  console.log('[killcam e2e] longest frame around the start', gap.toFixed(1), 'ms');
  expect(gap).toBeLessThan(50); // no hitch starting it
  expect(done.stats.maxStep).toBeLessThan(25); // no camera snaps (m/s)
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === me)!.alive, { timeout: RESPAWN_MS + 5_000 }).toBe(true);
  expect(Date.now() - diedAt).toBeLessThan(RESPAWN_MS + 3000); // respawn not held up

  // Again, skipped with a key (any key, once past the short grace for the press you died on).
  await page.waitForTimeout(RESPAWN_MS + 500);
  await dbg(page, 'kill', me, bot);
  await expect(kc).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyQ');
  await expect(kc).toBeHidden({ timeout: 1_000 });
  expect((await dbg<KcInfo>(page, 'killcam')).reason).toBe('skipped');
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === me)!.alive, { timeout: RESPAWN_MS + 5_000 }).toBe(true);

  // And with a click.
  await page.waitForTimeout(RESPAWN_MS + 500);
  await dbg(page, 'kill', me, bot);
  await expect(kc).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await page.mouse.click(640, 360);
  await expect(kc).toBeHidden({ timeout: 1_000 });
  expect((await dbg<KcInfo>(page, 'killcam')).reason).toBe('skipped');
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === me)!.alive, { timeout: RESPAWN_MS + 5_000 }).toBe(true);

  expect(errors).toEqual([]);
});

test("spectating: the followed player's death plays the same killer-view killcam, then you keep following", async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('bots-2').click();
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  const me = await dbg<number>(page, 'humanId');
  await expect.poll(async () => (await dbg<KcInfo>(page, 'killcam')).frames, { timeout: 15_000 }).toBeGreaterThan(90);

  // Out of the match (no killer: no killcam), spectate and follow the first bot.
  await dbg(page, 'eliminate', me);
  await page.getByTestId('spectate').click();
  await page.locator('canvas.game').focus();
  await page.keyboard.press('Digit1');
  await expect.poll(async () => (await dbg<Spec>(page, 'spectator')).mode).toBe('follow');
  const followed = (await dbg<Spec>(page, 'spectator')).followId!;
  const other = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id !== me && p.id !== followed)!.id;

  // The other bot "kills" it: the killer-view replay plays (not the body cam fallback).
  await dbg(page, 'kill', followed, other);
  const kc = page.getByTestId('killcam');
  await expect(kc).toBeVisible({ timeout: 5_000 });
  expect((await dbg<KcInfo>(page, 'killcam')).killer).toBe(other);
  expect((await dbg<Spec>(page, 'spectator')).killcam).toBe(false);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol2-killcam-spectator.png` });
  await expect(kc).toBeHidden({ timeout: (KILLCAM_SEC + 1.5) * 1000 });
  expect((await dbg<Spec>(page, 'spectator')).mode).toBe('follow');
  expect(errors).toEqual([]);
});

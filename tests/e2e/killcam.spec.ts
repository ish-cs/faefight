import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';
import { LIFECYCLE } from '../../src/sim/constants';

const RESPAWN_MS = LIFECYCLE.respawnSec * 1000;

test.skip(ON_CI, NEEDS_GPU); // plays a match

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type P = { id: number; alive: boolean };
type Snap = { time: number; players: P[] };
type KcInfo = { active: boolean; started: boolean; reason: string; plan: { duration: number } | null; frames: number; killer: number | null };
type Spec = { active: boolean; mode: string; followId: number | null; killcam: boolean };

const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;

test('dying shows the killcam from the killer, it ends before the respawn; Space skips; kill feed lines', async ({ page }) => {
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
  await dbg(page, 'kill', me, bot);
  const kc = page.getByTestId('killcam');
  await expect(kc).toBeVisible({ timeout: 5_000 });
  await expect(kc).toContainText('Killed by');
  await expect(page.locator('[data-testid="feed-entry"].me')).toBeVisible();
  const info = await dbg<KcInfo>(page, 'killcam');
  expect(info.started).toBe(true);
  expect(info.plan!.duration).toBeLessThan(LIFECYCLE.respawnSec); // fits in the respawn wait
  await page.waitForTimeout(900);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qol2-killcam.png` });
  await expect(kc).toBeHidden({ timeout: 5_000 });
  expect((await dbg<KcInfo>(page, 'killcam')).reason).toBe('ended');
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === me)!.alive, { timeout: RESPAWN_MS + 5_000 }).toBe(true);
  expect(Date.now() - diedAt).toBeLessThan(RESPAWN_MS + 3000); // respawn not held up

  // Again, skipped with Space.
  await page.waitForTimeout(RESPAWN_MS + 500);
  await dbg(page, 'kill', me, bot);
  await expect(kc).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press('Space');
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
  await expect(kc).toBeHidden({ timeout: 5_000 });
  expect((await dbg<Spec>(page, 'spectator')).mode).toBe('follow');
  expect(errors).toEqual([]);
});

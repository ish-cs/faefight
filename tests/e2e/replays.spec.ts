import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type Snap = { tick: number; time: number; players: { id: number; alive: boolean; pos: { x: number; z: number } }[]; winner: number | null };
type RState = { tick: number; playing: boolean; speed: number; divergedAt: number | null } | null;

test('a vs-bot match is recorded; Replays lists it; it plays back, pauses, changes speed and seeks', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');

  // Play a few seconds, walk around, then end it (the bot is eliminated → I win → recording saved).
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await page.locator('canvas.game').focus();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(2500);
  const me = await dbg<number>(page, 'humanId');
  const bot = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id !== me)!.id;
  await dbg(page, 'eliminate', bot);
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).winner, { timeout: 10_000 }).toBe(me);
  const liveEnd = await dbg<Snap>(page, 'snapshot');
  await page.waitForTimeout(500); // the worker encodes, the page stores it
  await page.getByTestId('back-to-menu').click();

  // Replays screen: the match is there.
  await page.getByTestId('open-replays').click({ timeout: 30_000 });
  const rows = page.getByTestId('replay-row');
  await expect(rows).toHaveCount(1, { timeout: 10_000 });
  await expect(rows.first()).toContainText('Winner: You');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __faefightLoading?: { visible(): boolean } }).__faefightLoading?.visible())).toBe(false);
  await page.waitForTimeout(400); // loading screen fade
  await page.screenshot({ path: 'test-results/replays-list.png' });

  // Watch it.
  await rows.first().getByTestId('replay-watch').click();
  await expect(page.getByTestId('replay-bar')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await dbg<RState>(page, 'replayState'))?.tick ?? 0, { timeout: 20_000 }).toBeGreaterThan(20);
  const st = (await dbg<RState>(page, 'replayState'))!;
  expect(st.playing).toBe(true);
  expect(st.divergedAt).toBeNull();
  await expect.poll(async () => (await dbg<{ active: boolean }>(page, 'spectator')).active).toBe(true);

  // Pause holds the tick; 4× runs faster.
  await page.getByTestId('replay-play').click();
  await expect.poll(async () => (await dbg<RState>(page, 'replayState'))!.playing).toBe(false);
  const held = (await dbg<RState>(page, 'replayState'))!.tick;
  await page.waitForTimeout(400);
  expect((await dbg<RState>(page, 'replayState'))!.tick).toBe(held);
  await page.getByTestId('replay-speed').selectOption('4');
  await page.getByTestId('replay-play').click();
  await page.waitForTimeout(1000);
  const ran = (await dbg<RState>(page, 'replayState'))!.tick - held;
  expect(ran).toBeGreaterThan(70); // ~120 at 4×

  // Seek back to 2 s, then to the end: the replayed end matches the live end exactly.
  const seek = async (tick: number) => page.getByTestId('replay-seek').evaluate((el, t) => {
    const r = el as HTMLInputElement;
    r.value = String(t);
    r.dispatchEvent(new Event('change'));
  }, tick);
  await seek(60);
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot'))?.tick).toBeGreaterThanOrEqual(60);
  expect((await dbg<Snap>(page, 'snapshot')).tick).toBeLessThan(200);
  await page.getByTestId('replay-follow').selectOption(String(me));
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/replays-viewer.png' });
  await page.getByTestId('replay-play').click(); // toggle playback (4× already ran this short match to its end)
  await seek(100000);
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot'))?.winner ?? null, { timeout: 20_000 }).toBe(me);
  const end = (await dbg<RState>(page, 'replayState'))!;
  expect(end.divergedAt).toBeNull();
  const replayed = await dbg<Snap>(page, 'snapshot');
  const live = liveEnd.players.find((p) => p.id === me)!, again = replayed.players.find((p) => p.id === me)!;
  // The live snapshot was read a little after the win; positions agree once both are at/after the winning tick.
  expect(Math.hypot(live.pos.x - again.pos.x, live.pos.z - again.pos.z)).toBeLessThan(0.5);

  await page.getByTestId('replay-exit').click();
  await expect(page.getByTestId('replays-screen')).toBeVisible();
  expect(errors.filter((e) => !/WebGPU|GPU|favicon/i.test(e))).toEqual([]);
});

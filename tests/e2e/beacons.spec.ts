import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

type Snap = { sealed: boolean[]; players: { id: number; island: number; eliminated: boolean }[] };
type Beacon = { phase: string; seal: number; cut: number };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

/** Beacon state + what the one instanced draw shows. */
const beacons = (page: Page) => page.evaluate(() => {
  type B = { states: { count: number; at(i: number): Beacon }; mesh: { visible: boolean; geometry: { instanceCount: number } } };
  type Beacon = { phase: string; seal: number; cut: number };
  const b = (window as unknown as { __faefight: { renderer: { beacons: B } } }).__faefight.renderer.beacons;
  const list: Beacon[] = [];
  for (let i = 0; i < b.states.count; i++) { const e = b.states.at(i); list.push({ phase: e.phase, seal: e.seal, cut: e.cut }); }
  return { list, visible: b.mesh.visible, drawn: b.mesh.geometry.instanceCount };
});

test('island beacons: one beam per living player, sealed look, shutdown on elimination, settings toggle', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?debug=1&bots=3');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  const humanId = await dbg<number>(page, 'humanId');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const s0 = await snap();
  const me = s0.players.find((p) => p.id === humanId)!;
  const bot = s0.players.find((p) => p.id !== humanId)!;

  // Every player's island has an open beam, all in one draw.
  await expect.poll(async () => (await beacons(page)).drawn, { timeout: 5000 }).toBe(4);
  let b = await beacons(page);
  expect(b.visible).toBe(true);
  for (const p of s0.players) expect(b.list[p.island].phase).toBe('open');

  // Seal my bunker (an enemy plate in each doorway): my beam goes to the sealed look; the others stay open.
  for (const door of [0, 1, 2]) await dbg(page, 'plugDoor', door, bot.id);
  await expect.poll(async () => (await snap()).sealed[me.island], { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await beacons(page)).list[me.island].seal, { timeout: 5000 }).toBe(1);
  b = await beacons(page);
  expect(b.list[me.island].phase).toBe('sealed');
  expect(b.list[bot.island].phase).toBe('open');
  expect(b.drawn).toBe(4);

  // Eliminate a bot: its beam shuts down (collapsing), then is gone; the draw covers the other three.
  await dbg(page, 'eliminate', bot.id);
  await expect.poll(async () => (await beacons(page)).list[bot.island].phase, { timeout: 5000 }).toMatch(/down|gone/);
  await expect.poll(async () => (await beacons(page)).list[bot.island].phase, { timeout: 10_000 }).toBe('gone');
  await expect.poll(async () => (await beacons(page)).drawn, { timeout: 5000 }).toBe(3);

  // Settings: Island beacons Off hides them, On brings them back.
  const setBeacons = (on: boolean) => page.evaluate((on) => {
    type U = (f: (d: { gameplay: { islandBeacons: boolean } }) => void) => void;
    (window as unknown as { __faefight: { updateSettings: U } }).__faefight.updateSettings((d) => { d.gameplay.islandBeacons = on; });
  }, on);
  await setBeacons(false);
  await expect.poll(async () => (await beacons(page)).visible, { timeout: 5000 }).toBe(false);
  await setBeacons(true);
  await expect.poll(async () => (await beacons(page)).visible, { timeout: 5000 }).toBe(true);
  expect(errors).toEqual([]);
});

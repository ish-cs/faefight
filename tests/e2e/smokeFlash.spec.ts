import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

// Smoke grenades and flashbangs end to end (vs an easy bot): a thrown smoke pops into a drawn cloud (and fogs the
// screen from inside); a flashbang thrown by someone else whites the screen out (grey with Reduced flash); my own
// flashbang never does. SF_SHOTS=<dir> saves screenshots there.

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type V = { x: number; y: number; z: number };
type Player = { id: number; island: number; alive: boolean; pos: V; hotbar: (string | null)[]; inv: { smokes?: number }; blind?: { at: number; k: number } };
type Snap = { players: Player[]; smokes?: { id: number; owner: number; pos: V; t0: number }[] };
type Fx = { clouds: number; puffs: number; visible: boolean; depth: number; fog: number; flash: number; flashColor: string };

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SHOTS = env.SF_SHOTS;
const shot = (page: Page, name: string) => page.screenshot({ path: SHOTS ? `${SHOTS}/${name}.png` : `test-results/smokeflash-${name}.png` });
const look = (page: Page, yaw: number, pitch: number) => page.evaluate(([y, p]) => {
  const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
  input.yaw = y; input.pitch = p;
}, [yaw, pitch] as const);

test('smoke cloud renders and fogs the view inside; a flash by someone else whites out, my own does not', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  // never the power saver (on battery it drops shadows / resolution mid-test; see the final report)
  await page.addInitScript(() => {
    const k = 'faefight.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    localStorage.setItem(k, JSON.stringify({ ...s, video: { ...(s.video ?? {}), power: 'quality' } }));
  });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const def = await dbg<{ islands: { center: V }[] }>(page, 'mapDef');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const me = async () => (await snap()).players.find((p) => p.id === humanId)!;
  const fx = () => dbg<Fx>(page, 'smokeFlash');
  const c = def.islands[(await me()).island].center;
  const bot = (await snap()).players.find((p) => p.id !== humanId)!;

  // (a) Throw a smoke: it pops on the ground ahead and the cloud is drawn.
  await dbg(page, 'give', { smokes: 1 });
  await expect.poll(async () => (await me()).inv.smokes ?? 0).toBe(1);
  const slot = (await me()).hotbar.indexOf('smoke');
  expect(slot).toBeGreaterThanOrEqual(0);
  await page.locator('canvas.game').click();
  await page.keyboard.press(`Digit${slot + 1}`);
  await dbg(page, 'teleport', c.x - 6, c.z + 3);
  await look(page, -Math.PI / 2, -0.9); // toward +X, steeply down: lands a few metres ahead
  await page.waitForTimeout(600);
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await snap()).smokes?.filter((s) => s.owner === humanId).length ?? 0, { timeout: 6000 }).toBe(1);
  expect((await me()).inv.smokes ?? 0).toBe(0);
  const cloud = (await snap()).smokes!.find((s) => s.owner === humanId)!;
  await expect.poll(async () => (await fx()).clouds).toBe(1);
  const f1 = await fx();
  expect(f1.visible).toBe(true);
  expect(f1.puffs).toBeGreaterThanOrEqual(16);
  // From 16 m off, once it has bloomed: a big cloud.
  await dbg(page, 'teleport', cloud.pos.x - 16, cloud.pos.z);
  await look(page, -Math.PI / 2, -0.05);
  await page.waitForTimeout(1800);
  expect((await fx()).fog).toBe(0);
  await shot(page, 'smoke-outside');
  // Inside it: the screen fogs over.
  await dbg(page, 'teleport', cloud.pos.x, cloud.pos.z);
  await expect.poll(async () => (await fx()).fog, { timeout: 4000 }).toBeGreaterThan(0.5);
  await shot(page, 'smoke-inside');

  // (b) A flash by the bot, 3 m in front of my eyes: white-out.
  await dbg(page, 'teleport', c.x - 4, c.z - 8);
  await look(page, -Math.PI / 2, 0);
  await page.waitForTimeout(900);
  const p0 = (await me()).pos;
  await dbg(page, 'explode', 'flash', p0.x + 3, p0.z, 1.5, bot.id);
  await expect.poll(async () => (await me()).blind?.k ?? 0, { timeout: 3000 }).toBeGreaterThan(0.5);
  await expect.poll(async () => (await fx()).flash, { timeout: 3000 }).toBeGreaterThan(0.9);
  expect((await fx()).flashColor).toBe('#ffffff');
  await shot(page, 'flash-full');
  if (SHOTS) for (let i = 0; i < 8; i++) { await page.waitForTimeout(450); await shot(page, `flash-fade-${i}`); }
  // fades back to a clear view
  await expect.poll(async () => (await fx()).flash, { timeout: 8000 }).toBe(0);

  // Reduced flash: a dim grey instead.
  await page.evaluate(() => (window as unknown as { __faefight: { updateSettings(m: (d: { gameplay: { reducedFlash: boolean } }) => void): void } })
    .__faefight.updateSettings((d) => { d.gameplay.reducedFlash = true; }));
  const p1 = (await me()).pos;
  await dbg(page, 'explode', 'flash', p1.x + 3, p1.z, 1.5, bot.id);
  await expect.poll(async () => (await fx()).flash, { timeout: 3000 }).toBeGreaterThan(0.6);
  const rf = await fx();
  expect(rf.flashColor).toBe('#777777');
  expect(rf.flash).toBeLessThanOrEqual(0.85);
  await shot(page, 'flash-reduced');
  await page.evaluate(() => (window as unknown as { __faefight: { updateSettings(m: (d: { gameplay: { reducedFlash: boolean } }) => void): void } })
    .__faefight.updateSettings((d) => { d.gameplay.reducedFlash = false; }));
  await expect.poll(async () => (await fx()).flash, { timeout: 8000 }).toBe(0);

  // (c) My own flash, same spot: never blinds me.
  const p2 = (await me()).pos;
  await dbg(page, 'explode', 'flash', p2.x + 5, p2.z + 2, 1.2, humanId); // off to the right of my avatar, so the burst shows
  if (SHOTS) for (let i = 0; i < 4; i++) await shot(page, `flash-own-pop-${i}`); // the burst at the pop point
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(150);
    expect((await fx()).flash).toBe(0);
  }
  expect((await me()).blind).toBeUndefined();
  await shot(page, 'flash-own');

  expect(errors.filter((e) => !/favicon|DevTools/.test(e))).toEqual([]);
});

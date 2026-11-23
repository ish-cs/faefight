import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

// Explosive barrels and supply crates, end to end in a real match (vs an easy bot): shooting a barrel blows it up
// and hurts the bot standing next to it; shooting a crate breaks it and a loot bag appears where it stood.
// BARREL_SHOTS=1 also saves the screenshots to docs/screens/barrels-*.png.

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type V = { x: number; y: number; z: number };
type Hazard = { id: number; kind: 'barrel' | 'propane' | 'crate'; pos: V; island: number };
type Def = { islands: { center: V }[]; hazards: Hazard[] };
type Player = { id: number; island: number; hp: number; alive: boolean; deaths: number; pos: V; equipped: string };
type Snap = { players: Player[]; loot: { id: number; pos: V }[]; hz?: { id: number; st: number; hp: number }[] };

const SHOTS = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BARREL_SHOTS;
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: SHOTS ? `docs/screens/barrels-${name}.png` : `test-results/barrels-${name}.png` });
};

/** A point d m from h toward the island centre, turned `side` radians around h (0 = straight toward the centre). */
const around = (h: Hazard, c: V, d: number, side = 0): V => {
  const a = Math.atan2(c.z - h.pos.z, c.x - h.pos.x) + side;
  return { x: h.pos.x + Math.cos(a) * d, y: h.pos.y, z: h.pos.z + Math.sin(a) * d };
};
const aim = (page: Page, from: V, to: V) => page.evaluate(([f, t]) => {
  const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
  const ex = f.x, ey = f.y + 1.6, ez = f.z;
  input.yaw = Math.atan2(-(t.x - ex), -(t.z - ez));
  input.pitch = Math.atan2(t.y - ey, Math.hypot(t.x - ex, t.z - ez));
}, [from, to] as const);

test('shoot a barrel: it fuses, blows, and the bot next to it takes damage; shoot a crate: loot appears', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const def = await dbg<Def>(page, 'mapDef');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const me = async () => (await snap()).players.find((p) => p.id === humanId)!;
  const bot = async () => (await snap()).players.find((p) => p.id !== humanId)!;
  const island = (await me()).island;
  const c = def.islands[island].center;
  const barrel = def.hazards.find((h) => h.island === island && h.kind === 'barrel')!;
  const crate = def.hazards.find((h) => h.island === island && h.kind === 'crate')!;
  expect(barrel && crate).toBeTruthy();
  const hz = async (id: number) => (await snap()).hz?.find((h) => h.id === id)?.st ?? 0;

  // Rifle in hand, standing 9 m from the barrel; the bot parked 1.6 m beside it (off the line of fire).
  await dbg(page, 'give', { weapons: { rifle: { mag: 25, spare: 50 } } });
  await page.locator('canvas.game').click();
  await page.keyboard.press('Digit2');
  await expect.poll(async () => (await me()).equipped).toBe('rifle');
  const stand = around(barrel, c, 9);
  await dbg(page, 'teleport', stand.x, stand.z);
  const botId = (await bot()).id;
  const park = around(barrel, c, 1.6, Math.PI / 2);
  await dbg(page, 'teleport', park.x, park.z, botId);
  await page.waitForTimeout(3600); // the bot's spawn protection runs out 3 s after it leaves its bunker
  await dbg(page, 'teleport', park.x, park.z, botId);
  const center = { x: barrel.pos.x, y: barrel.pos.y + 0.46, z: barrel.pos.z };
  await aim(page, stand, center);
  await page.waitForTimeout(300);
  await shot(page, 'aim');

  const hp0 = (await bot()).hp;
  await page.mouse.down({ button: 'right' }); // sights up: tight spread
  await page.waitForTimeout(400);
  await aim(page, stand, center);
  await page.mouse.down();
  await expect.poll(() => hz(barrel.id), { timeout: 5000, intervals: [16] }).toBeGreaterThanOrEqual(1);
  await page.mouse.up();
  await page.mouse.up({ button: 'right' });
  // The bot is the target dummy: it would run from a hissing barrel (bots do), so hold it in place until it blows.
  const t0 = Date.now();
  let shotFuse = false;
  while ((await hz(barrel.id)) !== 2 && Date.now() - t0 < 3000) {
    await dbg(page, 'teleport', park.x, park.z, botId);
    if (!shotFuse && Date.now() - t0 > 400) { await shot(page, 'fuse'); shotFuse = true; }
    await page.waitForTimeout(50);
  }
  expect(await hz(barrel.id)).toBe(2);
  await page.waitForTimeout(90);
  await shot(page, 'explosion');
  await expect.poll(async () => { const b = await bot(); return !b.alive || b.hp < hp0; }, { timeout: 3000 }).toBe(true);
  await page.waitForTimeout(1500);
  await shot(page, 'scorch');

  // Crate: 2.5 m away (outside pickup reach), a few rifle rounds.
  const cstand = around(crate, c, 2.5);
  await dbg(page, 'teleport', cstand.x, cstand.z);
  await page.waitForTimeout(300);
  const ccenter = { x: crate.pos.x, y: crate.pos.y + 0.4, z: crate.pos.z };
  await aim(page, cstand, ccenter);
  await page.waitForTimeout(200);
  await shot(page, 'crate');
  await aim(page, cstand, ccenter);
  await page.mouse.down();
  await expect.poll(() => hz(crate.id), { timeout: 5000, intervals: [16] }).toBe(2);
  await page.mouse.up();
  await page.waitForTimeout(120);
  await shot(page, 'crate-break');
  await expect.poll(async () => (await snap()).loot.some((l) => Math.hypot(l.pos.x - crate.pos.x, l.pos.z - crate.pos.z) < 0.3), { timeout: 3000 }).toBe(true);

  expect(errors.filter((e) => !/WebGPU|GPU|favicon/i.test(e))).toEqual([]);
});

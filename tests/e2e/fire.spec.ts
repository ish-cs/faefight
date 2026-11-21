import { expect, test, type Page } from '@playwright/test';

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type Piece = { id: number; owner: number; kind: string; hp: number; burning?: boolean; pos: { x: number; y: number; z: number } };
type Snap = { players: { id: number; island: number; pos: { x: number; y: number; z: number }; equipped: string }[]; pieces: Piece[] };
type Isl = { center: { x: number; z: number }; bunker: { facingYaw: number } };

const aim = (page: Page, yaw: number, pitch: number) => page.evaluate(([y, p]) => {
  const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
  input.yaw = y; input.pitch = p;
}, [yaw, pitch] as const);

test('a rocket that lands short of a wood wall sets it burning, and the fire destroys it within ~20 s', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const me = async () => (await snap()).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];
  // Island frame: forward (toward the enemy side) and right of the bunker's facing.
  const yaw = home.bunker.facingYaw;
  const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) }, r = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const at = (d: number, side: number) => ({ x: home.center.x + f.x * d + r.x * side, z: home.center.z + f.z * d + r.z * side });

  // A wood wall 6 m out, facing the island centre.
  const w = at(6, -4);
  await dbg(page, 'place', 'wood', w.x, w.z, yaw);
  await expect.poll(async () => (await snap()).pieces.filter((p) => p.kind === 'wood' && p.owner === 0).length).toBe(1);
  const wall = (await snap()).pieces.find((p) => p.kind === 'wood' && p.owner === 0)!;

  // Stand 8 m behind it with a launcher, aimed at the ground ~4.4 m short of the wall.
  const stand = at(-2, -4);
  await dbg(page, 'teleport', stand.x, stand.z);
  await dbg(page, 'give', { weapons: { rocket: { mag: 1, spare: 0 } } });
  await page.locator('canvas.game').click();
  await page.keyboard.press('Digit1');
  await expect.poll(async () => (await me()).equipped).toBe('rocket');
  const ground = 3.6;
  await aim(page, yaw, -Math.atan2(1.6, ground));
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();

  // It catches...
  await expect.poll(async () => (await snap()).pieces.find((p) => p.id === wall.id)?.burning ?? false, { timeout: 4000 }).toBe(true);
  const lit = Date.now();
  const hpLit = (await snap()).pieces.find((p) => p.id === wall.id)!.hp;
  expect(hpLit).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/fire-wall-burning.png' });
  // ...loses health while it burns...
  await expect.poll(async () => (await snap()).pieces.find((p) => p.id === wall.id)?.hp ?? 0, { timeout: 5000 }).toBeLessThan(hpLit - 10);
  // ...and burns down (13 HP/s; well inside 20 s of catching).
  await expect.poll(async () => (await snap()).pieces.some((p) => p.id === wall.id), { timeout: 20_000, intervals: [250] }).toBe(false);
  const tookSec = (Date.now() - lit) / 1000;
  console.log(`[fire] wall caught at ${Math.round(hpLit)} HP, burnt down after ${tookSec.toFixed(1)} s`);
  expect(tookSec).toBeLessThan(20);
  expect(errors, errors.join('\n')).toEqual([]);
});

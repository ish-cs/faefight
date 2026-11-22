import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

// Bullet holes go with the wall they were on: shoot a wood wall full of holes until it breaks, and no mark (the
// wall's own holes or a world mark from the shot that broke it) is left floating where the wall stood.

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type V = { x: number; y: number; z: number };
type Piece = { id: number; owner: number; kind: string; hp: number; pos: V; rotY: number };
type Snap = { players: { id: number; island: number; pos: V; equipped: string }[]; pieces: Piece[] };
type Isl = { center: { x: number; z: number }; bunker: { facingYaw: number } };

/** Live marks (built-piece holes + world marks) whose centre lies inside the wall's box grown by 0.3 m. */
const marksAt = (page: Page, wall: Piece) => page.evaluate((w) => {
  type Inst = { count: number; getMatrixAt(i: number, m: unknown): void };
  const r = (window as unknown as { __faefight: { renderer: { world: { pieceFx: { decals: { mesh: Inst } }; impacts: { mesh: Inst; ring: { alpha(i: number): number } } } } } }).__faefight.renderer;
  const M = (r.world.impacts.mesh as unknown as { matrixWorld: { constructor: new () => { elements: number[] } } }).matrixWorld.constructor;
  const m = new M();
  const inWall = (x: number, y: number, z: number) => {
    const dx = x - w.pos.x, dz = z - w.pos.z, c = Math.cos(-w.rotY), s = Math.sin(-w.rotY);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    return Math.abs(lx) <= 1 + 0.3 && Math.abs(lz) <= 0.1 + 0.3 && y >= w.pos.y - 0.3 && y <= w.pos.y + 2 + 0.3;
  };
  let holes = 0, world = 0;
  const each = (mesh: Inst, live: (i: number) => boolean) => {
    let n = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      const e = m.elements;
      if (Math.hypot(e[0], e[1], e[2]) < 1e-6 || !live(i)) continue; // a freed slot (zero scale) or faded out
      if (inWall(e[12], e[13], e[14])) n++;
    }
    return n;
  };
  holes = each(r.world.pieceFx.decals.mesh, () => true);
  world = each(r.world.impacts.mesh, (i) => r.world.impacts.ring.alpha(i) > 0);
  return { holes, world };
}, wall);

test('bullet holes vanish with the wall they were in (no levitating holes)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const me = async () => (await snap()).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];
  const yaw = home.bunker.facingYaw;
  const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) }, r = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const at = (d: number, side: number) => ({ x: home.center.x + f.x * d + r.x * side, z: home.center.z + f.z * d + r.z * side });

  // A wood wall 6 m out, facing us; we stand 7 m behind it with a rifle.
  const w = at(6, -4);
  await dbg(page, 'place', 'wood', w.x, w.z, yaw);
  await expect.poll(async () => (await snap()).pieces.filter((p) => p.kind === 'wood' && p.owner === 0).length).toBe(1);
  const wall = (await snap()).pieces.find((p) => p.kind === 'wood' && p.owner === 0)!;
  const stand = at(-1, -4);
  await dbg(page, 'teleport', stand.x, stand.z);
  await dbg(page, 'give', { weapons: { rifle: { mag: 25, spare: 100 } } });
  await page.locator('canvas.game').click();
  await page.keyboard.press('Digit1');
  await expect.poll(async () => (await me()).equipped).toBe('rifle');
  // Aim at the wall's middle (eye 1.6 m up, wall centre 1 m up).
  await page.evaluate(([y, p]) => {
    const input = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
    input.yaw = y; input.pitch = p;
  }, [yaw, -Math.atan2(0.6, 7)] as const);
  await page.waitForTimeout(200);

  // A few shots: holes appear in the wall.
  for (let i = 0; i < 4; i++) { await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(220); }
  await expect.poll(async () => (await marksAt(page, wall)).holes, { timeout: 5000 }).toBeGreaterThan(0);
  expect((await snap()).pieces.some((p) => p.id === wall.id)).toBe(true);

  // Keep firing until it breaks: no hole and no world mark is left where it stood.
  await page.mouse.down();
  await expect.poll(async () => (await snap()).pieces.some((p) => p.id === wall.id), { timeout: 20_000 }).toBe(false);
  await page.mouse.up();
  await page.waitForTimeout(800); // the last snapshots' events (the breaking shot) are in
  expect(await marksAt(page, wall)).toEqual({ holes: 0, world: 0 });
  expect(errors).toEqual([]);
});

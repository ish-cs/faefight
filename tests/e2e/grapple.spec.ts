import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

// Grappling hook: bought at the home shop, sits in the hotbar; a click hooks the wall in the crosshair, the rope
// shows and reels the player in; a use is spent.

type V = { x: number; y: number; z: number };
type Me = { id: number; island: number; pos: V; inv: { cash: number; grapples?: number }; hotbar: (string | null)[]; hook?: { st: number } };
type Snap = { players: Me[] };
type Isl = { center: V; shop: V; bunker: { facingYaw: number } };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

test('buy a grappling hook, hook a wall, get reeled in', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __faefight: { input: { enabled: boolean } } }).__faefight.input.enabled), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.elementFromPoint(640, 360)?.tagName), { timeout: 30_000 }).toBe('CANVAS');
  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = map[(await me()).island];

  // Buy it at the home shop.
  await dbg(page, 'give', { cash: 500 });
  const dx = home.center.x - home.shop.x, dz = home.center.z - home.shop.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.shop.x + (dx / d) * 1.5, home.shop.z + (dz / d) * 1.5);
  await expect(page.getByText('E  Shop')).toBeVisible();
  await page.keyboard.press('KeyE');
  await page.getByTestId('buy-grapple').click();
  await expect.poll(async () => (await me()).inv.grapples ?? 0).toBe(3);
  await page.keyboard.press('Escape');
  const slot = (await me()).hotbar.indexOf('grapple');
  expect(slot).toBeGreaterThanOrEqual(0);

  // Open ground across the front of the bunker, a steel wall 16 m off; keep the crosshair on its upper half.
  const f = { x: -Math.sin(home.bunker.facingYaw), z: -Math.cos(home.bunker.facingYaw) };
  const r = { x: -f.z, z: f.x };
  const sx = home.center.x + f.x * 4 - r.x * 12, sz = home.center.z + f.z * 4 - r.z * 12;
  await dbg(page, 'teleport', sx, sz);
  const wx = sx + r.x * 16, wz = sz + r.z * 16;
  await dbg(page, 'place', 'steel', wx, wz, Math.atan2(-r.x, -r.z));
  await page.waitForTimeout(400);
  const start = (await me()).pos;
  await page.evaluate(([x, y, z]) => {
    const api = (window as unknown as { __faefight: { renderer: { camera: { position: V } }; input: { yaw: number; pitch: number } } }).__faefight;
    const loop = () => {
      const c = api.renderer.camera.position;
      const ddx = x - c.x, ddy = y - c.y, ddz = z - c.z;
      api.input.yaw = Math.atan2(-ddx, -ddz);
      api.input.pitch = Math.atan2(ddy, Math.hypot(ddx, ddz));
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, [wx, start.y + 1.6, wz]);
  await page.mouse.click(640, 360); // pointer lock
  await page.keyboard.press(`Digit${slot + 1}`);
  await expect(page.getByTestId('weapon')).toHaveText(/hook/i);
  // A click while the pointer isn't locked only re-locks it: click until the hook is out.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { __faefight: { snapshot: () => { players: Me[]; events: { type: string; data: unknown }[] }; input: { held: unknown; locked: boolean } } };
    const seen: string[] = [];
    w.__hookLog = seen;
    const loop = () => {
      const s = w.__faefight.snapshot();
      for (const e of s?.events ?? []) if (e.type === 'grapple') seen.push(`ev ${JSON.stringify(e.data)}`);
      for (const p of s?.players ?? []) if (p.hook) seen.push(`hook ${p.id} ${JSON.stringify(p.hook)}`);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  try {
    await expect(async () => {
      if (!(await me()).hook) await page.mouse.click(640, 360);
      await expect.poll(async () => (await me()).hook?.st ?? -1, { timeout: 1500, intervals: [16] }).toBe(1);
    }).toPass({ timeout: 10_000 });
  } catch (e) {
    const diag = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & { __faefight: { input: { held: unknown; locked: boolean; yaw: number; pitch: number } } };
      return { log: (w.__hookLog as string[]).slice(-20), held: w.__faefight.input.held, locked: w.__faefight.input.locked };
    });
    console.log('grapple diag', JSON.stringify(diag), JSON.stringify(await me()));
    throw e;
  }
  await page.screenshot({ path: test.info().outputPath('grapple-rope.png') });
  await expect.poll(async () => Math.hypot((await me()).pos.x - wx, (await me()).pos.z - wz), { timeout: 4000 }).toBeLessThan(3);
  expect(Math.hypot(start.x - wx, start.z - wz)).toBeGreaterThan(14);
  await expect.poll(async () => (await me()).inv.grapples ?? 0).toBe(2);
  expect(errors).toEqual([]);
});

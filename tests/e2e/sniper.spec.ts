import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

/**
 * Sniper rifle: buy it at the shop ($650), draw it, scope in (3.5x zoom + the sniper overlay), and drop a bot with a
 * scoped headshot. Screenshots: the model (hip, first person), the scope view, a bot's scope glint aimed at us.
 * SNIPER_SHOTS=<dir> also copies them there (for review).
 */
const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type V = { x: number; y: number; z: number };
type Player = { id: number; island: number; isBot: boolean; alive: boolean; equipped: string; hp: number; ads: boolean; pos: V; inv: { weapons: Record<string, { mag: number; spare: number }> } };
type Snap = { players: Player[]; events: { type: string; data: Record<string, unknown> }[] };
type Isl = { center: { x: number; z: number }; shop: { x: number; z: number }; groundY: number };

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const OUT = env.SNIPER_SHOTS;
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `test-results/sniper-${name}.png` });
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` });
};
const look = (page: Page, yaw: number, pitch: number) => page.evaluate(([y, p]) => {
  const i = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
  i.yaw = y; i.pitch = p;
}, [yaw, pitch]);

test('sniper: buy, scope, one-shot headshot; glint', async ({ page }) => {
  test.setTimeout(150_000);
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
  const map = await dbg<Isl[]>(page, 'map');
  const home = map[(await me()).island];

  // Buy it at our shop.
  await dbg(page, 'give', { cash: 1000 });
  const dx = home.center.x - home.shop.x, dz = home.center.z - home.shop.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.shop.x + (dx / d) * 1.5, home.shop.z + (dz / d) * 1.5);
  await expect(page.getByText('E  Shop')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect(page.getByTestId('buy-sniper')).toHaveAttribute('aria-label', /^Sniper rifle, \$650/);
  await page.getByTestId('buy-sniper').hover();
  await shot(page, 'shop');
  await page.getByTestId('buy-sniper').click();
  await expect.poll(async () => (await me()).inv.weapons.sniper).toEqual({ mag: 5, spare: 10 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel')).toBeHidden();

  // Draw it (first person) at the island centre.
  await dbg(page, 'teleport', home.center.x, home.center.z);
  await page.locator('canvas.game').click();
  const slot = await page.locator('[data-testid^="hotbar-slot-"][data-item="sniper"]').getAttribute('data-testid');
  await page.keyboard.press(`Digit${Number(slot!.split('-').pop()) + 1}`);
  await expect.poll(async () => (await me()).equipped).toBe('sniper');
  if ((await dbg<string>(page, 'cameraMode')) !== 'first') await page.keyboard.press('KeyV');
  await page.waitForTimeout(700);
  await shot(page, 'model-fp');

  // An enemy bot 30 m out along our view; aim at its head, scope in.
  const bot = (await snap()).players.find((p) => p.isBot && p.alive)!;
  const yaw0 = 0.7;
  const fx = -Math.sin(yaw0), fz = -Math.cos(yaw0);
  const tx = home.center.x + fx * 30, tz = home.center.z + fz * 30;
  const fov0 = await dbg<number>(page, 'cameraFov');
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await expect(page.getByTestId('scope')).toHaveClass(/on/, { timeout: 3000 });
  await expect(page.getByTestId('scope')).toHaveClass(/sniper/);
  expect(await dbg<number>(page, 'cameraFov')).toBeLessThan(fov0 / 2.5);

  let killed = false;
  for (let attempt = 0; attempt < 6 && !killed; attempt++) {
    await dbg(page, 'teleport', tx, tz, bot.id);
    await dbg(page, 'teleport', home.center.x, home.center.z);
    await page.waitForTimeout(250);
    const s = await snap();
    const b = s.players.find((p) => p.id === bot.id)!, m = s.players.find((p) => p.id === humanId)!;
    const ex = b.pos.x - m.pos.x, ez = b.pos.z - m.pos.z, ey = b.pos.y + 1.62 - (m.pos.y + 1.6);
    await look(page, Math.atan2(-ex, -ez), Math.atan2(ey, Math.hypot(ex, ez)));
    await page.waitForTimeout(500); // let the scope sway settle (standing still) and the input reach the host
    if (attempt === 0) await shot(page, 'scope');
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(400);
    killed = !(await snap()).players.find((p) => p.id === bot.id)!.alive;
    if (!killed) await page.waitForTimeout(1000); // bolt
  }
  await shot(page, 'kill');
  await page.mouse.up({ button: 'right' });
  expect(killed).toBe(true);

  // Glint: hand a bot a sniper and stand 70 m in front of it in the open; it scopes in on us (it's the only rival
  // in view), and its lens flashes toward our camera.
  const bot2 = (await snap()).players.find((p) => p.isBot && p.alive && p.id !== bot.id) ?? (await snap()).players.find((p) => p.isBot && p.alive)!;
  await dbg(page, 'give', { weapons: { sniper: { mag: 5, spare: 50 } } }, bot2.id);
  await page.keyboard.press('KeyV'); // third person: see more around us
  let glint = 0;
  for (let i = 0; i < 40 && glint === 0; i++) {
    await dbg(page, 'teleport', home.center.x, home.center.z, bot2.id);
    await dbg(page, 'teleport', home.center.x + fx * 70, home.center.z + fz * 70);
    const s = await snap();
    const b = s.players.find((p) => p.id === bot2.id)!, m = s.players.find((p) => p.id === humanId)!;
    await look(page, Math.atan2(-(b.pos.x - m.pos.x), -(b.pos.z - m.pos.z)), -0.02);
    await page.waitForTimeout(250);
    glint = await page.evaluate(() => (window as unknown as { __faefight: { renderer: { glints: { shown: number } } } }).__faefight.renderer.glints.shown);
  }
  // Zoom on it with the scope for a clear look at the glint.
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(400);
  await shot(page, 'glint');
  await page.mouse.up({ button: 'right' });
  expect(glint).toBeGreaterThan(0);
  expect(errors.filter((e) => !/favicon|404/.test(e))).toEqual([]);
});

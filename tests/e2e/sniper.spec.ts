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
  await page.waitForTimeout(300);
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

  // Glint: hand the bot a sniper; put it on its own shore and us on ours facing it (~50 m over the water): it scopes in
  // on us, and its lens flashes toward our camera. (1v1: the same bot, once it has respawned.)
  await expect.poll(async () => (await snap()).players.some((p) => p.isBot && p.alive), { timeout: 20_000 }).toBe(true);
  const bot2 = (await snap()).players.find((p) => p.isBot && p.alive)!;
  const rival = map[bot2.island];
  const ux = rival.center.x - home.center.x, uz = rival.center.z - home.center.z, ul = Math.hypot(ux, uz);
  const mx = home.center.x + (ux / ul) * 14, mz = home.center.z + (uz / ul) * 14;
  const bx = rival.center.x - (ux / ul) * 14, bz = rival.center.z - (uz / ul) * 14;
  await dbg(page, 'give', { weapons: { sniper: { mag: 5, spare: 50 } } }, bot2.id);
  await dbg(page, 'give', { weapons: { sniper: { mag: 5, spare: 10 } } });
  await dbg(page, 'shield', 100);
  const glintsShown = () => page.evaluate(() => (window as unknown as { __faefight: { renderer: { glints: { shown: number } } } }).__faefight.renderer.glints.shown);
  let glint = 0;
  await dbg(page, 'teleport', mx, mz);
  await look(page, Math.atan2(-ux, -uz), -0.01);
  for (let i = 0; i < 60 && glint === 0; i++) {
    if (i % 10 === 0) await dbg(page, 'teleport', bx, bz, bot2.id);
    await page.waitForTimeout(150);
    glint = await glintsShown();
  }
  await shot(page, 'glint-wide');
  // Through our own scope: the glint up close.
  const s2 = await snap();
  const b2 = s2.players.find((p) => p.id === bot2.id)!, m2 = s2.players.find((p) => p.id === humanId)!;
  await look(page, Math.atan2(-(b2.pos.x - m2.pos.x), -(b2.pos.z - m2.pos.z)), Math.atan2(b2.pos.y - m2.pos.y, Math.hypot(b2.pos.x - m2.pos.x, b2.pos.z - m2.pos.z)));
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(450);
  await shot(page, 'glint-scoped');
  await page.mouse.up({ button: 'right' });
  expect(glint).toBeGreaterThan(0);
  expect(errors.filter((e) => !/favicon|404/.test(e))).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type Player = { id: number; island: number; equipped: string; hp: number; inv: { weapons: Record<string, { mag: number; spare: number }> } };
type Snap = { players: Player[]; pieces: { id: number; owner: number; kind: string }[]; projectiles: { kind: string }[] };
type Isl = { center: { x: number; z: number }; shop: { x: number; z: number } };

const setPitch = (page: Page, pitch: number) => page.evaluate((p) => {
  (window as unknown as { __faefight: { input: { pitch: number } } }).__faefight.input.pitch = p;
}, pitch);
const fps = (page: Page) => page.evaluate(() => new Promise<number>((res) => {
  let n = 0; const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res((n * 1000) / (performance.now() - t0)); };
  requestAnimationFrame(f);
}));

test('rocket launcher: buy it, blow up a steel wall; ADS zooms', async ({ page }) => {
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
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];

  // Buy the launcher at our shop.
  await dbg(page, 'give', { cash: 1000 });
  await expect.poll(async () => (await me()).inv.weapons && (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!.inv).toBeTruthy();
  const dx = home.center.x - home.shop.x, dz = home.center.z - home.shop.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.shop.x + (dx / d) * 1.5, home.shop.z + (dz / d) * 1.5);
  await expect(page.getByText('E  Shop')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect(page.getByTestId('buy-rocket')).toHaveAttribute('aria-label', /^Rocket launcher, \$500/);
  await page.getByTestId('buy-rocket').click();
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-item', 'rocket');
  expect((await me()).inv.weapons.rocket).toEqual({ mag: 1, spare: 3 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel')).toBeHidden();

  // Put a steel wall up at the island centre, then back off from it.
  await dbg(page, 'give', { pieces: { steel: 1 } });
  await dbg(page, 'teleport', home.center.x, home.center.z);
  await page.locator('canvas.game').click();
  await page.keyboard.press('Digit2');
  await expect(page.getByTestId('hotbar')).toHaveAttribute('data-ghost', 'ok', { timeout: 10_000 });
  const steel = async () => (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId && p.kind === 'steel').length;
  await expect(async () => {
    if ((await steel()) === 0) await page.mouse.click(640, 360);
    await expect.poll(steel, { timeout: 1000 }).toBe(1);
  }).toPass({ timeout: 10_000 });
  // The click on the game that captured the mouse (launcher in hand) must not have fired the rocket.
  expect((await me()).inv.weapons.rocket).toEqual({ mag: 1, spare: 3 });
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyS');

  // Launcher up; aiming down sights zooms in.
  await page.keyboard.press('Digit1');
  await expect.poll(async () => (await me()).equipped).toBe('rocket');
  await setPitch(page, 0);
  const fov0 = await dbg<number>(page, 'cameraFov');
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await expect.poll(() => dbg<number>(page, 'cameraFov')).toBeLessThan(fov0 * 0.8);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/guns-rocket-ads.png' });
  await page.mouse.up({ button: 'right' });
  await expect.poll(() => dbg<number>(page, 'cameraFov')).toBeGreaterThan(fov0 - 0.5);
  const tpFps = await fps(page);

  // Fire: the rocket flies (everyone sees it in the snapshot), hits the wall and the wall is gone.
  await setPitch(page, -0.02);
  await page.mouse.down();
  await page.waitForTimeout(30);
  await page.mouse.up();
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).projectiles.length, { timeout: 2000, intervals: [16] }).toBe(1);
  await page.screenshot({ path: 'test-results/guns-rocket-flight.png' });
  await expect.poll(steel, { timeout: 3000, intervals: [16] }).toBe(0);
  await page.waitForTimeout(120);
  await page.screenshot({ path: 'test-results/guns-rocket-explosion.png' });
  expect((await me()).inv.weapons.rocket.mag).toBe(0);
  expect((await me()).hp).toBeGreaterThan(0);
  // It reloads (3 s) from the spare rockets.
  await expect.poll(async () => (await me()).inv.weapons.rocket, { timeout: 6000 }).toEqual({ mag: 1, spare: 2 });

  // Rifle in first person: sights up shows the 2x scope.
  await dbg(page, 'give', { weapons: { rifle: { mag: 25, spare: 50 } } });
  await page.keyboard.press('Digit2');
  await expect.poll(async () => (await me()).equipped).toBe('rifle');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(600);
  const fpFps = await fps(page);
  await page.mouse.down({ button: 'right' });
  await expect(page.getByTestId('scope')).toHaveClass(/on/, { timeout: 3000 });
  await page.screenshot({ path: 'test-results/guns-rifle-scope.png' });
  await page.mouse.up({ button: 'right' });
  // Hip fire a burst; reload ring shows during the reload.
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.screenshot({ path: 'test-results/guns-rifle-fire.png' });
  await page.keyboard.press('KeyR');
  await expect(page.getByTestId('reload-ring')).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/guns-rifle-reload.png' });
  await expect.poll(async () => (await me()).inv.weapons.rifle.mag, { timeout: 5000 }).toBe(26); // tactical: +1 in the chamber
  console.log(`[fps] third person ${tpFps.toFixed(1)} · first person ${fpFps.toFixed(1)}`);

  expect(errors, errors.join('\n')).toEqual([]);
});

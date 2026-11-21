import { expect, test, type Page } from '@playwright/test';

// Practice range: Practice on the main menu → alone on the range with ∞ cash and no clock; the shop is free and
// opens anywhere; shooting a lane target shows hit feedback and damage numbers; building is free; the seal check
// reads the practice bunker's doorways; Esc → Quit to menu. Screenshots land in docs/screens/practice-*.png.

type V = { x: number; y: number; z: number };
type P = { id: number; name: string; alive: boolean; pos: V; inv: { cash: number; pieces: Record<string, number>; weapons: Record<string, unknown> } };
type Snap = { players: P[]; pieces: { id: number; owner: number; kind: string }[]; suddenDeath: boolean; winner: number | null };
type Isl = { bunker: { center: V; facingYaw: number; doorways: { center: V; yaw: number }[] } };

const SHOTS = 'docs/screens';
const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);
const snap = (page: Page) => dbg<Snap>(page, 'snapshot');
/** Keep the crosshair on `t` every frame (yaw/pitch from the camera), like building.spec.ts. */
const aimAt = (page: Page, t: V | null) => page.evaluate((v) => { (window as unknown as { __aimT: V | null }).__aimT = v; }, t);

test('practice range: free shop, shoot a target with hit feedback, build for free, seal check, quit to menu', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await expect(page.getByTestId('play-practice-range')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __faefightLoading: { visible: () => boolean } }).__faefightLoading.visible()), { timeout: 15_000 }).toBe(false);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/practice-menu.png` });
  await page.getByTestId('play-practice-range').click();

  // ∞ cash, no clock.
  await expect(page.getByTestId('cash')).toHaveText('$∞', { timeout: 30_000 });
  await expect(page.locator('.hud .timer')).toHaveText('PRACTICE');
  await expect.poll(() => dbg<{ active: boolean }>(page, 'predicted').then((p) => p.active), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __faefight: { input: { enabled: boolean } } }).__faefight.input.enabled), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.elementFromPoint(640, 360)?.tagName), { timeout: 30_000 }).toBe('CANVAS');
  await page.evaluate(() => {
    const w = window as unknown as { __aimT: V | null; __faefight: { renderer: { camera: { position: V } }; input: { yaw: number; pitch: number } } };
    const loop = () => {
      const t = w.__aimT, api = w.__faefight;
      if (t) {
        const c = api.renderer.camera.position;
        const dx = t.x - c.x, dy = t.y - c.y, dz = t.z - c.z;
        api.input.yaw = Math.atan2(-dx, -dz);
        api.input.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const humanId = await dbg<number>(page, 'humanId');
  const me = async () => (await snap(page)).players.find((p) => p.id === humanId)!;
  const s0 = await snap(page);
  expect(s0.players.filter((p) => p.id !== humanId).length).toBe(11);
  await page.locator('canvas.game').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/practice-range.png` });

  // Panel: O opens the controls (no pause card), switch the shooter off, Resume.
  await page.keyboard.press('KeyO');
  await expect(page.getByTestId('practice-panel')).toHaveClass(/open/);
  await expect(page.getByTestId('pause')).toHaveCount(0);
  await page.getByTestId('practice-shooter-off').click();
  await expect(page.getByTestId('practice-shooter-off')).toHaveClass(/on/);
  await page.screenshot({ path: `${SHOTS}/practice-panel.png` });
  await page.getByTestId('practice-resume').click();
  await expect(page.getByTestId('practice-panel')).not.toHaveClass(/open/);

  // Free shop, anywhere: E opens it at the firing line; buy the rocket launcher; cash still ∞.
  await expect(page.locator('.hud .prompt')).toHaveText('E  Shop');
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect(page.getByTestId('buy-rocket').locator('.iprice')).toHaveText('Free');
  await page.getByTestId('buy-rocket').click();
  await expect.poll(async () => !!(await me()).inv.weapons.rocket).toBe(true);
  expect((await me()).inv.cash).toBeGreaterThanOrEqual(1_000_000);
  await page.screenshot({ path: `${SHOTS}/practice-shop.png` });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel')).toBeHidden();
  await page.locator('canvas.game').click();

  // Shoot the 10 m static target with the rifle (slot 1): hitmarker, damage numbers, last-hit readout.
  await page.keyboard.press('Digit1');
  const target = (await snap(page)).players.find((p) => p.name === 'Target 10m')!;
  await aimAt(page, { x: target.pos.x, y: target.pos.y + 1.2, z: target.pos.z });
  await page.waitForTimeout(500);
  let sawNumber = false, sawMarker = false;
  for (let i = 0; i < 12 && !(sawNumber && sawMarker); i++) {
    await page.mouse.down();
    await page.waitForTimeout(180);
    await page.mouse.up();
    sawNumber ||= (await page.locator('.dmg-number').count()) > 0;
    sawMarker ||= await page.getByTestId('crosshair').evaluate((n) => n.classList.contains('hit'));
    if (i === 0) await page.screenshot({ path: `${SHOTS}/practice-shoot.png` });
    await page.waitForTimeout(150);
  }
  expect(sawNumber, 'damage number over the target').toBe(true);
  expect(sawMarker, 'crosshair hitmarker').toBe(true);
  await expect(page.getByTestId('practice-last-hit')).toContainText(/Target 10m|Mover 10m/);
  await expect(page.getByTestId('practice-accuracy')).not.toHaveText('–');
  await expect(page.getByTestId('practice-dps')).not.toHaveText('–');

  // Free building: a wood wall a few metres ahead (slot 4); the stack stays full.
  const start = (await me()).pos;
  await page.keyboard.press('Digit4');
  await aimAt(page, { x: start.x, y: start.y + 0.3, z: start.z - 4 });
  await expect(page.getByTestId('hotbar')).toHaveAttribute('data-ghost', 'ok', { timeout: 10_000 });
  const mine = async () => (await snap(page)).pieces.filter((p) => p.owner === humanId).length;
  await expect(async () => {
    if ((await mine()) === 0) await page.mouse.click(640, 360);
    await expect.poll(mine, { timeout: 1500 }).toBe(1);
  }).toPass({ timeout: 10_000 });
  await expect.poll(async () => (await me()).inv.pieces.wood).toBe(99);
  await page.screenshot({ path: `${SHOTS}/practice-build.png` });

  // Seal check: plug the bunker's front doorway with metal (slot 5); the readout shows Front blocked.
  const bunker = (await dbg<Isl[]>(page, 'map'))[0].bunker;
  const door = bunker.doorways[0];
  const out = { x: door.center.x + Math.cos(door.yaw + Math.PI / 2) * 0 - Math.sin(door.yaw) * 3, z: door.center.z - Math.cos(door.yaw) * 3 };
  await dbg(page, 'teleport', out.x, out.z);
  await page.keyboard.press('Digit5');
  await aimAt(page, { x: door.center.x, y: door.center.y + 0.3, z: door.center.z });
  await expect(page.getByTestId('practice-door-0')).toHaveAttribute('data-blocked', 'false');
  await expect(async () => {
    if ((await page.getByTestId('practice-door-0').getAttribute('data-blocked')) !== 'true') await page.mouse.click(640, 360);
    await expect(page.getByTestId('practice-door-0')).toHaveAttribute('data-blocked', 'true', { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByTestId('practice-door-1')).toHaveAttribute('data-blocked', 'false');
  await page.screenshot({ path: `${SHOTS}/practice-seal.png` });

  // Clear my pieces from the panel.
  await aimAt(page, null);
  await page.keyboard.press('KeyO');
  await page.getByTestId('practice-clear').click();
  await expect.poll(mine).toBe(0);
  await page.getByTestId('practice-resume').click();

  // Never a result or sudden death.
  const s1 = await snap(page);
  expect(s1.winner).toBeNull();
  expect(s1.suddenDeath).toBe(false);

  // Esc → pause card → Quit to menu.
  await page.locator('canvas.game').click();
  await expect.poll(() => page.evaluate(() => !!document.pointerLockElement)).toBe(true);
  // Let the game see the lock first (pointerlockchange fires at the next rendering step), then release it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByTestId('pause')).toBeVisible();
  await expect(page.getByTestId('pause-quit')).toHaveText('Quit to menu');
  await page.getByTestId('pause-quit').click();
  await expect(page.getByTestId('play-practice-range')).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type Player = { id: number; island: number; equipped: string; hotbar: (string | null)[];
  inv: { weapons: Record<string, { mag: number; spare: number }>; pieces: Record<string, number> } };
type Snap = { players: Player[]; pieces: { owner: number }[] };
type Isl = { center: { x: number; z: number }; shop: { x: number; z: number } };

const locked = (page: Page) => page.evaluate(() => !!document.pointerLockElement);
/** requestPointerLock calls so far (counted by a wrapper installed below). */
const lockCalls = (page: Page) => page.evaluate(() => (window as unknown as { __lockCalls: number }).__lockCalls);

test('closing the shop with its key re-captures the mouse at once; a click while unlocked never acts', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  // Count lock requests; window.__refuseLock makes them fail like Chrome does for ~1 s after Esc.
  await page.addInitScript(() => {
    const w = window as unknown as { __lockCalls: number; __refuseLock: boolean };
    w.__lockCalls = 0; w.__refuseLock = false;
    const orig = HTMLCanvasElement.prototype.requestPointerLock;
    HTMLCanvasElement.prototype.requestPointerLock = function (this: HTMLCanvasElement, ...args: unknown[]) {
      w.__lockCalls++;
      if (w.__refuseLock) return Promise.reject(new DOMException('refused (test)', 'SecurityError'));
      return (orig as (...a: unknown[]) => Promise<void>).apply(this, args);
    } as typeof orig;
  });

  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];
  await dbg(page, 'give', { weapons: { rifle: { mag: 25, spare: 50 } }, pieces: { wood: 3 } });
  await expect.poll(async () => (await me()).hotbar.includes('rifle') && (await me()).hotbar.includes('wood')).toBe(true);

  // Stand by the shop and capture the mouse (that first click only captures).
  const dx = home.center.x - home.shop.x, dz = home.center.z - home.shop.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.shop.x + (dx / d) * 1.5, home.shop.z + (dz / d) * 1.5);
  await page.locator('canvas.game').click();
  await expect.poll(() => locked(page)).toBe(true);

  // Open: the pointer is released so the cursor can click shop items.
  await expect(page.getByText('E  Shop')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect.poll(() => locked(page)).toBe(false);

  // Close with the same key: the lock is requested in that key press, and the mouse is back without a click.
  await page.waitForTimeout(1200); // past Chrome's re-lock cooldown after leaving lock
  const before = await lockCalls(page);
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeHidden();
  expect(await lockCalls(page)).toBeGreaterThan(before);
  await expect.poll(() => locked(page)).toBe(true);

  // Lose the lock with the re-lock refused (as right after Esc): the game is unlocked with no UI open.
  await page.evaluate(() => { (window as unknown as { __refuseLock: boolean }).__refuseLock = true; });
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByTestId('pause')).toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('pause')).toBeHidden();
  expect(await locked(page)).toBe(false);
  await expect(page.locator('.click-hint')).toHaveText('Click to resume');
  await expect(page.locator('.click-hint')).toBeVisible();

  // Rifle in hand, unlocked: a click (and a held press) fires nothing; the ammo count is unchanged.
  await page.keyboard.press(`Digit${(await me()).hotbar.indexOf('rifle') + 1}`);
  await expect.poll(async () => (await me()).equipped).toBe('rifle');
  const mag = (await me()).inv.weapons.rifle.mag;
  await page.mouse.move(640, 360);
  await page.mouse.click(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await me()).inv.weapons.rifle.mag).toBe(mag);

  // Wood in hand, unlocked: a click places no piece.
  await page.keyboard.press(`Digit${(await me()).hotbar.indexOf('wood') + 1}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __faefight: { input: { held: string | null } } }).__faefight.input.held)).toBe('wood');
  const pieces = (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId).length;
  const wood = (await me()).inv.pieces.wood;
  await page.mouse.click(640, 360);
  await page.waitForTimeout(500);
  expect((await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId).length).toBe(pieces);
  expect((await me()).inv.pieces.wood).toBe(wood);

  // Let the lock through: the capturing click is swallowed; after its release a click fires normally.
  await page.keyboard.press(`Digit${(await me()).hotbar.indexOf('rifle') + 1}`); // (still refused: a key would re-lock too)
  await expect.poll(async () => (await me()).equipped).toBe('rifle');
  await page.evaluate(() => { (window as unknown as { __refuseLock: boolean }).__refuseLock = false; });
  await page.mouse.click(640, 360);
  await expect.poll(() => locked(page)).toBe(true);
  await page.waitForTimeout(400);
  expect((await me()).inv.weapons.rifle.mag).toBe(mag);
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await me()).inv.weapons.rifle.mag).toBeLessThan(mag);
  expect(errors, errors.join('\n')).toEqual([]);
});

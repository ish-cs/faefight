import { expect, test, type Page } from '@playwright/test';

type Snap = {
  players: { id: number; island: number; alive: boolean; locked: string[]; inv: { cash: number; weapons: Record<string, unknown> }; hotbar: (string | null)[] }[];
  genLevels: number[];
};
type P = { x: number; z: number };
/** SHOP_SHOT / GEN_SHOT=<path>: also save screenshots (docs/screens/shop-upgrades.png comes from SHOP_SHOT). */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
type Isl = { center: P; shop: P; generator: P };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

/** Stand 1.5 m from `at`, toward the island centre. */
const standBy = (page: Page, isl: Isl, at: P) => {
  const dx = isl.center.x - at.x, dz = isl.center.z - at.z, d = Math.hypot(dx, dz);
  return dbg(page, 'teleport', at.x + (dx / d) * 1.5, at.z + (dz / d) * 1.5);
};

test('generator upgrade shows Lv2; a locked pistol comes back after death', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });

  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = map[(await me()).island];

  await dbg(page, 'give', { cash: 2000 });
  await expect.poll(async () => (await me()).inv.cash).toBe(2050);
  await standBy(page, home, home.shop);
  await expect(page.getByText('E  Shop')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();

  // Upgrades group: generator card offers Lv2 for $150; no lock cards before owning a gun.
  await expect(page.getByRole('group', { name: 'Upgrades' })).toBeVisible();
  const gen = page.getByTestId('buy-genUpgrade');
  await expect(gen.locator('.ibadge')).toHaveText('Lv2');
  await expect(gen.locator('.iprice')).toHaveText('$150');
  await expect(page.getByTestId('buy-lock:pistol')).toBeHidden();
  await gen.click();
  await expect(page.getByTestId('cash')).toHaveText('$1900');
  await expect(gen.locator('.ibadge')).toHaveText('Lv3');
  await expect(gen.locator('.iprice')).toHaveText('$400');

  // Buy a pistol: its lock card appears ($200 = 4x), lock it.
  await page.getByTestId('buy-pistol').click();
  await expect(page.getByTestId('cash')).toHaveText('$1850');
  const lock = page.getByTestId('buy-lock:pistol');
  await expect(lock).toBeVisible();
  await expect(lock.locator('.iprice')).toHaveText('$200');
  if (env.SHOP_SHOT) { await lock.hover(); await page.waitForTimeout(300); await page.screenshot({ path: env.SHOP_SHOT }); }
  await lock.click();
  await expect(page.getByTestId('cash')).toHaveText('$1650');
  await expect(lock).toHaveAttribute('aria-disabled', 'true');
  await expect(lock.locator('.istatus')).toHaveText('Locked');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveClass(/locked/);
  expect((await me()).locked).toEqual(['pistol']);
  await page.keyboard.press('Escape');

  // HUD near our generator shows the level.
  await standBy(page, home, home.generator);
  await expect(page.locator('.hud .gen')).toContainText('Your generator');
  await expect(page.locator('.hud .gen')).toContainText('Lv2');
  if (env.GEN_SHOT) { await page.waitForTimeout(500); await page.screenshot({ path: env.GEN_SHOT }); }

  // Die: respawn with the locked pistol back in slot 1 (full mag + 1 spare).
  await dbg(page, 'kill', humanId);
  await expect.poll(async () => (await me()).alive).toBe(false);
  await expect.poll(async () => (await me()).alive, { timeout: 10_000 }).toBe(true);
  const after = await me();
  expect(after.inv.weapons.pistol).toEqual({ mag: 12, spare: 12 });
  expect(after.hotbar[0]).toBe('pistol');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-item', 'pistol');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveClass(/locked/);
  expect((await dbg<Snap>(page, 'snapshot')).genLevels[after.island]).toBe(2);

  expect(errors).toEqual([]);
});

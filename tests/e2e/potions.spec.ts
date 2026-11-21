import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

type Me = {
  id: number; island: number; pos: { x: number; y: number; z: number }; hp: number; shield: number;
  inv: { cash: number; potions: Record<string, number> }; hotbar: (string | null)[]; drinking: unknown;
};
type Snap = { players: Me[] };
type Isl = { center: { x: number; z: number }; shop: { x: number; z: number }; bunker: { facingYaw: number } };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

test('shield bar, potion seller, drinking', async ({ page }) => {
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

  // Shield bar sits right above the health bar, empty at spawn.
  const shield = page.getByTestId('shield');
  await expect(shield).toBeVisible();
  await expect(shield).toHaveClass(/empty/);
  const sb = (await shield.boundingBox())!, hb = (await page.locator('.hud .hp').boundingBox())!;
  // Same layout width (the bars are skewed, so their bounding boxes differ by the skew of their heights).
  const widths = await page.evaluate(() => [(document.querySelector('.hud .shield') as HTMLElement).offsetWidth, (document.querySelector('.hud .hp') as HTMLElement).offsetWidth]);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(1);
  expect(sb.y + sb.height).toBeLessThanOrEqual(hb.y);
  expect(hb.y - (sb.y + sb.height)).toBeLessThan(10);

  // The home shop sells no potions.
  await dbg(page, 'give', { cash: 500 });
  const dx = home.center.x - home.shop.x, dz = home.center.z - home.shop.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.shop.x + (dx / d) * 1.5, home.shop.z + (dz / d) * 1.5);
  await expect(page.getByText('E  Shop')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('buy-medkit')).toBeVisible();
  await expect(page.getByTestId('buy-shieldSmall')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A potion seller (debug-placed on our island until the centre island lands) sells them.
  const sx = home.center.x + dx / d * 4, sz = home.center.z + dz / d * 4;
  await dbg(page, 'potionShop', sx, sz);
  await dbg(page, 'teleport', sx - (dx / d) * 1.2, sz - (dz / d) * 1.2);
  await expect(page.getByText('E  Potion seller')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.locator('.panel-title')).toHaveText('Potion seller');
  await expect(page.getByTestId('buy-medkit')).toHaveCount(0);
  for (const k of ['shieldBig', 'shieldSmall', 'speedPotion']) {
    await page.getByTestId(`buy-${k}`).click();
    await expect.poll(async () => (await me()).inv.potions[k] ?? 0).toBe(1);
  }
  await expect.poll(async () => (await me()).inv.potions).toEqual({ shieldBig: 1, shieldSmall: 1, speedPotion: 1 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-item', 'shieldBig');

  // Drink the big shield: "Drinking…" for 2 s, then a half-full shield bar.
  await page.keyboard.press('Digit1');
  await expect(async () => {
    if ((await me()).inv.potions.shieldBig) await page.mouse.click(640, 360);
    await expect.poll(async () => (await me()).inv.potions.shieldBig ?? 0, { timeout: 1000 }).toBe(0);
  }).toPass({ timeout: 10_000 });
  await expect(page.getByTestId('drinking')).toBeVisible();
  await expect(page.getByTestId('drinking')).toContainText('Drinking');
  await expect.poll(async () => (await me()).shield, { timeout: 5000 }).toBe(50);
  await expect(page.getByTestId('drinking')).toBeHidden();
  await expect(shield).not.toHaveClass(/empty/);
  await expect(page.locator('.shield-text')).toHaveText('50');

  // Speed potion: the buff timer shows.
  await page.keyboard.press('Digit3');
  await expect(async () => {
    if ((await me()).inv.potions.speedPotion) await page.mouse.click(640, 360);
    await expect.poll(async () => (await me()).inv.potions.speedPotion ?? 0, { timeout: 1000 }).toBe(0);
  }).toPass({ timeout: 10_000 });
  await expect(page.getByTestId('speed-buff')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('speed-buff')).toContainText(/1[0-5]s/);

  await dbg(page, 'shield', 75);
  await expect(page.locator('.shield-text')).toHaveText('75');
  if (env.SHOT_DIR) {
    await page.locator('.hud .bl').screenshot({ path: `${env.SHOT_DIR}/hud-shield-bar.png` });
    await page.screenshot({ path: `${env.SHOT_DIR}/hud-full.png` });
    // Enemy name tag with its shield bar: stand a few metres from the bot, facing it.
    const bot = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id !== humanId)!;
    await dbg(page, 'shield', 60, bot.id);
    await dbg(page, 'teleport', bot.pos.x + 5, bot.pos.z);
    await page.evaluate(() => {
      const f = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight;
      f.input.yaw = Math.PI / 2; f.input.pitch = 0;
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${env.SHOT_DIR}/enemy-nametag.png` });
  }

  expect(errors, errors.join('\n')).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';

type Snap = {
  players: {
    id: number; island: number; pos: { x: number; y: number; z: number }; inv: { cash: number; pieces: Record<string, number> };
    hotbar: (string | null)[]; selected: number; equipped: string;
  }[];
  pieces: { id: number; owner: number; kind: string }[];
  loot: { id: number; inv: { weapons: Record<string, unknown> } }[];
};
type Isl = { center: { x: number; z: number }; shop: { x: number; z: number } };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

test('menu → match vs medium bot → shop → build', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?debug=1');
  await expect(page.getByText('FAEFight', { exact: true })).toBeVisible();
  await page.getByTestId('play-medium').click();

  // Canvas renders and HUD is live.
  await expect(page.locator('canvas.game')).toBeVisible();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);

  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const snap0 = await dbg<Snap>(page, 'snapshot');
  const me0 = snap0.players.find((p) => p.id === humanId)!;
  const home = map[me0.island];

  // The seal chip labelled "You" (chips are in island order) is the human's own island.
  const chipNames = await page.locator('.seal-chip .name').allTextContents();
  expect(chipNames.indexOf('You')).toBe(me0.island);

  // Give cash and stand next to our own shop (1.5 m toward the island centre).
  // debugGive may add or set; either way we end up with more than the starting $50.
  await dbg(page, 'give', { cash: 100 });
  const myCash = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!.inv.cash;
  await expect.poll(myCash).toBeGreaterThanOrEqual(100);
  const cash = await myCash();
  await expect(page.getByTestId('cash')).toHaveText(`$${cash}`);
  const dx = home.center.x - home.shop.x, dz = home.center.z - home.shop.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.shop.x + (dx / d) * 1.5, home.shop.z + (dz / d) * 1.5);
  await expect(page.getByText('E  Shop')).toBeVisible();

  // Open the shop, buy a pistol: it lands in hotbar slot 1 (index 0).
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();
  await page.getByTestId('buy-pistol').click();
  await expect(page.getByTestId('cash')).toHaveText(`$${cash - 50}`);
  await expect(page.getByTestId('buy-pistol')).toBeDisabled();
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-item', 'pistol');
  await expect(page.getByTestId('hotbar-slot-0')).toContainText(/pistol\s*12\/36/i);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel')).toBeHidden();

  // Number keys select slots: an empty slot is fists, the pistol's slot puts it in hand.
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  await page.keyboard.press('Digit3');
  await expect(page.getByTestId('hotbar-slot-2')).toHaveClass(/selected/);
  await expect(page.getByTestId('weapon')).toHaveText(/fists/i);
  await page.keyboard.press('Digit1');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveClass(/selected/);
  await expect(page.getByTestId('weapon')).toHaveText(/pistol\s*12\/36/i);
  await expect.poll(async () => (await me()).equipped).toBe('pistol');

  // Tab releases the mouse; drag the pistol from slot 1 to slot 5 to reorder.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('hotbar')).toHaveClass(/editing/);
  await page.getByTestId('hotbar-slot-0').dragTo(page.getByTestId('hotbar-slot-4'));
  await expect.poll(async () => (await me()).hotbar.slice(0, 5)).toEqual([null, null, null, null, 'pistol']);
  await expect(page.getByTestId('hotbar-slot-4')).toHaveAttribute('data-item', 'pistol');
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-item', '');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('hotbar')).not.toHaveClass(/editing/);

  // Build: sandbags go into the first free slot; selecting it is build mode. Place one at the island centre.
  await dbg(page, 'give', { pieces: { sandbags: 2 } });
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-item', 'sandbags');
  await dbg(page, 'teleport', home.center.x, home.center.z);
  const before = (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId).length;
  await page.keyboard.press('Digit1');
  await expect(page.getByTestId('hotbar')).toHaveAttribute('data-ghost', 'ok');
  // Right after a teleport the ghost can still shift as the player settles (a click on a pending ghost is
  // ignored), so click again only if nothing was placed.
  const placed = async () => (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId && p.kind === 'sandbags').length;
  await expect(async () => {
    if ((await placed()) === before) await page.mouse.click(640, 360);
    await expect.poll(placed, { timeout: 1000 }).toBe(before + 1);
  }).toPass({ timeout: 10_000 });
  await expect(page.locator('[data-testid="hotbar-slot-0"] .hb-count')).toHaveText('1');

  // Q drops the selected item: select the pistol (slot 5), drop it, a bag with it appears and the slot empties.
  await page.keyboard.press('Digit5');
  await expect(page.getByTestId('weapon')).toHaveText(/pistol/i);
  await page.keyboard.press('KeyQ');
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).loot.some((b) => 'pistol' in b.inv.weapons)).toBe(true);
  await expect(page.getByTestId('hotbar-slot-4')).toHaveAttribute('data-item', '');
  await expect(page.getByTestId('weapon')).toHaveText(/fists/i);
  expect((await me()).inv).not.toHaveProperty('weapons.pistol');

  expect(errors, errors.join('\n')).toEqual([]);
});

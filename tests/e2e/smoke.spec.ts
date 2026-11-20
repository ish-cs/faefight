import { expect, test, type Page } from '@playwright/test';

type Snap = {
  players: { id: number; island: number; pos: { x: number; y: number; z: number }; inv: { cash: number; pieces: Record<string, number> } }[];
  pieces: { id: number; owner: number; kind: string }[];
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

  // Open the shop, buy a pistol, equip it.
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('panel')).toBeVisible();
  await page.getByTestId('buy-pistol').click();
  await expect(page.getByTestId('cash')).toHaveText(`$${cash - 50}`);
  await expect(page.getByTestId('buy-pistol')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel')).toBeHidden();
  await page.keyboard.press('Digit2');
  await expect(page.getByTestId('weapon')).toHaveText(/pistol\s*12\/36/i);

  // Build mode: place sandbags in open ground at the island centre.
  await dbg(page, 'give', { pieces: { sandbags: 2 } });
  await dbg(page, 'teleport', home.center.x, home.center.z);
  const before = (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId).length;
  await page.keyboard.press('KeyB');
  await page.keyboard.press('Digit1');
  await expect(page.getByTestId('pieces')).toHaveAttribute('data-ghost', 'ok');
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).pieces.filter((p) => p.owner === humanId && p.kind === 'sandbags').length)
    .toBe(before + 1);
  await expect(page.locator('[data-kind="sandbags"] .count')).toHaveText('1');

  expect(errors, errors.join('\n')).toEqual([]);
});

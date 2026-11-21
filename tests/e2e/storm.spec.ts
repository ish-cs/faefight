import { expect, test, type Page } from '@playwright/test';

type P = { id: number; island: number; pos: { x: number; z: number }; hp: number; alive: boolean };
type Snap = { suddenDeath: boolean; waterY: number; storm: { x: number; z: number; r: number; strikes: unknown[] } | null; players: P[] };
type Isl = { center: { x: number; z: number } };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

test('sudden death: STORM warning, ring banner, vignette outside the ring, telegraphed lightning', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?debug=1&bots=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const snap = () => dbg<Snap>(page, 'snapshot');
  const me = async () => (await snap()).players.find((p) => p.id === humanId)!;
  const home = map[(await me()).island];
  const L = Math.hypot(home.center.x, home.center.z), ux = home.center.x / L, uz = home.center.z / L;

  await expect(page.getByTestId('storm-warn')).toBeHidden();
  await dbg(page, 'time', 899.5);
  await expect(page.getByTestId('storm-warn')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.hud .banner')).toContainText('Storm closing');
  const s0 = await snap();
  expect(s0.suddenDeath).toBe(true);
  expect(s0.storm).toBeTruthy();
  expect(s0.waterY).toBe(0);

  // Ring through the middle of the islands; step outside it.
  await dbg(page, 'time', 1000);
  await dbg(page, 'teleport', ux * (L + 10), uz * (L + 10));
  await expect(page.locator('.hud .banner')).toContainText('IN THE STORM', { timeout: 5000 });
  await expect(page.getByTestId('storm-vignette')).toHaveClass(/on/);
  await expect.poll(async () => (await me()).hp, { timeout: 5000 }).toBeLessThan(100);

  // Back inside: vignette off. A called strike shows up in the snapshot before it lands.
  await dbg(page, 'hp', 100);
  await dbg(page, 'teleport', ux * (L - 12), uz * (L - 12));
  await expect(page.getByTestId('storm-vignette')).not.toHaveClass(/on/, { timeout: 5000 });
  await dbg(page, 'strike', ux * (L - 4), uz * (L - 4));
  await expect.poll(async () => (await snap()).storm!.strikes.length, { timeout: 2000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
});

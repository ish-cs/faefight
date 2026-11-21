import { expect, test, type Page } from '@playwright/test';

// A dropped rifle lies on the ground as a rifle model with a "Rifle · mag/spare" label.
const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;

type LootInfo = { id: number; lines: string[]; labelShown: boolean; models: number }[];

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

test('a dropped rifle shows its model, glow and a name + ammo label nearby', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
  await dbg(page, 'give', { weapons: { rifle: { mag: 5, spare: 15 } } });
  await expect(page.getByTestId('hotbar-slot-0')).toHaveAttribute('data-item', 'rifle');
  // Out in the open on the home island.
  const humanId = await dbg<number>(page, 'humanId');
  const island = (await dbg<{ players: { id: number; island: number }[] }>(page, 'snapshot')).players.find((p) => p.id === humanId)!.island;
  const home = (await dbg<{ center: { x: number; z: number } }[]>(page, 'map'))[island];
  await dbg(page, 'teleport', home.center.x, home.center.z);
  await page.waitForTimeout(500);
  await page.locator('canvas.game').focus();
  await page.keyboard.press('Digit1');
  await page.keyboard.press('KeyQ');
  // Step back so we don't walk over it and pick it up again.
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(350);
  await page.keyboard.up('KeyS');
  await expect.poll(async () => (await dbg<LootInfo>(page, 'loot')).find((b) => b.lines[0]?.startsWith('Rifle')), { timeout: 10_000 })
    .toMatchObject({ lines: ['Rifle · 5/15'], labelShown: true, models: 1 });
  // Look down at it.
  await page.evaluate(() => { (window as unknown as { __faefight: { input: { pitch: number } } }).__faefight.input.pitch = -0.35; });
  await page.waitForTimeout(2500); // loading overlay fades; the bag spins a little
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/loot-rifle.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

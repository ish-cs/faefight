import { expect, test, type Page } from '@playwright/test';

type XZ = { x: number; z: number };
type Def = { template: string; name: string; islands: unknown[]; center: { center: XZ; goldGen: XZ }; cosmetics: { id: number }[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

test.describe.configure({ mode: 'serial' });

test('host picks Container Yard in the lobby; the joiner sees it, and both play it', async ({ context }) => {
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [tag, p] of [['A', a], ['B', b]] as const) {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
  }
  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;
  await b.goto('/?net=local&debug=1');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code);
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');

  // A segmented control, not a dropdown: the chosen tile is highlighted.
  await expect(a.locator('select')).toHaveCount(0);
  await expect(a.getByTestId('lobby-map-harbor')).toHaveAttribute('aria-checked', 'true');
  await a.getByTestId('lobby-map-yard').click();
  await expect(a.getByTestId('lobby-map-yard')).toHaveClass(/selected/);
  await expect(a.getByTestId('lobby-map-harbor')).not.toHaveClass(/selected/);
  await expect(b.getByTestId('lobby-map-name')).toHaveText('Container Yard');
  await a.getByTestId('lobby-map-random').click();
  await expect(b.getByTestId('lobby-map-name')).toHaveText('Random');
  await a.getByTestId('lobby-map-yard').click();
  await expect(b.getByTestId('lobby-map-name')).toHaveText('Container Yard');
  await a.getByTestId('start-match').click();

  for (const p of [a, b]) {
    await expect.poll(async () => (await dbg<Def | null>(p, 'mapDef'))?.template ?? null, { timeout: 30_000 }).toBe('yard');
  }
  const def = (await dbg<Def>(b, 'mapDef'))!;
  expect(def.name).toBe('Container Yard');
  expect(def.islands).toHaveLength(2);
  expect(def.cosmetics.length).toBeGreaterThan(10);
  expect(errors.filter((e) => !/WebGPU|GPU|favicon/i.test(e))).toEqual([]);
});

test('vs bot: the menu map choice is played and remembered', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?debug=1');
  await expect(page.locator('select')).toHaveCount(0);
  await page.getByTestId('menu-map-yard').click();
  await page.getByTestId('play-easy').click();
  await expect.poll(async () => (await dbg<Def | null>(page, 'mapDef'))?.template ?? null, { timeout: 30_000 }).toBe('yard');
  // Walk to the center island's gold generator via debug teleport and collect.
  const def = (await dbg<Def>(page, 'mapDef'))!;
  const { center: c, goldGen: g } = def.center;
  await dbg(page, 'teleport', c.x + (g.x - c.x) * 0.75, c.z + (g.z - c.z) * 0.75);
  await page.waitForTimeout(3000);
  await page.locator('canvas.game').focus();
  await page.keyboard.press('KeyE');
  await expect.poll(async () => (await dbg<{ players: { id: number; inv: { cash: number } }[] }>(page, 'snapshot'))!.players[0].inv.cash, { timeout: 10_000 })
    .toBeGreaterThan(50);
  await page.reload();
  await expect(page.getByTestId('menu-map-yard')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('menu-map')).toHaveAttribute('data-value', 'yard');
  expect(errors).toEqual([]);
});

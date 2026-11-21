import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

// Spectating shows everything the watched player sees: their low-HP vignette and sealed banner, a killcam
// when they die, "your island" in a bot's reasons about you; online, a human's camera mode, build ghost and
// open shop (read-only, with the item they hover).
test.skip(ON_CI, NEEDS_GPU);
test.describe.configure({ mode: 'serial' });

const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;
type P = { id: number; name: string; isBot: boolean; alive: boolean; hotbar: (string | null)[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);
const players = async (page: Page) => (await dbg<{ players: P[] }>(page, 'snapshot')).players;
const spec = (page: Page) => dbg<{ followId: number | null; firstPerson: boolean; killcam: boolean }>(page, 'spectator');

/** Follow player `id` (digit = its place among the living, minus `self`), retrying until it sticks. */
async function follow(page: Page, id: number, self: number) {
  await expect.poll(async () => {
    const f = (await spec(page)).followId;
    if (f === id) return f;
    const order = (await players(page)).filter((p) => p.alive && p.id !== self).map((p) => p.id).sort((a, b) => a - b);
    await page.locator('canvas.game').focus();
    await page.keyboard.press(`Digit${order.indexOf(id) + 1}`);
    return f;
  }, { timeout: 15_000 }).toBe(id);
}

test('vs bot: low-HP vignette and sealed banner of the watched player, "your island", killcam', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
  await page.locator('canvas.game').focus();
  const me = await dbg<number>(page, 'humanId');
  const bot = (await players(page)).find((p) => p.isBot)!;

  // Hurt and seal our own seat, then hand it to a bot and watch it: its HUD is our old view.
  await dbg(page, 'hp', 20);
  for (const door of [0, 1, 2]) await dbg(page, 'plugDoor', door, bot.id);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/spectate');
  await page.keyboard.press('Enter');
  await expect.poll(() => dbg<number>(page, 'humanId'), { timeout: 15_000 }).toBe(0);
  await follow(page, me, 0);
  await expect(page.getByTestId('lowhp-vignette')).toHaveClass(/\bon\b/, { timeout: 10_000 });
  await expect(page.locator('.sealed-banner')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brain-spectate-lowhp-sealed.png` });

  // The bot's reasons about us say "your", not "You's".
  await follow(page, bot.id, 0);
  await page.keyboard.press('KeyB');
  await expect(page.getByTestId('brain-inspector')).toContainText(/your island|you\b/i, { timeout: 20_000 });
  await expect(page.getByTestId('brain-inspector')).not.toContainText("You's");

  // It dies: the camera holds on it, facing its killer, for a few seconds (killcam), then moves on.
  await dbg(page, 'kill', bot.id);
  await expect.poll(async () => (await spec(page)).killcam, { timeout: 5_000 }).toBe(true);
  await expect(page.getByTestId('spectate-banner')).toContainText('KILLCAM');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brain-killcam.png` });
  await expect.poll(async () => (await spec(page)).killcam, { timeout: 8_000 }).toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('online: a dead guest watching the host sees their camera mode, build ghost and open shop', async ({ context }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [tag, p] of [['A', a], ['B', b]] as const) {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
    await p.setViewportSize({ width: 1280, height: 720 });
  }
  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;
  await b.goto('/?net=local&debug=1');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code.toLowerCase());
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await a.getByTestId('add-seat').click();
  await a.getByTestId('seat-slider-2').locator('.stop-easy').click();
  await a.getByTestId('start-match').click();
  await expect.poll(async () => (await dbg<{ players: P[] } | null>(b, 'snapshot'))?.players.length ?? 0, { timeout: 40_000 }).toBe(3);
  const aId = await dbg<number>(a, 'humanId'), bId = await dbg<number>(b, 'humanId');

  // Bob is out; he follows Alice.
  await dbg(a, 'eliminate', bId);
  await b.bringToFront();
  await expect.poll(async () => (await players(b)).find((p) => p.id === bId)?.alive, { timeout: 15_000 }).toBe(false);
  await b.getByTestId('spectate').click(); // the "eliminated" card: watch on
  await follow(b, aId, bId);

  // Alice switches to first person: Bob's camera follows.
  const fp0 = (await spec(b)).firstPerson;
  await a.bringToFront();
  await a.locator('canvas.game').focus();
  await a.keyboard.press('KeyV');
  await expect.poll(async () => (await spec(b)).firstPerson, { timeout: 10_000 }).toBe(!fp0);

  // Alice holds a wall: Bob sees her build ghost.
  await dbg(a, 'give', { pieces: { wood: 3 } });
  await expect.poll(async () => (await players(a)).find((p) => p.id === aId)!.hotbar.indexOf('wood'), { timeout: 10_000 }).toBeGreaterThanOrEqual(0);
  const slot = (await players(a)).find((p) => p.id === aId)!.hotbar.indexOf('wood');
  await a.locator('canvas.game').focus();
  await a.keyboard.press(`Digit${slot + 1}`);
  await expect.poll(() => dbg(a, 'ghost'), { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => dbg(b, 'ghost'), { timeout: 10_000 }).not.toBeNull();
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/brain-mirror-ghost.png` });
  await a.keyboard.press('Digit1');

  // Alice opens the shop and points at the rifle: Bob sees the same shop, read-only, rifle highlighted.
  await dbg(a, 'openShop');
  await a.getByTestId('buy-rifle').hover();
  const mirror = b.getByTestId('panel-mirror');
  await expect(mirror).toBeVisible({ timeout: 10_000 });
  await expect(mirror.locator('.shop-item.hover[data-item="rifle"]')).toHaveCount(1, { timeout: 10_000 });
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/brain-mirror-shop.png` });
  // Read-only: Bob can't buy through it.
  await expect(mirror).toHaveCSS('pointer-events', 'none');
  expect(errors, errors.join('\n')).toEqual([]);
});

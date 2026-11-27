import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

// The vault panel: drag and drop between hotbar and vault, stack splits (Shift half, Alt one, exact amount,
// scroll), Shift-click quick-move, cash buttons, the restock loadout editor, and hold E to quick-bank.
// VAULT_SHOT=<path>: also save a screenshot of the open panel.

type Inv = { cash: number; pieces: Record<string, number>; medkits: number };
type Me = { id: number; island: number; inv: Inv; vault: Inv; hotbar: (string | null)[]; loadout?: { items: Record<string, number>; keep: number; buy: boolean } };
type P = { x: number; z: number };
type Isl = { center: P; vault: P };
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

async function drag(page: Page, from: string, to: string, mod?: 'Shift' | 'Alt') {
  const a = (await page.getByTestId(from).boundingBox())!, b = (await page.getByTestId(to).boundingBox())!;
  if (mod) await page.keyboard.down(mod);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 10, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 30, { steps: 8 });
  await page.mouse.up();
  if (mod) await page.keyboard.up(mod);
}

test('vault panel: drag, split, quick-move, cash, loadout, hold E to quick-bank', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });

  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const me = async () => (await dbg<{ players: Me[] }>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = map[(await me()).island];
  await dbg(page, 'give', { cash: 500, pieces: { wood: 25 }, medkits: 3 });
  await expect.poll(async () => (await me()).inv.pieces.wood).toBe(25);
  // Carrying a lot: the HUD warns it drops on death.
  await expect(page.getByTestId('bank-note')).toContainText('drops if you die');

  const dx = home.center.x - home.vault.x, dz = home.center.z - home.vault.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.vault.x + (dx / d) * 1.2, home.vault.z + (dz / d) * 1.2);
  await expect(page.getByText('E  Vault')).toBeVisible();
  await page.locator('canvas.game').focus();
  await page.keyboard.press('KeyE'); // a tap opens the panel
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect(page.getByTestId('vault-death-hint')).toBeVisible();

  const slotOf = async (k: string) => `vault-hot-${(await me()).hotbar.indexOf(k)}`;
  const wood = async () => { const m = await me(); return [m.inv.pieces.wood ?? 0, m.vault.pieces.wood ?? 0]; };

  // Shift-drag: half the stack (13 of 25, rounded up) into the vault.
  await drag(page, await slotOf('wood'), 'vault-grid-stored', 'Shift');
  await expect.poll(wood).toEqual([12, 13]);
  // Alt-drag (Ctrl on Windows/Linux): one back out onto the hotbar.
  await drag(page, 'vault-store-wood', 'vault-grid-carried', 'Alt');
  await expect.poll(wood).toEqual([13, 12]);
  // Exact amount: 10 of the 13 in.
  await page.getByTestId('vault-move-amount').fill('10');
  await drag(page, await slotOf('wood'), 'vault-grid-stored');
  await expect.poll(wood).toEqual([3, 22]);
  await page.getByTestId('vault-move-amount').fill('');
  // Shift-click quick-moves a whole stack: all 3 medkits in.
  await page.getByTestId(await slotOf('medkit')).click({ modifiers: ['Shift'] });
  await expect.poll(async () => { const m = await me(); return [m.inv.medkits, m.vault.medkits]; }).toEqual([0, 3]);
  // Scroll over a stack sets an exact amount (3 notches up = 3), then a click takes that many.
  await page.getByTestId('vault-store-wood').hover();
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -60); await page.waitForTimeout(50); }
  await expect(page.getByTestId('vault-move-amount')).toHaveValue('3');
  await page.getByTestId('vault-store-wood').click();
  await expect.poll(wood).toEqual([6, 19]);
  await page.getByTestId('vault-move-amount').fill('');

  // One click banks all carried cash.
  await page.getByTestId('vault-deposit-all').click();
  // (≥: banked cash earns interest every 10 s.)
  await expect.poll(async () => { const m = await me(); return m.inv.cash === 0 && m.vault.cash >= 550; }).toBe(true);
  // "Keep $80 on me" takes 80 back out.
  await page.getByTestId('vault-keep-input').fill('80');
  await page.getByTestId('vault-keep').click();
  await expect.poll(async () => (await me()).inv.cash).toBe(80);

  // Restock loadout: 5 wood (Shift-click +5), 2 medkits, keep $40, buy what's missing.
  await page.getByTestId('loadout-plus-wood').click({ modifiers: ['Shift'] });
  await page.getByTestId('loadout-plus-medkit').click();
  await page.getByTestId('loadout-plus-medkit').click();
  await page.getByTestId('loadout-keep').fill('40');
  await page.getByTestId('loadout-keep').press('Enter');
  await page.getByTestId('loadout-buy').check();
  await expect(page.getByTestId('loadout-n-wood')).toHaveText('5');
  await expect.poll(async () => (await me()).loadout).toEqual({ items: { wood: 5, medkit: 2 }, keep: 40, buy: true });
  if (env.VAULT_SHOT) await page.screenshot({ path: env.VAULT_SHOT });

  // Hold E at the vault: everything above the loadout goes in (1 wood over 5, $40 over the $40 keep).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('panel')).toBeHidden();
  await page.locator('canvas.game').focus();
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyE');
  await expect.poll(wood).toEqual([5, 20]);
  await expect.poll(async () => (await me()).inv.cash).toBe(40);
  await expect(page.getByTestId('panel')).toBeHidden(); // a hold banks, it doesn't open the panel
  expect(errors, errors.join('\n')).toEqual([]);
});

// Bug: closing the panel mid-drag left the drag ghost (an item icon "×n") stuck on screen, and the stale drag froze
// the grids on the next open.
test('vault panel: closing mid-drag leaves no drag ghost behind', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const me = async () => (await dbg<{ players: Me[] }>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = map[(await me()).island];
  await dbg(page, 'give', { pieces: { wood: 25 } });
  await expect.poll(async () => (await me()).inv.pieces.wood).toBe(25);
  const dx = home.center.x - home.vault.x, dz = home.center.z - home.vault.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.vault.x + (dx / d) * 1.2, home.vault.z + (dz / d) * 1.2);
  await expect(page.getByText('E  Vault')).toBeVisible();
  const ghost = page.locator('.vghost');
  const panel = page.locator('.panel.open'); // (closePanel drops the 'panel' test id)

  for (const close of ['Escape', 'KeyE'] as const) {
    await page.locator('canvas.game').focus();
    await page.keyboard.press('KeyE');
    await expect(panel).toBeVisible();
    const cell = `vault-hot-${(await me()).hotbar.indexOf('wood')}`;
    const a = (await page.getByTestId(cell).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 40, a.y + a.height / 2 - 30, { steps: 5 });
    await expect(ghost).toHaveCount(1);
    await page.keyboard.press(close); // panel closes while the button is still held
    await expect(panel).toBeHidden();
    await expect(ghost).toHaveCount(0);
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
  }
  // The next open still draws the grids (a stuck drag used to block every refresh).
  await page.locator('canvas.game').focus();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId(`vault-hot-${(await me()).hotbar.indexOf('wood')}`)).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('vault level: upgrade at the vault, then quick-bank (H) from anywhere on your island', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  const humanId = await dbg<number>(page, 'humanId');
  const map = await dbg<Isl[]>(page, 'map');
  const me = async () => (await dbg<{ players: (Me & { vaultLevel?: number })[] }>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = map[(await me()).island];
  await dbg(page, 'give', { cash: 1000 });
  await expect.poll(async () => (await me()).inv.cash).toBe(1050);

  // H away from the vault at Lv1: refused (a feed line says why), nothing banked.
  await dbg(page, 'teleport', home.center.x, home.center.z);
  await page.locator('canvas.game').focus();
  await page.keyboard.press('KeyH');
  await page.waitForTimeout(400);
  expect((await me()).vault.cash).toBe(0);

  const dx = home.center.x - home.vault.x, dz = home.center.z - home.vault.z, d = Math.hypot(dx, dz);
  await dbg(page, 'teleport', home.vault.x + (dx / d) * 1.2, home.vault.z + (dz / d) * 1.2);
  await expect(page.getByText('E  Vault')).toBeVisible();
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('vault-level')).toContainText('Vault Lv1');
  await expect(page.getByTestId('vault-upgrade')).toHaveText(/Upgrade → Lv2 · \$250/);
  await page.getByTestId('vault-upgrade').click();
  await expect.poll(async () => (await me()).vaultLevel).toBe(2);
  await expect(page.getByTestId('vault-level')).toContainText('Vault Lv2');
  await expect(page.getByTestId('vault-loadout')).toContainText('/6 kinds');
  if (env.VAULT_SHOT2) await page.screenshot({ path: env.VAULT_SHOT2 });
  await page.keyboard.press('Escape');

  // Lv2: H banks from the middle of the island.
  await dbg(page, 'teleport', home.center.x, home.center.z);
  await page.locator('canvas.game').focus();
  await page.keyboard.press('KeyH');
  await expect.poll(async () => { const m = await me(); return m.inv.cash === 0 && m.vault.cash >= 800; }).toBe(true);
  await expect(page.getByTestId('home-panel')).toContainText('Lv2');
  expect(errors, errors.join('\n')).toEqual([]);
});

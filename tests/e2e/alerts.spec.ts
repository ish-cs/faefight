import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type P = { id: number; alive: boolean; island: number; doorsBlocked?: number };
type Piece = { id: number; owner: number };
type Snap = { players: P[]; pieces: Piece[]; sealed: boolean[] };
type Isl = { center: { x: number; z: number }; bunker: { center: { x: number; z: number } } };

const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;
const snapOf = (p: Page) => dbg<Snap>(p, 'snapshot');

test('enemy walls on your doorways: warning with count, pulsing compass home, sealed banner, reopened; generator toast', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() =>
    !(window as unknown as { __faefightLoading?: { visible(): boolean } }).__faefightLoading?.visible()), { timeout: 60_000 }).toBe(true);
  const me = await dbg<number>(page, 'humanId');
  const s0 = await snapOf(page);
  const bot = s0.players.find((p) => p.id !== me)!.id;
  const home = (await dbg<Isl[]>(page, 'map'))[s0.players.find((p) => p.id === me)!.island];

  // Out in the open on my island (not in the bunker), looking away from it.
  await dbg(page, 'teleport', home.center.x, home.center.z);
  const panel = page.getByTestId('home-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Vault $');
  await expect(panel).toContainText('Lv1');

  const warn = page.getByTestId('doors-warning');
  await expect(warn).toBeHidden();
  await dbg(page, 'plugDoor', 0, bot);
  await expect(warn).toHaveText(/Your bunker: 1\/3 doorways blocked/);
  await expect(page.getByTestId('compass').locator('.qc-marker.home')).toHaveClass(/threat/);
  await dbg(page, 'plugDoor', 1, bot);
  await expect(warn).toHaveText(/Your bunker: 2\/3 doorways blocked/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alerts-doors.png` });

  // All three: the seal (announcement + persistent banner while I'm alive outside); the 2/3 line gives way.
  await dbg(page, 'plugDoor', 2, bot);
  const banner = page.locator('.sealed-banner');
  await expect(banner).toHaveText('Your bunker is SEALED: clear a doorway before you die');
  await expect(warn).toBeHidden();
  if (SHOTS) await page.waitForTimeout(4000); // screenshot: let the seal headline fade first
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alerts-sealed.png` });

  // Clear one doorway: "Bunker reopened" in green, back to 2/3.
  const plugs = (await snapOf(page)).pieces.filter((p) => p.owner === bot);
  await dbg(page, 'removePiece', plugs[0].id);
  await expect(page.getByTestId('bunker-reopened')).toBeVisible();
  await expect(banner).toBeHidden();
  await expect(warn).toHaveText(/2\/3/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alerts-reopened.png` });

  // Generator about to fill: a small toast once it does.
  await dbg(page, 'genStored', 498);
  const toast = page.getByTestId('gen-toast');
  await expect(toast).toHaveText(/Generator full: \$500 waiting/, { timeout: 5000 });
  await expect(panel).toHaveClass(/full/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alerts-generator.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

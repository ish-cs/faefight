import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // starts a match

type Snap = { players: { id: number; island: number; inv: { cash: number } }[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

const SHOTS = 'docs/screens';

test.describe.configure({ mode: 'serial' });

test('game settings, ready-up and colours: host sets starting cash, guest sees it, match starts with it', async ({ context }) => {
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [tag, p] of [['A', a], ['B', b]] as const) {
    await p.setViewportSize({ width: 1280, height: 1100 });
    p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
  }

  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;
  await expect(a.getByTestId('map-thumb').locator('img')).toHaveAttribute('src', /maps\/harbor\.jpg$/);
  await expect.poll(() => a.getByTestId('map-thumb').locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await b.goto('/?net=local&debug=1');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code);
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');

  // Not ready yet: the host can still start, but is told.
  await expect(a.getByTestId('seat-ready-1')).toHaveText('not ready');
  await expect(a.getByTestId('start-match')).toHaveText('Start anyway (1 not ready)');

  // Guest settings are read-only and show the defaults.
  await expect(b.getByTestId('lobby-settings-startCash')).toBeDisabled();
  await expect(b.getByTestId('lobby-settings-startCash-value')).toHaveText('$50');

  // Host: starting cash $300, 10 min, 1.5× generators.
  await a.getByTestId('lobby-settings-startCash').fill('300');
  await a.getByTestId('lobby-settings-suddenDeathSec').fill('600');
  await a.getByTestId('lobby-settings-genMult').fill('1.5');
  await expect(b.getByTestId('lobby-settings-startCash-value')).toHaveText('$300');
  await expect(b.getByTestId('lobby-settings-suddenDeathSec-value')).toHaveText('10 min');
  await expect(b.getByTestId('lobby-settings-genMult-value')).toHaveText('1.5×');

  // Colours: Bob takes Purple (4); it greys out for Alice. Alice picks Teal (5).
  await b.getByTestId('swatch-4').click();
  await expect(a.getByTestId('swatch-4')).toBeDisabled();
  await expect(a.getByTestId('seat-color-1')).toHaveAttribute('data-color', '4');
  await a.getByTestId('swatch-5').click();
  await expect(b.getByTestId('swatch-5')).toBeDisabled();
  await expect(b.getByTestId('seat-color-0')).toHaveAttribute('data-color', '5');

  // Mute is local: Alice mutes Bob, Bob's chat no longer shows for her.
  await a.getByTestId('mute-1').click();
  await expect(a.getByTestId('mute-1')).toHaveText('Muted');
  await b.getByTestId('lobby-chat-input').fill('hello from bob');
  await b.getByTestId('lobby-chat-input').press('Enter');
  await expect(b.getByTestId('lobby-feed')).toContainText('hello from bob');
  await a.waitForTimeout(300);
  await expect(a.getByTestId('lobby-feed')).not.toContainText('hello from bob');

  await a.screenshot({ path: `${SHOTS}/lobby2-host-not-ready.png` });
  await b.getByTestId('ready-toggle').click();
  await expect(b.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(a.getByTestId('seat-ready-1')).toHaveText('ready');
  await expect(a.getByTestId('start-match')).toHaveText('Start match');
  await a.screenshot({ path: `${SHOTS}/lobby2-host.png` });
  await b.screenshot({ path: `${SHOTS}/lobby2-guest.png` });

  await a.getByTestId('start-match').click();
  const snap = (p: Page) => dbg<Snap | null>(p, 'snapshot');
  await expect.poll(async () => (await snap(a))?.players.length ?? 0, { timeout: 45_000 }).toBe(2);
  await expect.poll(async () => (await snap(b))?.players.length ?? 0, { timeout: 45_000 }).toBe(2);
  // Everyone starts with the host's $300 (nobody can have spent or collected in the first instant).
  for (const p of (await snap(a))!.players) expect(p.inv.cash).toBe(300);
  const bId = await dbg<number>(b, 'humanId');
  expect((await snap(b))!.players.find((p) => p.id === bId)!.inv.cash).toBe(300);
  // The match carries the settings and colours to the guest.
  const def = await dbg<{ settings: unknown; colors: number[] }>(b, 'mapDef');
  expect(def.settings).toEqual({ startCash: 300, suddenDeathSec: 600, genMult: 1.5, teamMode: 0 });
  expect(def.colors).toEqual([5, 4]);
  expect(errors).toEqual([]);
});

test('vs bots: the menu game settings panel sets starting cash', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.getByTestId('menu-settings-toggle').click();
  await page.getByTestId('menu-settings-startCash').fill('500');
  await expect(page.getByTestId('menu-settings-startCash-value')).toHaveText('$500');
  await page.screenshot({ path: `${SHOTS}/lobby2-menu-settings.png` });
  await page.getByTestId('play-easy').click();
  await expect.poll(async () => (await dbg<Snap | null>(page, 'snapshot'))?.players.length ?? 0, { timeout: 45_000 }).toBe(2);
  for (const p of (await dbg<Snap>(page, 'snapshot')).players) expect(p.inv.cash).toBe(500);
  // Remembered for next time.
  await page.goto('/?debug=1');
  await page.getByTestId('menu-settings-toggle').click();
  await expect(page.getByTestId('menu-settings-startCash-value')).toHaveText('$500');
});

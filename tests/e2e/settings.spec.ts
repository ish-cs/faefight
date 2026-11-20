import { expect, test, type Page } from '@playwright/test';

type LoadEvent = { kind: 'show' | 'progress' | 'hide'; phase?: string; frac?: number; total: number; t: number };
type Snap = { players: { id: number; island: number; alive: boolean; pos: { x: number; y: number; z: number } }[] };
type Isl = { center: { x: number; z: number } };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);
const loadEvents = (page: Page) => page.evaluate(() =>
  (window as unknown as { __faefightLoading: { events: () => LoadEvent[] } }).__faefightLoading.events());
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('faefight.settings.v1') ?? 'null'));

test('loading screens, settings (sensitivity + rebind jump) apply in a vs-bot match', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });

  // ---- boot: branded loading screen, then the menu ----
  await page.goto('/?debug=1');
  await expect(page.getByTestId('play-medium')).toBeVisible();
  await expect(page.getByTestId('loading')).toHaveCount(0); // faded out and detached
  const boot = await loadEvents(page);
  expect(boot[0].kind).toBe('show');
  expect(boot.at(-1)!.kind).toBe('hide');

  // ---- settings from the main menu ----
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('set-sensitivity').fill('2.2');
  await page.getByTestId('bind-jump').click();
  await expect(page.getByTestId('bind-jump')).toHaveText('Press a key…');
  await page.keyboard.press('KeyJ');
  await expect(page.getByTestId('bind-jump')).toHaveText('J');
  await expect(page.getByTestId('key-conflicts')).toHaveCount(0);
  // Binding a taken key is flagged as a conflict on both rows, then undone.
  await page.getByTestId('bind-camera').click();
  await page.keyboard.press('KeyJ');
  await expect(page.getByTestId('key-conflicts')).toContainText('J is bound to Jump and First / third person');
  await page.getByTestId('bind-camera').click();
  await page.keyboard.press('KeyV');
  await expect(page.getByTestId('key-conflicts')).toHaveCount(0);
  // Other tabs render and apply.
  await page.getByTestId('settings-tab-video').click();
  await page.getByTestId('set-fov3').fill('80');
  await page.getByTestId('settings-tab-gameplay').click();
  await page.getByTestId('set-crosshair').getByRole('button', { name: 'Dot', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-crosshair', 'dot');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toHaveCount(0);

  const s = await stored(page);
  expect(s.controls.sensitivity).toBeCloseTo(2.2);
  expect(s.controls.keys.jump).toEqual(['KeyJ']);
  expect(s.controls.keys.camera).toEqual(['KeyV']);
  expect(s.video.fovThird).toBe(80);
  // The menu's key help follows the rebinding.
  await expect(page.locator('.menu .keys')).toContainText('J jump');

  // ---- match: loading screen with real phases, then the game ----
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('loading')).toBeVisible();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 30_000 });
  const ev = (await loadEvents(page)).slice(boot.length);
  expect(ev[0].kind).toBe('show');
  expect(ev.at(-1)!.kind).toBe('hide');
  const phases = new Set(ev.filter((e) => e.kind === 'progress' && e.frac === 1).map((e) => e.phase));
  for (const p of ['code', 'gpu', 'characters', 'map', 'shaders', 'frames']) expect(phases, p).toContain(p);
  const totals = ev.filter((e) => e.kind === 'progress').map((e) => e.total);
  for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1]);
  await page.screenshot({ path: 'test-results/settings-ingame.png' });

  // Settings are live in game.
  expect(await page.evaluate(() => (window as unknown as { __faefight: { input: { sensitivity: number } } }).__faefight.input.sensitivity)).toBeCloseTo(2.2);

  // ---- J jumps, Space no longer does ----
  const humanId = await dbg<number>(page, 'humanId');
  const me = async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[(await me()).island];
  await dbg(page, 'teleport', home.center.x, home.center.z);
  await page.waitForTimeout(1200); // land
  const peakAfter = async (key: string) => {
    const y0 = (await me()).pos.y;
    await page.keyboard.press(key);
    let peak = y0;
    for (let i = 0; i < 12; i++) { await page.waitForTimeout(60); peak = Math.max(peak, (await me()).pos.y); }
    await page.waitForTimeout(900);
    return peak - y0;
  };
  expect(await peakAfter('Space')).toBeLessThan(0.1);
  expect(await peakAfter('KeyJ')).toBeGreaterThan(0.3);

  expect(errors, errors.join('\n')).toEqual([]);
});

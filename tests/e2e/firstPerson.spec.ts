import { expect, test, type Page } from '@playwright/test';

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type Snap = { players: { id: number; island: number; equipped: string }[] };
type Isl = { center: { x: number; z: number } };

test('V toggles first person (persisted) with a viewmodel', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);
  expect(await dbg<string>(page, 'cameraMode')).toBe('third');

  // Stand at home with a rifle out.
  const humanId = await dbg<number>(page, 'humanId');
  await dbg(page, 'clearLoadout'); // blank-slate hotbar: no spawn pistol
  const me = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  const home = (await dbg<Isl[]>(page, 'map'))[me.island];
  await dbg(page, 'teleport', home.center.x, home.center.z);
  await dbg(page, 'give', { weapons: { rifle: { mag: 25, spare: 50 } } });
  await page.keyboard.press('Digit1'); // the rifle lands in hotbar slot 1 (first free slot)
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === humanId)!.equipped).toBe('rifle');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/third-person.png' });
  const fps = () => page.evaluate(() => new Promise<number>((res) => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res((n * 1000) / (performance.now() - t0)); };
    requestAnimationFrame(f);
  }));
  const tpFps = await fps();

  await page.keyboard.press('KeyV');
  expect(await dbg<string>(page, 'cameraMode')).toBe('first');
  await expect(page.getByTestId('camera-toast')).toHaveText(/first person/i);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('faefight.settings.v1')!).gameplay.cameraMode)).toBe('first');
  await page.waitForTimeout(1800); // toast gone, weapon raised
  await page.screenshot({ path: 'test-results/first-person.png' });
  console.log(`[fps] third person ${tpFps.toFixed(1)} · first person ${(await fps()).toFixed(1)}`);
  // Shoot: the sim registers the shot and the viewmodel kicks / flashes.
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.screenshot({ path: 'test-results/first-person-fire.png' });
  await page.mouse.up();
  await expect.poll(async () => (await dbg<{ players: { id: number; inv: { weapons: { rifle?: { mag: number } } } }[] }>(page, 'snapshot'))
    .players.find((p) => p.id === humanId)!.inv.weapons.rifle!.mag).toBeLessThan(25);
  await page.keyboard.press('Digit9'); // an empty hotbar slot = fists
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/first-person-fists.png' });
  await dbg(page, 'give', { weapons: { pistol: { mag: 12, spare: 24 } } });
  await page.keyboard.press('Digit2'); // pistol took the next free slot
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/first-person-pistol.png' });

  // Build ghost still placed in first person.
  await dbg(page, 'give', { pieces: { sandbags: 2 } });
  await page.keyboard.press('Digit3'); // holding the sandbags slot = build mode
  await expect(page.getByTestId('hotbar')).toHaveAttribute('data-ghost', 'ok');
  await page.keyboard.press('Digit9');

  // Persisted across a reload; V back to third person.
  await page.reload();
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  expect(await dbg<string>(page, 'cameraMode')).toBe('first');
  await page.keyboard.press('KeyV');
  expect(await dbg<string>(page, 'cameraMode')).toBe('third');

  expect(errors, errors.join('\n')).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU); // plays a match

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return api[f as string](...(a as unknown[])) as T;
  }, [fn, args] as const);

type V = { x: number; y: number; z: number };
type Player = { id: number; pos: V; hotbar: (string | null)[]; equipped: string; inv: { weapons: Record<string, { mag: number; spare: number }> } };

/** Would closing the tab ask "Leave site?" right now (the leave-match guard armed)? */
const guardArmed = (page: Page) => page.evaluate(() => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
const ads = (page: Page) => page.evaluate(() => (window as unknown as { __faefight: { input: { ads: boolean } } }).__faefight.input.ads);

test('hold Ctrl to aim: Ctrl+click fires (Mac right-click quirk too), Ctrl+WASD still moves, leave guard armed in a match', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // Ctrl aims by default on macOS only: switch it on so the test runs the same on every OS.
  await page.addInitScript(() => {
    const k = 'faefight.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    localStorage.setItem(k, JSON.stringify({ ...s, controls: { ...(s.controls ?? {}), ctrlAim: true } }));
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  expect(await guardArmed(page)).toBe(false); // menu: closing the tab just closes it

  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<{ drawCalls: number }>(page, 'renderInfo')).drawCalls, { timeout: 15_000 }).toBeGreaterThan(10);
  expect(await guardArmed(page)).toBe(true); // in a match: the browser asks first

  const humanId = await dbg<number>(page, 'humanId');
  const me = async () => (await dbg<{ players: Player[] }>(page, 'snapshot')).players.find((p) => p.id === humanId)!;
  await dbg(page, 'give', { weapons: { rifle: { mag: 25, spare: 200 } } });
  await expect.poll(async () => (await me()).hotbar.indexOf('rifle'), { timeout: 5000 }).toBeGreaterThanOrEqual(0);

  // The capture click (rifle not yet in hand matters not: it must not act at all).
  await page.locator('canvas.game').click();
  await page.keyboard.press(`Digit${(await me()).hotbar.indexOf('rifle') + 1}`);
  await expect.poll(async () => (await me()).equipped).toBe('rifle');
  await page.waitForTimeout(300);
  const mag0 = (await me()).inv.weapons.rifle.mag;
  expect(mag0).toBe(25);

  // Hold Ctrl: aiming down sights.
  await page.keyboard.down('Control');
  await expect.poll(() => ads(page)).toBe(true);

  // Ctrl + click: a shot, and still aiming.
  await page.mouse.click(640, 360);
  await expect.poll(async () => (await me()).inv.weapons.rifle.mag, { timeout: 5000 }).toBeLessThan(mag0);
  expect(await ads(page)).toBe(true);

  // macOS turns Ctrl+click into a right click (button 2 + ctrlKey): with Ctrl held to aim it fires too.
  await page.waitForTimeout(400);
  const mag1 = (await me()).inv.weapons.rifle.mag;
  await page.evaluate(() => {
    const c = document.querySelector('canvas.game')!;
    c.dispatchEvent(new MouseEvent('mousedown', { button: 2, buttons: 2, ctrlKey: true, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, ctrlKey: true, bubbles: true }));
  });
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform));
  if (isMac) await expect.poll(async () => (await me()).inv.weapons.rifle.mag, { timeout: 5000 }).toBeLessThan(mag1);
  expect(await ads(page)).toBe(true);

  // Ctrl held, walk with W A S D: the page stays, the player moves.
  const p0 = (await me()).pos;
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) { await page.keyboard.down(k); await page.waitForTimeout(250); await page.keyboard.up(k); }
  await page.keyboard.down('KeyW'); await page.waitForTimeout(600); await page.keyboard.up('KeyW');
  const p1 = (await me()).pos;
  expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(0.5);
  expect(page.isClosed()).toBe(false);

  // Let go of Ctrl: no longer aiming (hold mode).
  await page.keyboard.up('Control');
  await expect.poll(() => ads(page)).toBe(false);
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

type Snap = { players: { id: number; name: string; isBot: boolean }[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

const watchErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

async function host(page: Page) {
  await page.goto('/?net=local&debug=1');
  await page.getByTestId('name-input').fill('Alice');
  await page.getByTestId('host-game').click();
  await expect(page.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
}

test('seat slider: click, drag and keys set open / bot difficulty', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await host(page);
  await expect(page.locator('select')).toHaveCount(0); // no dropdowns anywhere in the lobby
  const s1 = page.getByTestId('seat-slider-1');
  await expect(s1).toHaveAttribute('data-value', 'open');
  await expect(page.getByTestId('start-match')).toBeDisabled();

  // Click the PRO stop.
  await s1.locator('.stop-pro').click();
  await expect(s1).toHaveAttribute('data-value', 'pro');
  await expect(page.getByTestId('seat-1')).toContainText('bot');
  await expect(page.getByTestId('start-match')).toBeEnabled();

  // Keyboard: focus stays on the slider across the lobby re-render.
  await page.keyboard.press('ArrowLeft');
  await expect(s1).toHaveAttribute('data-value', 'hard');
  await page.keyboard.press('ArrowLeft');
  await expect(s1).toHaveAttribute('data-value', 'medium');
  await page.keyboard.press('Home');
  await expect(s1).toHaveAttribute('data-value', 'open');
  await page.keyboard.press('End');
  await expect(s1).toHaveAttribute('data-value', 'pro');

  // Drag the thumb from PRO back to Easy.
  const box = (await s1.boundingBox())!;
  const at = (stop: number) => box.x + ((stop + 0.5) / 5) * box.width;
  await page.mouse.move(at(4), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(at(2.6), box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(at(1.1), box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(s1).toHaveAttribute('data-value', 'easy');

  // A screenshot of a full lobby for the docs: every level, plus the host spectating.
  for (let i = 0; i < 4; i++) await page.getByTestId('add-seat').click();
  await page.getByTestId('seat-slider-2').locator('.stop-medium').click();
  await page.getByTestId('seat-slider-3').locator('.stop-hard').click();
  await page.getByTestId('seat-slider-4').locator('.stop-pro').click();
  await page.getByTestId('lobby-chat-input').fill('/spectate');
  await page.getByTestId('lobby-chat-input').press('Enter');
  await expect(page.getByTestId('seat-0')).toContainText('spectator');
  await page.getByTestId('seat-slider-4').focus();
  await page.waitForTimeout(400); // thumb slide transitions
  await page.screenshot({ path: 'docs/screens/lobby-slider.png' });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('/spectate in the lobby: the host runs a 2-bot match without playing', async ({ page }) => {
  test.skip(ON_CI, NEEDS_GPU);
  const errors = watchErrors(page);
  await host(page);
  const chatIn = page.getByTestId('lobby-chat-input');
  await chatIn.fill('/help');
  await chatIn.press('Enter');
  await expect(page.getByTestId('lobby-feed')).toContainText('/spectate');

  await page.getByTestId('seat-slider-1').locator('.stop-easy').click();
  await chatIn.fill('/spectate');
  await chatIn.press('Enter');
  await expect(page.getByTestId('seat-0')).toContainText('spectator');
  await expect(page.getByTestId('lobby-feed')).toContainText('You are spectating');
  await expect(page.getByTestId('start-match')).toBeDisabled(); // only 1 player besides the host
  // Toggle back and forth once.
  await chatIn.fill('/spectate');
  await chatIn.press('Enter');
  await expect(page.getByTestId('seat-0')).not.toContainText('spectator');
  await chatIn.fill('/spectate');
  await chatIn.press('Enter');
  await expect(page.getByTestId('seat-0')).toContainText('spectator');

  await page.getByTestId('add-seat').click();
  await page.getByTestId('seat-slider-2').locator('.stop-medium').click();
  await expect(page.getByTestId('start-match')).toBeEnabled();
  await page.getByTestId('start-match').click();

  await expect.poll(async () => (await dbg<Snap | null>(page, 'snapshot'))?.players.length ?? 0, { timeout: 30_000 }).toBe(2);
  expect(await dbg<number>(page, 'humanId')).toBe(0);
  const snap = await dbg<Snap>(page, 'snapshot');
  expect(snap.players.every((p) => p.isBot)).toBe(true);
  expect(snap.players.some((p) => p.name === 'Alice')).toBe(false);

  // Free-fly spectator camera: W moves it.
  await expect.poll(async () => (await dbg<{ active: boolean; mode: string }>(page, 'spectator')).active, { timeout: 15_000 }).toBe(true);
  expect((await dbg<{ mode: string }>(page, 'spectator')).mode).toBe('free');
  await expect(page.getByTestId('hotbar')).toBeHidden();
  const p0 = (await dbg<{ camera: { x: number; y: number; z: number } }>(page, 'spectator')).camera;
  await page.locator('canvas.game').focus();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyW');
  const p1 = (await dbg<{ camera: { x: number; y: number; z: number } }>(page, 'spectator')).camera;
  expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)).toBeGreaterThan(3);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('FPS counter shows by default, F3 toggles it; /spectate vs bot hands your player to a bot', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 30_000 });
  const fps = page.getByTestId('fps');
  await expect(fps).toBeVisible();
  await expect(fps).toHaveText(/\d+ fps/);
  await page.locator('canvas.game').focus();
  await page.keyboard.press('F3');
  await expect(fps).toBeHidden();
  expect((await dbg<{ video: { showFps: boolean } }>(page, 'settings')).video.showFps).toBe(false);
  await page.keyboard.press('F3');
  await expect(fps).toBeVisible();

  // /spectate: not sent as chat, the player becomes a bot, the camera goes free-fly.
  await page.keyboard.press('Enter');
  await page.keyboard.type('/spectate');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-feed')).toContainText('You are spectating');
  await expect(page.getByTestId('chat-feed')).not.toContainText('You: /spectate');
  await expect.poll(() => dbg<number>(page, 'humanId')).toBe(0);
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === 1)?.isBot).toBe(true);
  await expect.poll(async () => (await dbg<{ active: boolean }>(page, 'spectator')).active).toBe(true);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/spectate');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-feed')).toContainText('You can rejoin as a player next match');
  expect(errors, errors.join('\n')).toEqual([]);
});

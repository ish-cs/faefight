import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

// Spectating a player shows their HUD (hotbar, gun, cash, hp/shield/stamina); a bot also shows its brain.
const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;

type Snap = { players: { id: number; name: string; isBot: boolean; inv: { cash: number } }[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

test('vs bot /spectate: follow the bot, see its hotbar, gun, stamina and brain; V switches to its eyes', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
  await expect(page.getByTestId('stamina')).toBeVisible();
  await page.locator('canvas.game').focus();

  await page.keyboard.press('Enter');
  await page.keyboard.type('/spectate');
  await page.keyboard.press('Enter');
  await expect.poll(() => dbg<number>(page, 'humanId'), { timeout: 15_000 }).toBe(0);
  // Free fly: nobody followed, so no player widgets (the old player is a bot now; its bars must not show).
  await expect(page.locator('.hud')).toHaveClass(/no-player/);

  // Kit the opponent bot (player 2) so its hotbar is recognisable, then follow it (2nd in the follow order).
  await dbg(page, 'give', { cash: 400, weapons: { rifle: { mag: 4, spare: 25 } }, grenades: 3 }, 2);
  const bot = (await dbg<Snap>(page, 'snapshot')).players.find((p) => p.id === 2)!;
  await page.keyboard.press('Digit2');
  await expect.poll(async () => (await dbg<{ followId: number | null; mode: string }>(page, 'spectator')).followId, { timeout: 10_000 }).toBe(2);
  await expect(page.getByTestId('spectate-banner')).toContainText(`following ${bot.name}`);

  const hud = page.locator('.hud');
  await expect(hud).toHaveClass(/watching/);
  await expect(hud).not.toHaveClass(/no-player/);
  await expect(page.getByTestId('watch-tag')).toContainText(bot.name);
  await expect(page.locator('[data-testid^="hotbar-slot-"][data-item="rifle"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('[data-testid^="hotbar-slot-"][data-item="grenade"]')).toHaveCount(1);
  await expect(page.getByTestId('cash')).toHaveText(/\$\d+/);
  const cash = Number((await page.getByTestId('cash').textContent())!.slice(1));
  expect(cash).toBeGreaterThanOrEqual(400 - 300); // the bot's own money (it may already be shopping), not ours
  await expect(page.getByTestId('stamina')).toBeVisible();

  // The brain panel: personality, difficulty, a goal and a one-line thought, live.
  const brain = page.getByTestId('brain-panel');
  await expect(brain).toBeVisible({ timeout: 10_000 });
  await expect(brain).toContainText('BOT BRAIN');
  await expect(brain).toContainText('EASY');
  await expect(page.getByTestId('brain-goal')).toHaveText(/Goal\s*\S+/);
  await expect(page.getByTestId('brain-thought')).not.toBeEmpty();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/spectate-bot.png` });

  // V: from its eyes (its avatar hidden), V again: back over its shoulder.
  const fp0 = (await dbg<{ firstPerson: boolean }>(page, 'spectator')).firstPerson;
  await page.keyboard.press('KeyV');
  await expect.poll(async () => (await dbg<{ firstPerson: boolean }>(page, 'spectator')).firstPerson).toBe(!fp0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/spectate-bot-v.png` });
  await page.keyboard.press('KeyV');
  await expect.poll(async () => (await dbg<{ firstPerson: boolean }>(page, 'spectator')).firstPerson).toBe(fp0);

  // Back to free fly: the widgets and the brain go away again.
  await page.keyboard.press('Digit0');
  await expect(hud).toHaveClass(/no-player/);
  await expect(brain).toBeHidden();
  expect(errors, errors.join('\n')).toEqual([]);
});

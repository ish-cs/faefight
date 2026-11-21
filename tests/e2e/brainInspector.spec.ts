import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

// Spectating a bot: B opens its brain inspector (goal, scores with breakdown, decision log, perception, plans,
// state); Shift+B the in-world overlay. And the HUD is the bot's own view: its hit markers, damage numbers
// and hit-direction arcs, its hotbar selection.
const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;

type P = { id: number; name: string; isBot: boolean; alive: boolean; selected: number; pos: { x: number; z: number } };
type Digest = { goal: string; scores: unknown[]; log: unknown[]; seen: unknown[]; target: unknown };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);
const players = async (page: Page) => (await dbg<{ players: P[] }>(page, 'snapshot')).players;

test('spectate a bot: brain inspector populated, overlay on, and the HUD shows its hits and hurts', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
  await page.locator('canvas.game').focus();

  // Count transient effects as they appear (hit markers, damage numbers, hit arcs).
  await page.evaluate(() => {
    const w = window as unknown as { fx: Record<string, number> };
    w.fx = { arrow: 0, number: 0 };
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        const c = (n as HTMLElement).classList;
        if (!c) continue;
        if (c.contains('hit-arrow')) w.fx.arrow++;
        if (c.contains('dmg-number')) w.fx.number++;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  // Our player, armed, walks up to the bot's island; the bot gets a rifle too. Then /spectate: our seat is
  // bot-run from here, so the two bots fight right away.
  const bot = (await players(page)).find((p) => p.isBot)!;
  await dbg(page, 'give', { cash: 300, weapons: { rifle: { mag: 25, spare: 100 } } });
  await dbg(page, 'give', { cash: 300, weapons: { rifle: { mag: 25, spare: 100 } } }, bot.id);
  await dbg(page, 'teleport', bot.pos.x + 9, bot.pos.z + 9);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/spectate');
  await page.keyboard.press('Enter');
  await expect.poll(() => dbg<number>(page, 'humanId'), { timeout: 15_000 }).toBe(0);
  // Follow the bot (1-9 pick by id order among the living); retried in case the key lands before the camera is ready.
  await expect.poll(async () => {
    const f = (await dbg<{ followId: number | null }>(page, 'spectator')).followId;
    if (f === bot.id) return f;
    const order = (await players(page)).filter((p) => p.alive).map((p) => p.id).sort((a, b) => a - b);
    await page.locator('canvas.game').focus();
    await page.keyboard.press(`Digit${order.indexOf(bot.id) + 1}`);
    return f;
  }, { timeout: 15_000 }).toBe(bot.id);

  // B: the inspector, filled from the bot's brain digest (~4 Hz).
  await page.keyboard.press('KeyB');
  const panel = page.getByTestId('brain-inspector');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText(bot.name);
  await expect(page.getByTestId('bx-goal')).toHaveText(/[A-Z]+\s*→\s*\S/, { timeout: 15_000 });
  await expect(page.getByTestId('brain-panel')).toBeHidden(); // the compact panel gives way
  // Scores need a decision (≤ 1.6 s for an easy bot), the log a goal switch.
  await expect.poll(async () => (await dbg<{ digest: Digest | null }>(page, 'brain')).digest?.scores.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(3);
  await expect(page.getByTestId('bx-scores').locator('.bx-row')).not.toHaveCount(0);
  await expect(page.getByTestId('bx-scores').locator('.bx-f').first()).toBeVisible();
  await expect(page.getByTestId('bx-why')).not.toHaveText(/^…$/);
  await expect.poll(async () => (await dbg<{ digest: Digest | null }>(page, 'brain')).digest?.seen.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('bx-perception')).toContainText(/in sight|last seen/);
  await expect.poll(async () => (await dbg<{ digest: Digest | null }>(page, 'brain')).digest?.log.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('bx-log').locator('li')).not.toHaveCount(0);
  await expect(page.getByTestId('bx-state')).toContainText('Aim error');
  await expect(page.getByTestId('bx-plans').locator('li.cur')).toHaveCount(1);
  await expect.poll(async () => (await dbg<{ overlay: boolean }>(page, 'brain')).overlay).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brain-inspector.png` });

  // Its view: it hits our old seat (hit marker + damage numbers) and gets hit (hit-direction arcs).
  const crossHits = () => page.getByTestId('crosshair').evaluate((n) => Number((n as HTMLElement).dataset.hits ?? 0));
  const fx = () => page.evaluate(() => (window as unknown as { fx: { arrow: number; number: number } }).fx);
  await expect.poll(crossHits, { timeout: 45_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await fx()).number, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await fx()).arrow, { timeout: 45_000 }).toBeGreaterThan(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brain-hurt.png` });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brain-fight.png` });

  // Hotbar selection mirrors the bot's own.
  const sel = (await players(page)).find((p) => p.id === bot.id)!.selected;
  await expect(page.locator(`[data-testid="hotbar-slot-${sel}"]`)).toHaveClass(/selected/);

  // Shift+B: overlay off; B: inspector closed, compact panel back.
  await page.keyboard.press('Shift+KeyB');
  await expect.poll(async () => (await dbg<{ overlay: boolean }>(page, 'brain')).overlay).toBe(false);
  await page.keyboard.press('KeyB');
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('brain-panel')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type P = { id: number; name: string; isBot: boolean; alive: boolean; eliminated: boolean; kills: number; deaths: number };
type Snap = { time: number; players: P[]; pieces: unknown[]; loot: unknown[]; winner: number | null };
type Spec = { active: boolean; mode: string; camera: { x: number; y: number; z: number }; selfVisible: boolean };

const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;
const snapOf = (p: Page) => dbg<Snap | null>(p, 'snapshot');
const spec = (p: Page) => dbg<Spec>(p, 'spectator');
const dist = (a: Spec['camera'], b: Spec['camera']) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function watchErrors(tag: string, p: Page, errors: string[]) {
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
}

/** Hold W and check the spectator camera flew somewhere while staying invisible. */
async function flies(page: Page) {
  await expect.poll(async () => (await spec(page)).active).toBe(true);
  const c0 = (await spec(page)).camera;
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyW');
  const s = await spec(page);
  expect(s.mode).toBe('free');
  expect(dist(s.camera, c0)).toBeGreaterThan(3);
  expect(s.selfVisible).toBe(false);
}

test.describe.configure({ mode: 'serial' });

test('vs bot: dead → invisible free-fly spectator, Tab scoreboard, eliminated → Spectate / Play again', async ({ page }) => {
  const errors: string[] = [];
  watchErrors('P', page, errors);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  const me = await dbg<number>(page, 'humanId');
  await page.locator('canvas.game').focus();
  expect((await spec(page)).active).toBe(false);

  // Dead, waiting to respawn: spectating.
  await dbg(page, 'kill', me);
  await expect.poll(async () => (await snapOf(page))!.players.find((p) => p.id === me)!.alive).toBe(false);
  await flies(page);
  await expect(page.getByTestId('spectate-banner')).toContainText('SPECTATING — free fly');

  // Hold Tab: scoreboard with both players (the bot by nickname with a BOT tag), my death counted.
  await page.keyboard.down('Tab');
  const board = page.getByTestId('scoreboard');
  await expect(board).toBeVisible();
  await expect(board.locator('tr.sb-row')).toHaveCount(2);
  const bot = (await snapOf(page))!.players.find((p) => p.id !== me)!;
  await expect(page.getByTestId(`score-${bot.id}`)).toContainText(bot.name);
  await expect(page.getByTestId(`score-${bot.id}`)).toContainText('BOT');
  await expect(page.getByTestId(`score-${me}`)).toContainText(/Dead|Alive/); // may already have respawned
  await expect(page.getByTestId(`score-${me}`).locator('td.num').nth(1)).toHaveText('1');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/scoreboard.png` });
  await page.keyboard.up('Tab');
  await expect(board).toBeHidden();

  // Eliminated (1v1: the bot wins): end screen with Play again / Spectate.
  await dbg(page, 'eliminate', me);
  const end = page.getByTestId('end-screen');
  await expect(end).toBeVisible();
  await expect(end).toContainText('ELIMINATED');
  await expect(page.getByTestId('play-again')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/end-solo.png` });
  await page.getByTestId('spectate').click();
  await expect(end).toBeHidden();
  await flies(page);
  // Follow the bot with 1, then any movement key goes back to free fly.
  await page.keyboard.press('Digit1');
  await expect.poll(async () => (await spec(page)).mode).toBe('follow');
  await expect(page.getByTestId('spectate-banner')).toContainText(`following ${bot.name}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/spectate-follow.png` });
  await flies(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/spectate.png` });
  // The sim ignored all of it: still dead, still eliminated.
  const after = (await snapOf(page))!.players.find((p) => p.id === me)!;
  expect(after).toMatchObject({ alive: false, eliminated: true });

  // Losing the pointer lock / Esc isn't testable headless; bring the end screen back via the hud and play again.
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="end-screen"]')!.style.display = 'flex');
  await page.getByTestId('play-again').click();
  await expect.poll(async () => { const s = await snapOf(page); return s ? s.winner === null && s.time < 5 && s.players.every((p) => p.deaths === 0) : false; }, { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId('end-screen')).toBeHidden();
  expect(await page.locator('canvas.game').count()).toBe(1);
  expect(await page.locator('.hud').count()).toBe(1);
  expect((await snapOf(page))!.players.find((p) => p.id !== me)!.name).toBe(bot.name); // same bot
  expect(errors, errors.join('\n')).toEqual([]);
});

test('online: host wins → Rematch keeps both in the room with a fresh match; Back to lobby', async ({ context }) => {
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  watchErrors('A', a, errors);
  watchErrors('B', b, errors);

  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;
  await b.goto('/?net=local&debug=1');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code);
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await a.getByTestId('start-match').click();
  await expect.poll(async () => (await snapOf(b))?.players.length ?? 0, { timeout: 30_000 }).toBe(2);
  await b.evaluate(() => { (window as unknown as { __stayed: number }).__stayed = 42; }); // gone if B ever reloads

  // Host scoreboard marks the host.
  await a.bringToFront();
  await a.locator('canvas.game').focus();
  await a.keyboard.down('Tab');
  await expect(a.getByTestId('score-1')).toContainText('host');
  await expect(a.getByTestId('score-2')).toContainText('Bob');
  await a.keyboard.up('Tab');

  // Host "wins": Bob is eliminated.
  await dbg(a, 'eliminate', 2);
  await expect(a.getByTestId('end-screen')).toContainText('VICTORY');
  await expect(b.getByTestId('end-screen')).toContainText('ELIMINATED', { timeout: 10_000 });
  await expect(b.getByTestId('waiting-host')).toHaveText('Waiting for host…');
  await expect(b.getByTestId('rematch')).toHaveCount(0);
  await expect(a.getByTestId('back-to-lobby')).toBeVisible();
  if (SHOTS) { await a.screenshot({ path: `${SHOTS}/end-host.png` }); await b.screenshot({ path: `${SHOTS}/end-client.png` }); }
  expect((await snapOf(a))!.loot.length).toBeGreaterThan(0); // Bob dropped his cash

  // Rematch: both pages get a fresh match, no leftovers, B never left the room.
  await a.getByTestId('rematch').click();
  for (const p of [a, b]) {
    await expect.poll(async () => {
      const s = await snapOf(p);
      return !!s && s.winner === null && s.time < 5 && s.players.length === 2 && s.players.every((x) => x.alive && x.deaths === 0);
    }, { timeout: 30_000 }).toBe(true);
    const s = (await snapOf(p))!;
    expect(s.pieces).toEqual([]);
    expect(s.loot).toEqual([]);
    await expect(p.getByTestId('end-screen')).toBeHidden();
    expect(await p.locator('canvas.game').count()).toBe(1);
  }
  expect(await dbg<number>(b, 'humanId')).toBe(2);
  expect((await snapOf(a))!.players.find((x) => x.id === 2)).toMatchObject({ name: 'Bob', isBot: false });
  expect(await b.evaluate(() => (window as unknown as { __stayed: number }).__stayed)).toBe(42);

  // B still drives its player in the new match.
  const posOnA = async () => (await dbg<{ players: { id: number; pos: { x: number; z: number } }[] }>(a, 'snapshot')).players.find((x) => x.id === 2)!.pos;
  const p0 = await posOnA();
  await b.bringToFront();
  await b.locator('canvas.game').focus();
  await b.keyboard.down('KeyW');
  await b.waitForTimeout(1000);
  await b.keyboard.up('KeyW');
  await expect.poll(async () => { const p1 = await posOnA(); return Math.hypot(p1.x - p0.x, p1.z - p0.z); }).toBeGreaterThan(1);

  // End it again and go back to the lobby: both see the lobby, B still seated; the host can start again.
  await dbg(a, 'eliminate', 2);
  await a.getByTestId('back-to-lobby').click();
  await expect(a.getByTestId('lobby-code')).toHaveText(code);
  await expect(b.getByTestId('seat-1')).toContainText('Bob');
  await expect(b.getByText('Waiting for host…')).toBeVisible();
  expect(await b.locator('canvas.game').count()).toBe(0);
  await expect(a.getByTestId('start-match')).toBeEnabled();
  await a.getByTestId('start-match').click();
  await expect.poll(async () => { const s = await snapOf(b); return !!s && s.time < 5 && s.winner === null; }, { timeout: 30_000 }).toBe(true);
  expect(await b.evaluate(() => (window as unknown as { __stayed: number }).__stayed)).toBe(42);

  expect(errors, errors.join('\n')).toEqual([]);
});

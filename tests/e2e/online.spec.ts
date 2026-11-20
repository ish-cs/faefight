import { expect, test, type Page } from '@playwright/test';

type Snap = { players: { id: number; name: string; isBot: boolean; pos: { x: number; y: number; z: number } }[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

// Directory for review screenshots (optional): E2E_SHOTS=/some/dir pnpm e2e
const SHOTS = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.E2E_SHOTS;

// Each test runs two WebGPU pages; running them one at a time keeps GPU contention (and flakiness) down.
test.describe.configure({ mode: 'serial' });

test('host + join by code, bot seat, movement, chat, leaver becomes a bot', async ({ context }) => {
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [tag, p] of [['A', a], ['B', b]] as const) {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
  }

  // A hosts.
  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const codeEl = a.getByTestId('lobby-code');
  await expect(codeEl).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await codeEl.textContent())!;
  await expect(a.getByTestId('start-match')).toBeDisabled(); // seat 2 is open

  // B joins with the code.
  await b.goto('/?net=local&debug=1');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code.toLowerCase());
  await b.getByTestId('join-game').click();
  await expect(b.getByText('Waiting for host…')).toBeVisible();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await expect(b.getByTestId('seat-0')).toContainText('Alice');

  // A adds seat 3, makes it an easy bot, starts.
  await a.getByTestId('add-seat').click();
  await expect(a.getByTestId('start-match')).toBeDisabled();
  await a.getByTestId('seat-select-2').selectOption('bot-easy');
  await expect(b.getByTestId('seat-2')).toContainText('Bot (easy)');
  if (SHOTS) { await a.screenshot({ path: `${SHOTS}/lobby-host.png` }); await b.screenshot({ path: `${SHOTS}/lobby-join.png` }); }
  await a.getByTestId('start-match').click();

  // Both see the 3-player match.
  const players = async (p: Page) => (await dbg<Snap | null>(p, 'snapshot'))?.players.length ?? 0;
  await expect.poll(() => players(a), { timeout: 30_000 }).toBe(3);
  await expect.poll(() => players(b), { timeout: 30_000 }).toBe(3);
  const bId = await dbg<number>(b, 'humanId');
  expect(bId).toBe(2);

  // B holds W for 1 s; A's snapshot shows B moved.
  const posOn = async (p: Page) => (await dbg<Snap>(p, 'snapshot')).players.find((x) => x.id === bId)!.pos;
  const p0 = await posOn(a);
  await b.bringToFront();
  await b.locator('canvas.game').focus();
  await b.keyboard.down('KeyW');
  await b.waitForTimeout(1000);
  await b.keyboard.up('KeyW');
  await expect.poll(async () => { const p1 = await posOn(a); return Math.hypot(p1.x - p0.x, p1.z - p0.z); }).toBeGreaterThan(1);
  if (SHOTS) { await a.screenshot({ path: `${SHOTS}/match-host.png` }); await b.screenshot({ path: `${SHOTS}/match-join.png` }); }

  // B chats; A shows it as literal text.
  await b.keyboard.press('Enter');
  await expect(b.getByTestId('chat-input')).toBeVisible();
  await b.keyboard.type('hello <script>');
  await b.keyboard.press('Enter');
  await expect(b.getByTestId('chat-input')).toBeHidden();
  await expect(a.getByTestId('chat-feed')).toContainText('Bob: hello <script>');
  await expect(b.getByTestId('chat-feed')).toContainText('Bob: hello <script>');
  expect(await a.locator('[data-testid="chat-feed"] script').count()).toBe(0);
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/chat-host.png` });

  // B leaves; within 5 s A sees B's seat taken over by a bot.
  await b.close();
  await expect.poll(async () => (await dbg<Snap>(a, 'snapshot')).players.find((x) => x.id === bId)!.isBot, { timeout: 5_000 }).toBe(true);
  await expect(a.getByTestId('chat-feed')).toContainText('Bob left — a bot took over');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('joining a bad code shows an error with a way back', async ({ page }) => {
  await page.goto('/?net=local');
  await page.getByTestId('name-input').fill('Carol');
  await page.getByTestId('code-input').fill('ZZZZZZ');
  await page.getByTestId('join-game').click();
  await expect(page.getByTestId('lobby-error')).toContainText('No game with that code', { timeout: 20_000 });
  await page.getByText('Back to menu').click();
  await expect(page.getByTestId('host-game')).toBeVisible();
});

test('host leaving shows "Host left" to the client', async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
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
  await expect.poll(async () => (await dbg<Snap | null>(b, 'snapshot'))?.players.length ?? 0, { timeout: 30_000 }).toBe(2);
  await a.close();
  await expect(b.getByTestId('fatal')).toContainText('Host left', { timeout: 5_000 });
  await b.getByText('Back to menu').click();
  await expect(b.getByTestId('host-game')).toBeVisible();
});

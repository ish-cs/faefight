import { expect, test, type Page } from '@playwright/test';
import { decodeReplay } from '../../src/sim/replay/codec';
import { HASH_EVERY } from '../../src/sim/replay/format';
import { ReplayRunner } from '../../src/sim/replay/runner';
import { NEEDS_GPU, ON_CI } from './gpu';

/**
 * Replays recorded in the browser must re-run identically in Node: the bot-learning pipeline
 * (scripts/autoimprove, scripts/replays) re-simulates real players' matches there. Each test records in
 * headless Chromium, then re-runs the bytes here (Node) and checks every recorded state hash.
 * (Chromium's Math.sin/cos/atan2/exp differ from Node's in the last bit; the sim uses src/sim/dmath.ts.)
 */

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type Snap = { players: { id: number }[]; winner: number | null };

/** Re-run a browser recording in Node: every recorded hash must match. Returns how many were checked. */
async function rerunInNode(bytes: Uint8Array): Promise<number> {
  const replay = await decodeReplay(bytes);
  const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
  try {
    while (!runner.done) runner.step();
    expect(runner.divergedAt, `Node re-run diverged from the browser recording at tick ${runner.divergedAt}`).toBeNull();
    return Math.min(replay.hashes.length, Math.floor(runner.tick / HASH_EVERY));
  } finally {
    runner.dispose();
  }
}

/** Every replay this page has saved (IndexedDB), as bytes. */
async function savedReplays(page: Page): Promise<Uint8Array[]> {
  const all = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open('faefight-replays', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const store = db.transaction('data', 'readonly').objectStore('data');
    const vals: Uint8Array[] = await new Promise((res, rej) => {
      const r = store.getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return vals.map((v) => Array.from(v));
  });
  return all.map((b) => Uint8Array.from(b));
}

// Sim only (no rendering): runs on CI too. An 8-bot match recorded by the headless recorder in the page.
test('a bot match recorded in Chromium re-runs identically in Node', async ({ page }) => {
  test.setTimeout(ON_CI ? 240_000 : 120_000);
  await page.goto('/');
  const bytes = await page.evaluate(async () => {
    const path = '/src/sim/replay/headless.ts';
    const { recordHeadlessMatch } = await import(/* @vite-ignore */ path);
    const players = Array.from({ length: 8 }, (_, i) => ({ name: `Bot ${i + 1}`, isBot: true, difficulty: i % 2 ? 'pro' : 'medium' }));
    const r = await recordHeadlessMatch({ players }, 4242, 30 * 75);
    return Array.from(r.bytes as Uint8Array);
  });
  const checked = await rerunInNode(Uint8Array.from(bytes));
  expect(checked).toBeGreaterThanOrEqual(60);
});

test('a vs-bots game recorded in the browser re-runs identically in Node', async ({ page }) => {
  test.skip(ON_CI, NEEDS_GPU);
  await page.goto('/?debug=1');
  await page.getByTestId('play-medium').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await page.locator('canvas.game').focus();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(5000);
  const me = await dbg<number>(page, 'humanId');
  for (const p of (await dbg<Snap>(page, 'snapshot')).players) if (p.id !== me) await dbg(page, 'eliminate', p.id);
  await expect.poll(async () => (await dbg<Snap>(page, 'snapshot')).winner, { timeout: 10_000 }).toBe(me);
  await expect.poll(async () => (await savedReplays(page)).length, { timeout: 10_000 }).toBe(1);
  const [bytes] = await savedReplays(page);
  expect(await rerunInNode(bytes)).toBeGreaterThanOrEqual(6);
});

test('an online game recorded by the host re-runs identically in Node', async ({ context }) => {
  test.skip(ON_CI, NEEDS_GPU);
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;
  await b.goto('/?net=local&debug=1');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code.toLowerCase());
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await a.getByTestId('add-seat').click();
  await a.getByTestId('seat-slider-2').locator('.stop-easy').click();
  await a.getByTestId('start-match').click();
  const players = async (p: Page) => (await dbg<Snap | null>(p, 'snapshot'))?.players.length ?? 0;
  await expect.poll(() => players(a), { timeout: 30_000 }).toBe(3);
  await expect.poll(() => players(b), { timeout: 30_000 }).toBe(3);

  // The guest moves, turns and shoots (remote inputs + client-predicted moves the host records).
  await b.bringToFront();
  await b.locator('canvas.game').focus();
  await b.keyboard.down('KeyW');
  await b.mouse.move(700, 360);
  await b.waitForTimeout(1500);
  await b.keyboard.down('KeyD');
  await b.mouse.move(500, 300);
  await b.waitForTimeout(1000);
  await b.keyboard.up('KeyW');
  await b.keyboard.up('KeyD');
  await b.mouse.down();
  await b.waitForTimeout(300);
  await b.mouse.up();
  // The host moves too.
  await a.bringToFront();
  await a.locator('canvas.game').focus();
  await a.keyboard.down('KeyA');
  await a.waitForTimeout(1500);
  await a.keyboard.up('KeyA');
  await a.waitForTimeout(2000);

  const host = await dbg<number>(a, 'humanId');
  for (const p of (await dbg<Snap>(a, 'snapshot')).players) if (p.id !== host) await dbg(a, 'eliminate', p.id);
  await expect.poll(async () => (await dbg<Snap>(a, 'snapshot')).winner, { timeout: 10_000 }).toBe(host);
  await expect.poll(async () => (await savedReplays(a)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const replays = await savedReplays(a);
  // Pages share one origin (one IndexedDB): re-run every recording saved (the host's, and the guest's if any).
  let checked = 0;
  for (const r of replays) checked = Math.max(checked, await rerunInNode(r));
  expect(checked).toBeGreaterThanOrEqual(6);
});

import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';
import { decodeReplay } from '../../src/sim/replay/codec';

test.skip(ON_CI, NEEDS_GPU); // plays a match

// Host migration over the same-browser BroadcastChannel transport (?net=local): the host's tab closes
// mid-match and the match goes on with a guest hosting it.

type P = { id: number; name: string; isBot: boolean; pos: { x: number; y: number; z: number }; inv: { cash: number } };
type Snap = { tick: number; players: P[] };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);
const snapOf = (p: Page) => dbg<Snap | null>(p, 'snapshot');
const migrated = (p: Page) => p.evaluate(() => (window as unknown as { __faefightMigrated?: string }).__faefightMigrated ?? null);

test.describe.configure({ mode: 'serial' });

function watch(tag: string, p: Page, errors: string[], logs: string[]) {
  p.on('console', (m) => {
    logs.push(`${tag}: ${m.text()}`);
    if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`);
  });
  p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
}

async function host(p: Page, name: string) {
  await p.goto('/?net=local&debug=1');
  await p.getByTestId('name-input').fill(name);
  await p.getByTestId('host-game').click();
  await expect(p.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  return (await p.getByTestId('lobby-code').textContent())!;
}

async function join(p: Page, name: string, code: string) {
  await p.goto('/?net=local&debug=1');
  await p.getByTestId('name-input').fill(name);
  await p.getByTestId('code-input').fill(code);
  await p.getByTestId('join-game').click();
  await expect(p.getByText('Waiting for host…')).toBeVisible();
}

/** Number of checkpoints the host has sent so far (from its console log). */
const checkpoints = (logs: string[]) => logs.filter((l) => l.startsWith('A: [migrate] checkpoint #')).length;

test('host leaves mid-match: a guest takes over, the other follows; seats, positions and cash carry over', async ({ context }) => {
  test.setTimeout(180_000);
  const errors: string[] = [], logs: string[] = [];
  const a = await context.newPage(), b = await context.newPage(), c = await context.newPage();
  watch('A', a, errors, logs); watch('B', b, errors, logs); watch('C', c, errors, logs);

  const code = await host(a, 'Alice');
  await join(b, 'Bob', code);
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await a.getByTestId('add-seat').click();
  await join(c, 'Carol', code);
  await expect(a.getByTestId('seat-2')).toContainText('Carol');
  await a.getByTestId('add-seat').click();
  await a.getByTestId('seat-slider-3').locator('.stop-easy').click();
  await a.getByTestId('start-match').click();
  for (const p of [a, b, c]) await expect.poll(async () => (await snapOf(p))?.players.length ?? 0, { timeout: 45_000 }).toBe(4);
  // The debug API can lag the first snapshot by a frame: poll for each guest's player id.
  await expect.poll(() => dbg<number | null>(b, 'humanId'), { timeout: 10_000 }).toBe(2);
  await expect.poll(() => dbg<number | null>(c, 'humanId'), { timeout: 10_000 }).toBe(3);
  const bId = 2, cId = 3;

  // Cash for both guests via the host's debug channel, then wait for a checkpoint that includes it.
  await dbg(a, 'give', { cash: 777 }, bId);
  await dbg(a, 'give', { cash: 333 }, cId);
  await expect.poll(async () => (await snapOf(b))!.players.find((x) => x.id === bId)!.inv.cash, { timeout: 10_000 }).toBeGreaterThanOrEqual(777);
  const n0 = checkpoints(logs);
  await expect.poll(() => checkpoints(logs), { timeout: 20_000 }).toBeGreaterThan(n0);
  // Guests are idle: their positions don't change from here.
  const before = (await snapOf(a))!;
  const cashB = (await snapOf(b))!.players.find((x) => x.id === bId)!.inv.cash;
  const cashC = (await snapOf(c))!.players.find((x) => x.id === cId)!.inv.cash;

  const t0 = Date.now();
  await a.close();

  // One guest hosts now, the other follows it.
  await expect.poll(async () => [await migrated(b), await migrated(c)].sort().join(','), { timeout: 20_000 }).toBe('guest,host');
  const [newHost, follower] = (await migrated(b)) === 'host' ? [b, c] : [c, b];
  const hostName = newHost === b ? 'Bob' : 'Carol';
  await expect(follower.locator('.toast', { hasText: `${hostName} is now hosting` })).toBeVisible({ timeout: 10_000 });
  await expect(newHost.locator('.toast', { hasText: 'You are now hosting' })).toBeVisible();

  // The match keeps ticking on both, from the new host.
  const tickB = (await snapOf(follower))!.tick;
  await expect.poll(async () => (await snapOf(follower))!.tick, { timeout: 10_000 }).toBeGreaterThan(tickB + 30);
  const resumedMs = Date.now() - t0;
  console.info(`[e2e] host closed → follower ticking again on the new host after ${resumedMs} ms`);
  expect(resumedMs).toBeLessThan(15_000);

  const after = (await snapOf(newHost))!;
  expect(after.players).toHaveLength(4);
  expect(after.players.find((x) => x.id === 1)!.isBot).toBe(true); // Alice's player went to a bot
  for (const id of [bId, cId]) {
    const p0 = before.players.find((x) => x.id === id)!.pos, p1 = after.players.find((x) => x.id === id)!.pos;
    expect(after.players.find((x) => x.id === id)!.isBot, `player ${id}`).toBe(false);
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z), `player ${id} position`).toBeLessThan(1);
  }
  expect(after.players.find((x) => x.id === bId)!.inv.cash).toBe(cashB);
  expect(after.players.find((x) => x.id === cId)!.inv.cash).toBe(cashC);
  expect((await snapOf(follower))!.players.find((x) => x.id === (follower === b ? bId : cId))!.inv.cash).toBe(follower === b ? cashB : cashC);

  // The follower still plays: it walks and the new host sees it.
  const fId = follower === b ? bId : cId;
  const q0 = (await snapOf(newHost))!.players.find((x) => x.id === fId)!.pos;
  await follower.bringToFront();
  await follower.locator('canvas.game').focus();
  await follower.keyboard.down('KeyW');
  await follower.waitForTimeout(1000);
  await follower.keyboard.up('KeyW');
  await expect.poll(async () => { const q1 = (await snapOf(newHost))!.players.find((x) => x.id === fId)!.pos; return Math.hypot(q1.x - q0.x, q1.z - q0.z); }, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(follower.getByTestId('chat-feed')).toContainText(`${hostName} is now hosting`);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('2 players: the guest takes over and plays on vs the bots', async ({ context }) => {
  test.setTimeout(120_000);
  const errors: string[] = [], logs: string[] = [];
  const a = await context.newPage(), b = await context.newPage();
  watch('A', a, errors, logs); watch('B', b, errors, logs);
  const code = await host(a, 'Alice');
  await join(b, 'Bob', code);
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await a.getByTestId('add-seat').click();
  await a.getByTestId('seat-slider-2').locator('.stop-easy').click();
  await a.getByTestId('start-match').click();
  await expect.poll(async () => (await snapOf(b))?.players.length ?? 0, { timeout: 45_000 }).toBe(3);
  await expect.poll(() => checkpoints(logs), { timeout: 20_000 }).toBeGreaterThan(0);
  await a.close();
  await expect.poll(() => migrated(b), { timeout: 15_000 }).toBe('host');
  const t1 = (await snapOf(b))!.tick;
  await expect.poll(async () => (await snapOf(b))!.tick, { timeout: 10_000 }).toBeGreaterThan(t1 + 60);
  const s = (await snapOf(b))!;
  expect(s.players.find((x) => x.id === 1)!.isBot).toBe(true);
  expect(s.players.find((x) => x.id === 2)!.isBot).toBe(false);
  await expect(b.getByTestId('fatal')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

/** Esc → pause card → Leave match (the way a player leaves on purpose). */
async function leaveMatch(p: Page) {
  await p.bringToFront();
  await p.locator('canvas.game').click();
  await expect.poll(() => p.evaluate(() => !!document.pointerLockElement)).toBe(true);
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await p.evaluate(() => document.exitPointerLock());
  await expect(p.getByTestId('pause-quit')).toHaveText('Leave match');
  await p.getByTestId('pause-quit').click();
}

test('every segment of a migrated match is recorded and uploaded, linked by match id and segment', async ({ context }) => {
  test.setTimeout(240_000);
  const errors: string[] = [], logs: string[] = [];
  // Uploads on (?telemetry=1); the endpoint is stubbed here and keeps what it was sent.
  const uploads: Buffer[] = [];
  await context.route('**/api/replays', async (route) => {
    uploads.push(route.request().postDataBuffer()!);
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await context.route('**/api/errors', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }));
  const a = await context.newPage(), b = await context.newPage(), c = await context.newPage();
  watch('A', a, errors, logs); watch('B', b, errors, logs); watch('C', c, errors, logs);

  await a.goto('/?net=local&debug=1&telemetry=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  await expect(a.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await a.getByTestId('lobby-code').textContent())!;
  for (const [p, name] of [[b, 'Bob'], [c, 'Carol']] as const) {
    await p.goto('/?net=local&debug=1&telemetry=1');
    await p.getByTestId('name-input').fill(name);
    await p.getByTestId('code-input').fill(code);
    await p.getByTestId('join-game').click();
    await expect(p.getByText('Waiting for host…')).toBeVisible();
    await expect(a.getByTestId(`seat-${name === 'Bob' ? 1 : 2}`)).toContainText(name);
    await a.getByTestId('add-seat').click();
  }
  await a.getByTestId('seat-slider-3').locator('.stop-easy').click();
  await a.getByTestId('start-match').click();
  for (const p of [a, b, c]) await expect.poll(async () => (await snapOf(p))?.players.length ?? 0, { timeout: 45_000 }).toBe(4);

  // Past the partial-upload minimum (60 s of play), with a checkpoint taken after that.
  await expect.poll(async () => (await snapOf(a))?.tick ?? 0, { timeout: 100_000, intervals: [2000] }).toBeGreaterThan(61 * 30);
  const n0 = checkpoints(logs);
  await expect.poll(() => checkpoints(logs), { timeout: 20_000 }).toBeGreaterThan(n0);

  // Alice leaves: her recording so far goes up (unfinished), and Bob or Carol takes the match over.
  await leaveMatch(a);
  await expect.poll(() => uploads.length, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => [await migrated(b), await migrated(c)].sort().join(','), { timeout: 20_000 }).toBe('guest,host');
  const [newHost, follower] = (await migrated(b)) === 'host' ? [b, c] : [c, b];
  const t1 = (await snapOf(newHost))!.tick;
  await expect.poll(async () => (await snapOf(newHost))!.tick, { timeout: 10_000 }).toBeGreaterThan(t1 + 90);

  // The new host leaves too (the follower first, so nobody takes over again): the rest of the match goes up.
  await follower.close();
  await leaveMatch(newHost);
  await expect.poll(() => uploads.length, { timeout: 20_000 }).toBe(2);

  const [seg0, seg1] = (await Promise.all(uploads.map((u) => decodeReplay(new Uint8Array(u))))).sort((x, y) => x.header.segment - y.header.segment);
  expect(seg0.header).toMatchObject({ segment: 0, startTick: 0, matchId: seg0.header.id, kind: 'host' });
  expect(seg0.footer.unfinished).toBe(true);
  expect(seg0.checkpoint).toBeNull();
  expect(seg1.header).toMatchObject({ segment: 1, matchId: seg0.header.id, kind: 'host', setup: seg0.header.setup });
  expect(seg1.header.id).not.toBe(seg0.header.id);
  expect(seg1.checkpoint).not.toBeNull();
  // Segment 1 starts from a checkpoint inside segment 0 (stitch: segment 0 up to there, then segment 1).
  expect(seg1.header.startTick).toBeGreaterThan(61 * 30);
  expect(seg1.header.startTick).toBeLessThanOrEqual(seg0.footer.ticks);
  expect(seg1.ops[0]).toEqual({ tick: 0, op: { k: 'setBot', id: 1, difficulty: 'medium' } }); // Alice's seat to a bot
  // Both re-run exactly as recorded (segment 1 from its checkpoint), in the browser like the replay viewer.
  // (Not in Node: browser-recorded host replays don't re-run identically under Node yet, segment 0 included.)
  for (const [i, u] of uploads.entries()) {
    const res = await a.evaluate(async ([b64, codecUrl, runnerUrl]) => {
      const { decodeReplay } = (await import(codecUrl)) as typeof import('../../src/sim/replay/codec');
      const { ReplayRunner } = (await import(runnerUrl)) as typeof import('../../src/sim/replay/runner');
      const r = await decodeReplay(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
      const run = await ReplayRunner.create(r, { checkpointEvery: 0 });
      while (!run.done) run.step();
      const out = { divergedAt: run.divergedAt, last: run.last?.tick ?? null, end: r.header.startTick + r.ticks.length };
      run.dispose();
      return out;
    }, [u.toString('base64'), '/src/sim/replay/codec.ts', '/src/sim/replay/runner.ts'] as const);
    expect(res.divergedAt, `upload ${i}`).toBeNull();
    expect(res.last, `upload ${i}`).toBe(res.end);
  }
  console.info(`[e2e] segment 0: ${seg0.footer.ticks} ticks; segment 1: ticks ${seg1.header.startTick + 1}..${seg1.header.startTick + seg1.ticks.length}`);

  expect(errors, errors.join('\n')).toEqual([]);
});

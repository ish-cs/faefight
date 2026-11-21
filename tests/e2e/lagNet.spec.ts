import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

/**
 * Online under a simulated 120 ms RTT (+20 ms jitter) on the client's links (?rtt=&jitter=, netSim.ts):
 * the client's own shots show immediately (predicted) and the host's echo of each shot never plays a
 * second time. Logs input-to-effect latency predicted vs the old (host round trip) path.
 */
const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

type Me = { id: number; equipped: string; hotbar: (string | null)[]; inv: { weapons: Record<string, { mag: number }> } };
type Snap = { players: Me[] };
type ShotInfo = { predicted: number; confirmed: number; unpredicted: number; expired: number; inFlight: number; times: { predicted: number[]; applied: number[] } };

test.describe.configure({ mode: 'serial' });

test('120 ms RTT: own shots are predicted, echoes are not shown twice', async ({ context }) => {
  const errors: string[] = [];
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [tag, p] of [['A', a], ['B', b]] as const) {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${tag}: ${String(e)}`));
  }
  await a.goto('/?net=local&debug=1');
  await a.getByTestId('name-input').fill('Alice');
  await a.getByTestId('host-game').click();
  const code = (await a.getByTestId('lobby-code').textContent())!;
  await b.goto('/?net=local&debug=1&rtt=120&jitter=20');
  await b.getByTestId('name-input').fill('Bob');
  await b.getByTestId('code-input').fill(code);
  await b.getByTestId('join-game').click();
  await expect(a.getByTestId('seat-1')).toContainText('Bob');
  await a.getByTestId('start-match').click();
  await expect.poll(async () => (await dbg<Snap | null>(b, 'snapshot'))?.players.length ?? 0, { timeout: 30_000 }).toBe(2);

  // Host hands Bob a rifle; Bob picks it.
  await dbg(a, 'give', { weapons: { rifle: { mag: 25, spare: 50 } } }, 2);
  const meB = async () => (await dbg<Snap>(b, 'snapshot')).players.find((p) => p.id === 2)!;
  await expect.poll(async () => (await meB()).hotbar.indexOf('rifle'), { timeout: 10_000 }).toBeGreaterThanOrEqual(0);
  await b.bringToFront();
  await b.locator('canvas.game').click();
  await b.keyboard.press(`Digit${(await meB()).hotbar.indexOf('rifle') + 1}`);
  await expect.poll(async () => (await meB()).equipped, { timeout: 10_000 }).toBe('rifle');

  await b.mouse.move(640, 360);
  await b.mouse.down();
  await b.waitForTimeout(1500);
  await b.mouse.up();
  // Wait for every echo to come back.
  await expect.poll(async () => (await dbg<ShotInfo>(b, 'shotPredict')).inFlight, { timeout: 5_000 }).toBe(0);
  const s = await dbg<ShotInfo>(b, 'shotPredict');
  const mag = (await meB()).inv.weapons.rifle.mag;
  const n = Math.min(s.times.predicted.length, s.times.applied.length);
  const lat = Array.from({ length: n }, (_, i) => s.times.applied[i] - s.times.predicted[i]).sort((x, y) => x - y);
  console.log(`[lag-e2e] predicted ${s.predicted}, confirmed ${s.confirmed}, unpredicted ${s.unpredicted}, expired ${s.expired}, mag left ${mag}; ` +
    `host-echo latency after the predicted effect: median ${lat[n >> 1]?.toFixed(0)} ms, max ${lat[n - 1]?.toFixed(0)} ms`);
  expect(s.predicted).toBeGreaterThanOrEqual(5);
  // Every host shot matched a prediction (no effect played twice), at most one shot of difference at the edges.
  expect(s.confirmed).toBeGreaterThanOrEqual(s.predicted - 1);
  expect(s.unpredicted).toBeLessThanOrEqual(1);
  expect(25 - mag).toBe(s.confirmed + s.unpredicted);
  // The old path waited a round trip plus the snapshot buffer.
  expect(lat[n >> 1]).toBeGreaterThan(100);
  expect(errors, errors.join('\n')).toEqual([]);
});

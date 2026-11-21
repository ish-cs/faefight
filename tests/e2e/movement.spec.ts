import { expect, test, type Page } from '@playwright/test';
import { pressAndMeasure, release } from './predictHelpers';

const CI = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI;

type V = { x: number; y: number; z: number };
type Pred = { active: boolean; pos: V | null; seq: number; stats: { reconciles: number; snaps: number; lastError: number } | null; pending: number };
type Frames = { n: number; avg: number; p50: number; p95: number; p99: number; max: number };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

test('vs bot: movement is predicted locally — W moves you on the next frame, and the sim agrees', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?debug=1');
  await page.getByTestId('play-easy').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 30_000 });
  await expect.poll(async () => (await dbg<Pred>(page, 'predicted')).active, { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(500); // settle (spawn drop)

  const r = await pressAndMeasure(page);
  expect(r.frames).toBeLessThanOrEqual(2);
  expect(r.serverMovedFirst).toBe(false);

  // Keep walking for a second, stop, and check the sim ended up where we predicted.
  await page.waitForTimeout(1000);
  await release(page);
  await page.waitForTimeout(600);
  const pred = await dbg<Pred>(page, 'predicted');
  const snap = await dbg<{ players: { id: number; pos: V }[] }>(page, 'snapshot');
  const id = await dbg<number>(page, 'humanId');
  const server = snap.players.find((p) => p.id === id)!.pos;
  const gap = Math.hypot(pred.pos!.x - server.x, pred.pos!.y - server.y, pred.pos!.z - server.z);
  console.info(`[movement] predicted vs sim after stopping: ${(gap * 100).toFixed(2)} cm; reconciles ${pred.stats!.reconciles}, snaps ${pred.stats!.snaps}`);
  expect(gap).toBeLessThan(0.05);
  expect(pred.stats!.snaps).toBe(0);

  // Frame pacing over ~4 s of steady play while moving (W + strafing), after warm-up.
  await dbg(page, 'resetFrames');
  await page.keyboard.down('KeyW');
  for (const k of ['KeyA', 'KeyD', 'KeyA', 'KeyD']) { await page.keyboard.down(k); await page.waitForTimeout(1000); await page.keyboard.up(k); }
  await page.keyboard.up('KeyW');
  const f = await dbg<Frames>(page, 'frames');
  console.info(`[movement] frame ms over ${f.n} frames: avg ${f.avg.toFixed(2)} p50 ${f.p50.toFixed(2)} p95 ${f.p95.toFixed(2)} p99 ${f.p99.toFixed(2)} max ${f.max.toFixed(2)}`);
  // Frame pacing needs a GPU: CI renders WebGL2 in software (SwiftShader), where 60 fps isn't possible.
  if (!CI) {
    expect(f.n).toBeGreaterThan(120);
    expect(f.p50).toBeLessThan(1000 / 55); // ≥ 60 fps (vsync-limited) on this machine
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

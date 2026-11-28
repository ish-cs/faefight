import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

type Dbg = Record<string, (...a: unknown[]) => unknown>;
const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as unknown as { __faefight: Dbg }).__faefight[f as string](...(a as unknown[])) as T, [fn, args] as const);
type Snap = { time: number; winner: number | null; players: { id: number }[] };

/** Mean luminance (0–255) of the world region (upper middle: above the hands/weapon, below the top HUD). */
async function worldLum(page: Page): Promise<number> {
  const vp = page.viewportSize()!;
  const png = await page.screenshot({ clip: { x: vp.width * 0.15, y: vp.height * 0.12, width: vp.width * 0.5, height: vp.height * 0.4 } });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4);
  }, png.toString('base64'));
}

/**
 * Reported on prod: a black 3D world (HUD and hands fine) ~25 s into a match started with Play again in the same page.
 * Every match makes a new renderer + GPUDevice: each match's world must be drawn, the previous device destroyed, and
 * no pipeline built against the torn-down match's targets (endOfMatch.spec.ts covers leaving during the warm-up).
 */
test('Play again ×2: the world is drawn every match, the previous match\'s GPU device is destroyed, no errors', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // every GPUDevice the page makes, and how it was lost (null = still alive)
  await page.addInitScript(() => {
    const devs: { lost: string | null }[] = [];
    (window as unknown as { __devs: typeof devs }).__devs = devs;
    // (no WebGPU types in this project: the adapter prototype is reached untyped)
    type Dev = { lost: Promise<{ reason?: string }> };
    const proto = (globalThis as unknown as { GPUAdapter: { prototype: { requestDevice(...a: unknown[]): Promise<Dev> } } }).GPUAdapter.prototype;
    const req = proto.requestDevice;
    proto.requestDevice = async function (this: unknown, ...a: unknown[]) {
      const d = await req.apply(this, a);
      const rec = { lost: null as string | null };
      devs.push(rec);
      void d.lost.then((l) => { rec.lost = l.reason ?? 'unknown'; });
      return d;
    };
  });
  const devices = () => page.evaluate(() => (window as unknown as { __devs: { lost: string | null }[] }).__devs.map((d) => d.lost));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1&bots=3');
  await page.getByTestId('play-hard').click();
  const lums: number[] = [];
  for (let m = 1; m <= 3; m++) {
    await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 120_000 });
    await expect.poll(async () => { const s = await dbg<Snap | null>(page, 'snapshot'); return !!s && s.winner === null && s.time > 1; }, { timeout: 60_000 }).toBe(true);
    await page.waitForTimeout(2000);
    lums.push(await worldLum(page));
    await page.screenshot({ path: info.outputPath(`match${m}.png`) });
    // the earlier matches' devices are gone; only this match's is alive
    await expect.poll(devices, { timeout: 10_000 }).toEqual([...Array(m - 1).fill('destroyed'), null]);
    if (m === 3) break;
    const me = await dbg<number>(page, 'humanId');
    for (const p of (await dbg<Snap>(page, 'snapshot')).players) if (p.id !== me) await dbg(page, 'eliminate', p.id);
    await expect(page.getByTestId('end-screen')).toContainText('VICTORY', { timeout: 20_000 });
    await page.getByTestId('play-again').click();
  }
  console.log(`[nextMatch] world luminance per match ${lums.map((l) => l.toFixed(1)).join(' / ')}`);
  for (const l of lums) expect(l).toBeGreaterThan(lums[0] * 0.5);
  expect(lums[0]).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

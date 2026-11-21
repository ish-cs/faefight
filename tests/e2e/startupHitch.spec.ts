import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

/**
 * Start-of-match hitches: 8-player vs-bot match on high. For the first 20 s after the loading screen
 * hides, the player looks all the way around, then fires/throws/places every hotbar item and switches to
 * first person — everything that used to build shaders on first sight. Fails if a frame takes over 100 ms.
 * Best of 2 (the machine running the suite may be busy). Also fails if any render pipeline is built after the reveal
 * (load-independent: the warm-up compiles everything behind the loading screen; pre-fix code built 22 here).
 */
const WINDOW_MS = 20_000;
const MAX_FRAME_MS = 100;

type Result = { maxFrame: number; over50: number; frames: number; pipelines: string[] };

async function attempt(page: Page): Promise<Result> {
  await page.addInitScript(() => {
    localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: 'high', resolutionScale: 1, frameCap: 0, dynamicResolution: false } }));
    const w = window as unknown as { __frames: number[]; __pipes: [number, string][] };
    w.__frames = [];
    w.__pipes = [];
    const loop = (t: number) => { w.__frames.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const dev = (window as unknown as { GPUDevice?: { prototype: Record<string, (...a: unknown[]) => unknown> } }).GPUDevice;
    if (dev) for (const name of ['createRenderPipeline', 'createRenderPipelineAsync']) {
      const orig = dev.prototype[name];
      dev.prototype[name] = function (this: unknown, ...a: unknown[]) { w.__pipes.push([performance.now(), (a[0] as { label?: string } | undefined)?.label ?? '']); return orig.apply(this, a); };
    }
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?debug=1&bots=7');
  await page.getByTestId('play-hard').click();
  await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 60_000 });
  await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 30_000 });
  const hideAt = await page.evaluate(() => {
    const ev = (window as unknown as { __faefightLoading: { events(): { kind: string; t: number }[] } }).__faefightLoading.events();
    return ev.filter((e) => e.kind === 'hide').at(-1)!.t;
  });
  const end = Date.now() + WINDOW_MS;
  const dbg = (fn: string, ...a: unknown[]) => page.evaluate(([f, x]) =>
    (window as unknown as { __faefight: Record<string, (...y: unknown[]) => unknown> }).__faefight[f as string](...(x as unknown[])), [fn, a] as const);

  await page.mouse.move(640, 360);
  await page.locator('canvas.game').click();
  const ammo = { mag: 30, spare: 90 };
  await dbg('give', { weapons: { pistol: ammo, smg: ammo, shotgun: ammo, rifle: ammo, rocket: { mag: 1, spare: 5 } }, grenades: 3, charges: 2, pieces: { wood: 5, steel: 5 }, medkits: 1 });
  const sweep = async (ms: number) => {
    for (let t = 0; t < ms; t += 50) {
      await page.evaluate((k) => {
        const i = (window as unknown as { __faefight: { input: { yaw: number; pitch: number } } }).__faefight.input;
        i.yaw = k * Math.PI * 2; i.pitch = Math.sin(k * 12) * 0.35;
      }, t / ms);
      await page.waitForTimeout(50);
    }
  };
  for (const pass of [0, 1]) {
    if (Date.now() > end) break;
    await sweep(2500);
    for (let slot = 1; slot <= 9 && Date.now() < end; slot++) {
      await page.keyboard.press(`Digit${slot}`);
      await page.waitForTimeout(120);
      await page.mouse.down();
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForTimeout(100);
    }
    if (!pass) await page.keyboard.press('KeyV'); // first person for the second pass
  }
  await page.waitForTimeout(Math.max(0, end - Date.now()));

  return page.evaluate(([h, win]) => {
    const w = window as unknown as { __frames: number[]; __pipes: [number, string][] };
    const ints: number[] = [];
    for (let i = 1; i < w.__frames.length; i++) if (w.__frames[i] >= h && w.__frames[i] < h + win) ints.push(w.__frames[i] - w.__frames[i - 1]);
    return {
      maxFrame: Math.max(...ints), over50: ints.filter((x) => x > 50).length, frames: ints.length,
      pipelines: w.__pipes.filter(([t]) => t >= h).map(([, l]) => l),
    };
  }, [hideAt, WINDOW_MS] as const);
}

test('no frame over 100 ms in the first 20 s of a match (best of 2)', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const results: Result[] = [];
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    const r = await attempt(page);
    await ctx.close();
    results.push(r);
    console.info(`[startupHitch] attempt ${i + 1}: ${r.frames} frames, max ${r.maxFrame.toFixed(0)} ms, ${r.over50} over 50 ms, `
      + `${r.pipelines.length} pipelines after reveal${r.pipelines.length ? `: ${r.pipelines.slice(0, 8).join(', ')}` : ''}`);
    if (r.maxFrame <= MAX_FRAME_MS) break;
  }
  // Deterministic (load-independent) half: nothing compiles on first sight after the reveal.
  for (const r of results) expect(r.pipelines, 'pipelines built after the loading screen hid').toEqual([]);
  expect(Math.min(...results.map((r) => r.maxFrame)), JSON.stringify(results.map((r) => ({ max: r.maxFrame, pipes: r.pipelines.length })))).toBeLessThanOrEqual(MAX_FRAME_MS);
});

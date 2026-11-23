import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

// The free neural commentary voice (Kokoro-82M in a worker): it loads (~92 MB the first time, then cached),
// lines are synthesized fast enough to start within about a second, and talking costs no frame rate.
// Local only: it downloads the model and plays a match in real time.
test.skip(ON_CI, NEEDS_GPU);

type Voice = { state: string; neural: boolean; synthMs: number[] };
type Frames = { p50: number; p95: number; n: number; cpuAvg: number };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api?.[f as string] ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

test('neural commentary voice: loads, speaks promptly, and costs no frame rate', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (/\[(commentary|kokoro)\]/.test(m.text())) console.log(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  // Worker logs (synthesis timings) come through the worker's own console.
  page.on('worker', (w) => w.on('console', (m) => { if (/\[kokoro\]/.test(m.text())) console.log(m.text()); }));
  await page.addInitScript(() => {
    const k = 'faefight.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    s.audio = { ...(s.audio ?? {}), commentaryOn: true, captions: true, commentarySpectate: true, voiceEngine: 'neural' };
    localStorage.setItem(k, JSON.stringify(s));
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  // TTS_QS picks the engine config to measure, e.g. "ttsDevice=webgpu&ttsDtype=fp16" (default: wasm q8).
  const qs = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TTS_QS ?? '';
  await page.goto(`/?debug=1&watch=1&bots=6&diff=hard${qs ? `&${qs}` : ''}`);
  const menu = page.getByTestId('play-easy');
  if (await menu.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await menu.click();
    await expect(page.getByTestId('cash')).toHaveText(/\$\d+/, { timeout: 60_000 });
    await page.locator('canvas.game').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type('/spectate');
    await page.keyboard.press('Enter');
  }
  const t0 = Date.now();
  await expect.poll(async () => (await dbg<Voice>(page, 'commentaryVoice'))?.state, { timeout: 300_000, intervals: [2000] }).toBe('ready');
  console.log(`[voice e2e] neural voice ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // Frame rate with the commentator off vs talking (neural), interleaved: off, on, off, on (15 s each).
  const phase = async (on: boolean) => {
    await dbg(page, 'commentaryOn', on);
    await page.waitForTimeout(3000);
    await dbg(page, 'resetFrames');
    await page.waitForTimeout(15_000);
    const f = await dbg<Frames>(page, 'frames');
    const gpu = await dbg<number>(page, 'gpuFps');
    return { on, p50: f.p50, p95: f.p95, cpu: f.cpuAvg, gpuFps: gpu };
  };
  const runs = [await phase(false), await phase(true), await phase(false), await phase(true)];
  for (const r of runs) console.log(`[voice e2e] commentary ${r.on ? 'ON ' : 'off'}  frame p50 ${r.p50.toFixed(2)} ms  p95 ${r.p95.toFixed(2)} ms  main-thread ${r.cpu.toFixed(2)} ms  gpu ${r.gpuFps.toFixed(1)} fps`);
  const v = (await dbg<Voice>(page, 'commentaryVoice'))!;
  const ms = [...v.synthMs].sort((a, b) => a - b);
  console.log(`[voice e2e] ${ms.length} lines synthesized; synth ms p50 ${ms[Math.floor(ms.length / 2)]} max ${ms.at(-1)}`);
  const log = (await dbg<{ text: string; persona: string }[]>(page, 'commentary')) ?? [];
  for (const l of log.slice(-12)) console.log(`[line] ${l.persona} ${l.text}`);

  expect(errors, errors.join('\n')).toEqual([]);
  expect(v.neural).toBe(true);
  expect(ms.length).toBeGreaterThan(3);
  // Fast enough to start within about a second of the event.
  expect(ms[Math.floor(ms.length / 2)]).toBeLessThan(1500);
  // No visible frame cost: median frame time with the voice within 5% (+0.3 ms) of without.
  const off = (runs[0].p50 + runs[2].p50) / 2, on = (runs[1].p50 + runs[3].p50) / 2;
  expect(on).toBeLessThan(off * 1.05 + 0.3);
});

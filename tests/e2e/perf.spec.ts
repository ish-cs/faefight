import { expect, test, type Page } from '@playwright/test';
import { NEEDS_GPU, ON_CI } from './gpu';

test.skip(ON_CI, NEEDS_GPU);

/**
 * Client frame-cost benchmark (run with PERF=1): 8-player solo match (7 hard bots), ~100 pieces placed
 * around you, a few seconds of moving/looking around, on the high and ultra presets at devicePixelRatio 2.
 * Prints frame interval (vsync-bound), main-thread CPU per frame, GPU time (timestamp queries), draw
 * calls, triangles and the dynamic render scale. Skipped by default: numbers depend on the machine.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
test.skip(!env.PERF, 'perf benchmark: set PERF=1');
// Vsync off + no frame-rate limit: the frame interval is then the real per-frame cost (CPU or GPU bound), not 16.7 ms.
test.use({
  deviceScaleFactor: 2, viewport: { width: 1600, height: 900 },
  launchOptions: { args: ['--enable-unsafe-webgpu', ...(env.PERF_VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])] },
});

type V = { x: number; y: number; z: number };
type Frames = { n: number; avg: number; p50: number; p95: number; p99: number; max: number; cpuAvg: number; cpuP95: number; cpuP99: number; hitches?: number };

const dbg = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => {
    const api = (window as unknown as { __faefight?: Record<string, (...x: unknown[]) => unknown> }).__faefight;
    return (api?.[f as string] ? api[f as string](...(a as unknown[])) : null) as T;
  }, [fn, args] as const);

for (const quality of ['high', 'ultra'] as const) {
  test(`perf: 8 players, 100 pieces, ${quality}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(([q, d]) => {
      localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: q, showFps: true, resolutionScale: 1, frameCap: 0, dynamicResolution: d } }));
    }, [quality, !!env.PERF_DYNRES] as const);
    await page.goto('/?debug=1&bots=7&gputime=1');
    await page.getByTestId('play-hard').click();
    await expect(page.getByTestId('cash')).toHaveText('$50', { timeout: 45_000 });
    const id = await dbg<number>(page, 'humanId');
    const me = (await dbg<{ players: { id: number; pos: V }[] }>(page, 'snapshot')).players.find((p) => p.id === id)!;
    await dbg(page, 'pieces', me.pos.x, me.pos.z, 100);
    await expect.poll(async () => (await dbg<{ pieces: unknown[] }>(page, 'snapshot')).pieces.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(90);
    await page.waitForTimeout(3000); // warm-up: shader compiles for the new pieces, bots leave their bunkers

    const cdp = env.PERF_PROFILE ? await page.context().newCDPSession(page) : null;
    if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    await dbg(page, 'resetFrames');
    await page.locator('canvas.game').click(); // pointer lock may fail headless; mouse look via keys isn't needed
    await page.keyboard.down('KeyW');
    for (const k of ['KeyA', 'KeyD', 'KeyA', 'KeyD', 'KeyA', 'KeyD']) { await page.keyboard.down(k); await page.waitForTimeout(1000); await page.keyboard.up(k); }
    await page.keyboard.up('KeyW');
    if (cdp) {
      type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount: number };
      const { profile } = await cdp.send('Profiler.stop') as unknown as { profile: { nodes: Node[]; samples: number[] } };
      const self = new Map<string, number>();
      for (const n of profile.nodes) {
        const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`;
        self.set(k, (self.get(k) ?? 0) + n.hitCount);
      }
      const total = profile.samples.length;
      // Who calls the hottest native (writeBuffer etc.): 4-frame caller chains.
      const parent = new Map<number, Node>();
      for (const n of profile.nodes as (Node & { children?: number[] })[]) for (const c of n.children ?? []) parent.set(c, n);
      const chains = new Map<string, number>();
      for (const n of profile.nodes) {
        if (n.callFrame.functionName !== 'writeBuffer' || !n.hitCount) continue;
        const parts: string[] = [];
        for (let p = parent.get(n.id), i = 0; p && i < 5; p = parent.get(p.id), i++) parts.push(`${p.callFrame.functionName}:${p.callFrame.lineNumber + 1}`);
        const k = parts.join(' < ');
        chains.set(k, (chains.get(k) ?? 0) + n.hitCount);
      }
      console.info([...chains].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `WB ${((100 * v) / total).toFixed(1)}% ${k}`).join('\n'));
      console.info([...self].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${((100 * v) / total).toFixed(1)}% ${k}`).join('\n'));
    }
    const f = await dbg<Frames>(page, 'frames');
    const gpu = await dbg<{ n: number; avg: number; p95: number }>(page, 'gpuMs');
    const info = await dbg<{ backend: string; drawCalls: number; triangles: number }>(page, 'renderInfo');
    const scale = await dbg<{ dyn: number; pixelRatio: number } | null>(page, 'renderScale');
    const line = `[perf ${quality}] ${info.backend} frames ${f.n}: interval avg ${f.avg.toFixed(2)} p95 ${f.p95.toFixed(2)} p99 ${f.p99.toFixed(2)} ms | `
      + `cpu avg ${f.cpuAvg.toFixed(2)} p95 ${f.cpuP95.toFixed(2)} ms | gpu avg ${gpu.avg.toFixed(2)} p95 ${gpu.p95.toFixed(2)} ms (${gpu.n}) | `
      + `draws ${info.drawCalls} tris ${info.triangles} | render scale ${scale ? `${scale.dyn} (pixel ratio ${scale.pixelRatio.toFixed(2)})` : 'n/a'} | hitches>25ms ${f.hitches ?? 'n/a'}`;
    console.info(line);
    if (env.PERF_SCENE) console.info(await page.evaluate(() => {
      const r = (window as unknown as { __faefight: { renderer: { scene: { traverse(f: (o: any) => void): void } } } }).__faefight.renderer;
      const by = new Map<string, { n: number; vis: number; tris: number; inst: number; shadow: number }>();
      r.scene.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isLine) return;
        const g = o.geometry, tris = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
        let k = (o.name || o.parent?.name || o.type).replace(/[:#].*$/, '').slice(0, 24);
        if (o.isSkinnedMesh) k = 'skinned:' + k;
        const e = by.get(k) ?? { n: 0, vis: 0, tris: 0, inst: 0, shadow: 0 };
        let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
        e.n++; if (vis) { e.vis++; e.tris += tris * (o.isInstancedMesh ? o.count : 1); }
        if (o.isInstancedMesh) e.inst += o.count; if (o.castShadow && vis) e.shadow++;
        by.set(k, e);
      });
      return [...by].sort((a, b) => b[1].tris - a[1].tris).slice(0, 30).map(([k, e]) => `${k}: n${e.n} vis${e.vis} tris${Math.round(e.tris)} inst${e.inst} shadow${e.shadow}`).join('\n');
    }));
    expect(f.n).toBeGreaterThan(100);
    // Experiments: PERF_EVAL='<js using r = renderer>' runs, then 3 s more are measured.
    for (const code of (env.PERF_EVAL ?? '').split(';;').filter(Boolean)) {
      await page.evaluate((c) => { const r = (window as any).__faefight.renderer; new Function('r', c)(r); }, code);
      await page.waitForTimeout(500);
      await dbg(page, 'resetFrames');
      await page.waitForTimeout(3000);
      const g = await dbg<Frames>(page, 'frames');
      const i2 = await dbg<{ drawCalls: number; triangles: number }>(page, 'renderInfo');
      console.info(`[perf ${quality} eval] ${code.slice(0, 60)} → interval avg ${g.avg.toFixed(2)} p95 ${g.p95.toFixed(2)} cpu avg ${g.cpuAvg.toFixed(2)} | draws ${i2.drawCalls} tris ${i2.triangles}`);
    }
  });
}

// Match-load + view-change hitch harness: click Play → loading screen → reveal → first N s, then the quality key (P)
// cycled through every preset. Reports long tasks (>50 ms) and frame gaps on the game page, on a second "other tab"
// page (does the GPU/browser stay usable?), peak JS heap, GPU bytes allocated, pipelines compiled per phase and
// steady-state fps. Optional CPU profile attribution (--profile=1).
// Needs a server at GAME_URL (prod build: perfAB.mjs '<label>|<dir>|<port>|--script=loadSpikes.mjs|prod'); run under heavy.sh.
//   node tests/visual/loadSpikes.mjs [--quality=high] [--after=10] [--toggles=3] [--dpr=2] [--profile=1] [--label=x]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const quality = arg('quality', 'high');
const AFTER = Number(arg('after', '10'));
const TOGGLES = Number(arg('toggles', '3'));
const dpr = Number(arg('dpr', '2'));
const prof = arg('profile', '0') === '1';
const label = arg('label', 'run');
/** Chrome CPU throttling (e.g. 4 ≈ a Mac in Low Power Mode) for the game page */
const throttle = Number(arg('throttle', '1'));

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
const page = await ctx.newPage();
page.setDefaultTimeout(180_000);
const errors = [];
const logs = [];
const errSeen = new Set();
const errAt = (t) => { const k = t.replace(/_\d+/g, '').slice(0, 140); if (!errSeen.has(k)) { errSeen.add(k); errors.push(`${((Date.now() - t0wall) / 1000).toFixed(1)}s ${k}`); } };
const t0wall = Date.now();
page.on('pageerror', (e) => errAt(String(e)));
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error') errAt(t); if (/^\[(warmup|loading|world\/sky)/.test(t)) logs.push(t.slice(0, 200)); });

await page.addInitScript((q) => {
  try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: q, showFps: true, resolutionScale: 1, frameCap: 0, dynamicResolution: true } })); } catch { /* fresh */ }
  const w = window;
  w.__ls = { raf: [], long: [], heap: [], pipes: [], gpuBytes: 0, gpuPeak: 0, marks: [] };
  const loop = (t) => { w.__ls.raf.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { const m = performance.memory; if (m) w.__ls.heap.push([performance.now(), m.usedJSHeapSize]); }, 100);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__ls.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch { /* none */ }
  if (window.GPUDevice) {
    for (const name of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync']) {
      const orig = GPUDevice.prototype[name];
      GPUDevice.prototype[name] = function (desc) { w.__ls.pipes.push([performance.now(), name.endsWith('Async') ? 'async' : 'sync', (desc?.label ?? '').replace(/^renderPipeline_/, '').slice(0, 40)]); return orig.call(this, desc); };
    }
    const BPP = { r8unorm: 1, rg8unorm: 2, r16float: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, rgba16float: 8, rg16float: 4, r32float: 4, rgba32float: 16, depth24plus: 4, 'depth24plus-stencil8': 4, depth32float: 4, depth16unorm: 2 };
    const live = new WeakMap();
    const add = (o, b) => { live.set(o, b); w.__ls.gpuBytes += b; w.__ls.gpuPeak = Math.max(w.__ls.gpuPeak, w.__ls.gpuBytes); };
    const ct = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (d) {
      const t = ct.call(this, d);
      const s = d.size, wd = s.width ?? s[0], ht = s.height ?? s[1] ?? 1, ly = s.depthOrArrayLayers ?? s[2] ?? 1;
      const bpp = BPP[d.format] ?? (/bc|astc|etc/.test(d.format) ? 1 : 4);
      add(t, wd * ht * ly * bpp * (d.sampleCount ?? 1) * ((d.mipLevelCount ?? 1) > 1 ? 4 / 3 : 1));
      return t;
    };
    const cb = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (d) { const b = cb.call(this, d); add(b, d.size); return b; };
    for (const T of [GPUTexture, GPUBuffer]) {
      const dz = T.prototype.destroy;
      T.prototype.destroy = function () { const b = live.get(this); if (b) { w.__ls.gpuBytes -= b; live.delete(this); } return dz.call(this); };
    }
  }
}, quality);

// The "other tab": a plain page in the same browser animating every frame. Gaps here = the browser itself stalls.
const other = await ctx.newPage();
await other.setContent('<div id=b style="width:50px;height:50px;background:red"></div>');
await other.evaluate(() => { window.__raf = []; const l = (t) => { window.__raf.push(t); document.getElementById('b').style.transform = `translateX(${t % 300}px)`; requestAnimationFrame(l); }; requestAnimationFrame(l); });
const otherOrigin = await other.evaluate(() => performance.timeOrigin);

await page.goto(`${url}/?debug=1&bots=7`);
await page.bringToFront();
const pageOrigin = await page.evaluate(() => performance.timeOrigin);
let cdp = null;
if (throttle > 1) { const t = await ctx.newCDPSession(page); await t.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
if (prof) { cdp = await ctx.newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
const profStart = await page.evaluate(() => performance.now());
console.error(`[t] click at ${((Date.now() - t0wall) / 1000).toFixed(1)}s`);
await page.getByTestId('play-hard').click();
const clickAt = await page.evaluate(() => performance.now());
await page.waitForFunction((c) => window.__faefightLoading?.events().some((e) => e.kind === 'hide' && e.t > c), clickAt, { timeout: 120_000 });
const phases = await page.evaluate(() => window.__faefightLoading.events().map((e) => ({ t: e.t, kind: e.kind, phase: e.phase, label: e.label })));
const hideAt = await page.evaluate(() => [...window.__faefightLoading.events()].reverse().find((e) => e.kind === 'hide').t);
await page.waitForTimeout(Math.max(0, hideAt + AFTER * 1000 - (await page.evaluate(() => performance.now()))));

// steady state: game fps over 3 s
await page.evaluate(() => window.__faefight.resetFrames());
await page.waitForTimeout(3000);
const steady = await page.evaluate(() => window.__faefight.frames());

// view change: P (quality key) through every preset, 4 s apart
const toggles = [];
await page.locator('canvas.game').focus();
for (let i = 0; i < TOGGLES; i++) {
  const t = await page.evaluate(() => performance.now());
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(4000);
  toggles.push([t, await page.evaluate(() => document.querySelector('[data-testid=quality-toast]')?.textContent ?? '?')]);
}
const endAt = await page.evaluate(() => performance.now());
const st = await page.evaluate(() => window.__ls);
const oraf = (await other.evaluate(() => window.__raf)).map((t) => t + otherOrigin - pageOrigin); // page clock
const profile = cdp ? (await cdp.send('Profiler.stop')).profile : null;
await browser.close();

const gaps = (ts) => { const g = []; for (let i = 1; i < ts.length; i++) g.push([ts[i], ts[i] - ts[i - 1]]); return g; };
const win = (lo, hi) => {
  const long = st.long.filter(([t]) => t >= lo && t < hi).map(([, d]) => d);
  const fr = gaps(st.raf).filter(([t]) => t >= lo && t < hi).map(([, d]) => d);
  const of = gaps(oraf).filter(([t]) => t >= lo && t < hi).map(([, d]) => d);
  const heap = st.heap.filter(([t]) => t >= lo && t < hi).map(([, b]) => b);
  return {
    longN: long.length, longMax: Math.round(Math.max(0, ...long)), longSum: Math.round(long.reduce((a, b) => a + b, 0)),
    frameMax: Math.round(Math.max(0, ...fr)), frames50: fr.filter((d) => d > 50).length,
    otherMax: Math.round(Math.max(0, ...of)), other50: of.filter((d) => d > 50).length,
    heapPeakMB: +(Math.max(0, ...heap) / 1048576).toFixed(0),
    pipes: st.pipes.filter(([t]) => t >= lo && t < hi).length, sync: st.pipes.filter(([t, k]) => t >= lo && t < hi && k === 'sync').length,
  };
};
const tv = [];
for (let i = 0; i < toggles.length; i++) tv.push({ to: toggles[i][1], ...win(toggles[i][0], (toggles[i + 1]?.[0] ?? endAt)) });
const out = {
  label, quality, dpr, throttle,
  loadMs: Math.round(hideAt - clickAt),
  loading: win(clickAt, hideAt),
  first10s: win(hideAt, hideAt + AFTER * 1000),
  loadTo10s: win(clickAt, hideAt + AFTER * 1000),
  steadyFps: +(1000 / steady.avg).toFixed(1), steadyCpuMs: +steady.cpuAvg.toFixed(2),
  gpuPeakMB: +(st.gpuPeak / 1048576).toFixed(0),
  toggles: tv,
  syncLoading: (() => { const c = {}; for (const [t, k, l] of st.pipes) if (t >= clickAt && t < hideAt && k === 'sync') { const n = l.replace(/_\d+$/, ''); c[n] = (c[n] ?? 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}×${v}`).join(' '); })(),
  syncToggles: (() => { const c = {}; for (const [t, k, l] of st.pipes) if (t >= (toggles[0]?.[0] ?? endAt) && k === 'sync') { const n = l.replace(/_\d+$/, ''); c[n] = (c[n] ?? 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}×${v}`).join(' '); })(),
  longList: st.long.filter(([t]) => t >= clickAt && t < hideAt + AFTER * 1000).map(([t, d]) => `${((t - clickAt) / 1000).toFixed(2)}s:${Math.round(d)}`).join(' '),
  loadEvents: phases.filter((e) => e.t >= clickAt).map((e) => `${((e.t - clickAt) / 1000).toFixed(2)} ${e.kind} ${e.phase ?? ''} ${e.label ?? ''}`).filter((x, i, a) => i === 0 || x.split(' ').slice(1, 3).join(' ') !== a[i - 1].split(' ').slice(1, 3).join(' ')).join(' | '),
  logs: logs.slice(-12), errors: errors.slice(0, 12),
};
console.log(JSON.stringify(out));

if (profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (x) => `${x.callFrame.functionName || '(anon)'} ${x.callFrame.url.replace(/^.*\/(src|node_modules|assets)\//, '$1/').replace(/\?.*$/, '')}:${x.callFrame.lineNumber + 1}`;
  const profT0 = profile.startTime;
  // attribute only samples inside long tasks
  const inLong = (t) => st.long.some(([s, d]) => t >= s && t <= s + d);
  const windows = [['LOADING long tasks', clickAt - 2000, hideAt], ['REVEAL+0..10s long tasks', hideAt, hideAt + AFTER * 1000], ['P toggles long tasks', toggles[0]?.[0] ?? endAt, endAt]];
  for (const [name, lo, hi] of windows) {
    let ts = profT0, n = 0;
    const self = new Map(), incl = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      ts += profile.timeDeltas[i];
      const tms = (ts - profT0) / 1000 + profStart;
      if (tms < lo || tms >= hi || !inLong(tms)) continue;
      const node = byId.get(profile.samples[i]);
      if (/^\((idle|program)\)$/.test(node.callFrame.functionName)) continue;
      n++;
      self.set(key(node), (self.get(key(node)) ?? 0) + 1);
      const seen = new Set();
      for (let id = node.id; id; id = parent.get(id)) { const k = key(byId.get(id)); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + 1); } }
    }
    console.log(`\n== ${name}: ${(n * 0.5).toFixed(0)} ms JS`);
    console.log('SELF\n' + [...self].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${(v * 0.5).toFixed(0)}ms ${k}`).join('\n'));
    console.log('INCL\n' + [...incl].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${(v * 0.5).toFixed(0)}ms ${k}`).join('\n'));
  }
}

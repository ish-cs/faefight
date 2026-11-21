// Start-of-match hitch timeline: per-second frame interval stats for the first N s after the loading
// screen fades, long tasks before/after, the loading-screen event log, and (with `profile`) the JS
// functions that ran inside frames over 50 ms.
// Needs `pnpm vite --port <port>`; `node tests/visual/startup.mjs <port> <high|ultra|...> [profile] [secs]`.
import { chromium } from '@playwright/test';

const [port = '5339', quality = 'high', prof = '', secsArg = '30'] = process.argv.slice(2);
const SECS = Number(secsArg);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', ...(process.env.NOVSYNC ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/^\[(warmup|loading|world|render|preload|startup|char|audio|pbr|game)/i.test(t) || m.type() === 'error') logs.push(t.slice(0, 220));
});
await page.addInitScript((q) => {
  localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: q, showFps: false, resolutionScale: 1, frameCap: 0, dynamicResolution: false } }));
  const w = window;
  w.__st = { frames: [], long: [] };
  const loop = (t) => { w.__st.frames.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // Every GPU object creation / upload, timestamped: pipelines and shader modules created after the reveal
  // are first-use compiles the warm-up missed (each one stalls the GPU process while Metal compiles it).
  w.__gpu = [];
  if (window.GPUDevice) {
    for (const name of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync', 'createShaderModule', 'createTexture']) {
      const orig = GPUDevice.prototype[name];
      GPUDevice.prototype[name] = function (desc) {
        const t = performance.now();
        const r = orig.call(this, desc);
        w.__gpu.push([t, name, (desc?.label ?? '').slice(0, 60), performance.now() - t, desc?.size ? `${desc.size.width ?? desc.size[0]}x${desc.size.height ?? desc.size[1]}` : '']);
        return r;
      };
    }
    for (const name of ['writeTexture', 'copyExternalImageToTexture']) {
      const orig = GPUQueue.prototype[name];
      GPUQueue.prototype[name] = function (...a) {
        const t = performance.now();
        const r = orig.apply(this, a);
        w.__gpu.push([t, name, '', performance.now() - t, '']);
        return r;
      };
    }
  }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__st.long.push([Math.round(e.startTime), Math.round(e.duration)]); })
      .observe({ type: 'longtask', buffered: true });
  } catch { /* no longtask support */ }
}, quality);
await page.goto(`http://localhost:${port}/?debug=1&bots=7&gputime=1&warmframes=${process.env.WF ?? 3}`);
if (process.env.STYLE) await page.addStyleTag({ content: process.env.STYLE }); // experiments, e.g. STYLE='.hud{display:none}'
await page.getByTestId('play-hard').click();
const clickAt = await page.evaluate(() => performance.now());
let cdp = null;
if (prof) {
  cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
}
const profStart = await page.evaluate(() => performance.now());
await page.waitForFunction((c) => window.__faefightLoading?.events().some((e) => e.kind === "hide" && e.t > c), clickAt, { timeout: 90_000 });
const events = await page.evaluate(() => window.__faefightLoading.events());
const hideT = [...events].reverse().find((e) => e.kind === 'hide').t;
// Once a second: main-thread CPU per frame, GPU time (timestamp queries), draw calls, pieces, sim clock.
await page.evaluate(() => {
  const f = window.__faefight;
  window.__per = [];
  f.resetFrames();
  setInterval(() => {
    const fr = f.frames(), g = f.gpuMs(), ri = f.renderInfo(), s = f.snapshot();
    window.__per.push(`cpu p95 ${fr.cpuP95.toFixed(1)} p99 ${fr.cpuP99.toFixed(1)} | gpu avg ${g.avg.toFixed(1)} p95 ${g.p95.toFixed(1)} | draws ${ri.drawCalls} tris ${(ri.triangles / 1e6).toFixed(2)}M | pieces ${s?.pieces.length} simT ${s?.time.toFixed(1)}`);
    f.resetFrames();
  }, 1000);
});
const endAt = Date.now() + SECS * 1000 + 300;
// PLAY=1: what a player does in the first seconds — look all around, fire every weapon, throw, place
// pieces, switch to first person and do it again (with sights). Anything the warm-up missed compiles here.
if (process.env.PLAY) {
  const dbg = (fn, ...a) => page.evaluate(([f, x]) => window.__faefight[f](...x), [fn, a]);
  const mark = (label) => page.evaluate((l) => window.__gpu.push([performance.now(), 'mark', l, 0, '']), label);
  // Which object / render target / camera each new pipeline is for.
  await page.evaluate(() => {
    const be = window.__faefight.renderer.gpu.backend;
    const orig = be.createRenderPipeline.bind(be);
    be.createRenderPipeline = (ro, promises) => {
      const rt = ro.context.renderTarget;
      window.__gpu.push([performance.now(), 'mark', `  ↳ ${ro.object.name || ro.object.type} mat=${ro.material.name || ro.material.type} rt=${rt ? `${rt.width}x${rt.height}s${rt.samples}${rt.textures.length > 1 ? `mrt${rt.textures.length}` : ''}${rt.depthTexture?.isArrayTexture || rt.depthTexture?.isDepthArrayTexture ? 'array' : ''}` : 'canvas'} cam=${ro.camera.type} light=${ro.lightsNode?.getCacheKey?.()}`, 0, '']);
      return orig(ro, promises);
    };
  });
  await page.mouse.move(800, 450);
  await page.locator('canvas.game').click();
  const ammo = { mag: 30, spare: 90 };
  await dbg('give', { weapons: { pistol: ammo, smg: ammo, shotgun: ammo, rifle: ammo, rocket: { mag: 1, spare: 5 } }, grenades: 3, charges: 2, pieces: { wood: 5, steel: 5 }, medkits: 1 });
  await page.waitForTimeout(300);
  const sweep = async (ms) => {
    for (let t = 0; t < ms; t += 50) {
      await page.evaluate((k) => { const i = window.__faefight.input; i.yaw = k * Math.PI * 2; i.pitch = Math.sin(k * 12) * 0.35; }, t / ms);
      await page.waitForTimeout(50);
    }
  };
  for (const pass of [0, 1]) {
    await mark(`sweep${pass}`);
    await sweep(3000);
    for (let slot = 1; slot <= 9; slot++) {
      const held = await page.evaluate(() => window.__faefight.snapshot().players.find((p) => p.id === window.__faefight.humanId()).hotbar);
      await mark(`slot${slot}:${held[slot - 1]}`);
      await page.keyboard.press(`Digit${slot}`);
      await page.waitForTimeout(150);
      if (pass) await page.mouse.down({ button: 'right' });
      await page.mouse.down();
      await page.waitForTimeout(250);
      await page.mouse.up();
      if (pass) await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(150);
    }
    if (!pass) { await mark('KeyV'); await page.keyboard.press('KeyV'); }
  }
}
await page.waitForTimeout(Math.max(0, endAt - Date.now()));
const per = await page.evaluate(() => window.__per);
const st = await page.evaluate(() => ({ ...window.__st, gpu: window.__gpu }));
const profile = cdp ? (await cdp.send('Profiler.stop')).profile : null;
await browser.close();

const fr = st.frames;
const ints = [];
for (let i = 1; i < fr.length; i++) ints.push([fr[i], fr[i] - fr[i - 1]]);
const q = (xs, k) => xs[Math.min(xs.length - 1, Math.floor(xs.length * k))] ?? 0;
const out = { quality, loadMs: Math.round(hideT - clickAt), perSec: [] };
for (let s = 0; s < SECS; s++) {
  const xs = ints.filter(([t]) => t >= hideT + s * 1000 && t < hideT + (s + 1) * 1000).map(([, d]) => d).sort((a, b) => a - b);
  out.perSec.push(`${s}s n${xs.length} p95 ${q(xs, 0.95).toFixed(0)} p99 ${q(xs, 0.99).toFixed(0)} max ${(xs.at(-1) ?? 0).toFixed(0)} | ${per[s] ?? ''}`);
}
const all = ints.filter(([t]) => t >= hideT && t < hideT + SECS * 1000).map(([, d]) => d).sort((a, b) => a - b);
out.total = `n${all.length} p50 ${q(all, 0.5).toFixed(1)} p95 ${q(all, 0.95).toFixed(1)} p99 ${q(all, 0.99).toFixed(1)} max ${(all.at(-1) ?? 0).toFixed(0)} >50ms ${all.filter((x) => x > 50).length} >33ms ${all.filter((x) => x > 33).length}`;
out.longAfter = st.long.filter(([t]) => t >= hideT).map(([t, d]) => `${((t - hideT) / 1000).toFixed(1)}s:${d}`).join(' ');
out.longBefore = st.long.filter(([t]) => t >= clickAt && t < hideT).map(([t, d]) => `${((t - clickAt) / 1000).toFixed(1)}s:${d}`).join(' ');
out.loadEvents = events.filter((e) => e.t >= clickAt - 50).map((e) =>
  `${((e.t - clickAt) / 1000).toFixed(2)} ${e.kind} ${e.phase ?? ''}${e.frac !== undefined ? `=${e.frac.toFixed(2)}` : ''} ${e.label ?? ''} tot${e.total.toFixed(2)}`);
out.logs = logs;
const gpuAt = (lo, hi) => {
  const c = {};
  for (const [t, name] of st.gpu) if (t >= lo && t < hi) c[name] = (c[name] ?? 0) + 1;
  return JSON.stringify(c);
};
out.gpuLoading = gpuAt(clickAt, hideT);
out.gpuAfter = gpuAt(hideT, Infinity);
if (process.env.GPULIST) out.gpuLoadingList = st.gpu.filter(([t, n]) => t >= clickAt && t < hideT && /Pipeline/.test(n)).map(([t, n, l]) => `${((t - clickAt) / 1000).toFixed(2)}s ${n.replace('createRenderPipeline', 'RP')} ${l}`);
// Pipelines compiled after the reveal, first time each, plus texture creations grouped by size.
out.pipelinesAfter = st.gpu.filter(([t, n]) => t >= hideT && /Pipeline|mark/.test(n)).map(([t, , l]) => `${((t - hideT) / 1000).toFixed(2)}s ${l.replace(/^renderPipeline_/, '')}`);
const texAfter = {};
for (const [t, n, , , sz] of st.gpu) if (t >= hideT && n === 'createTexture') texAfter[sz] = (texAfter[sz] ?? 0) + 1;
out.texturesAfter = JSON.stringify(texAfter);
console.log(JSON.stringify(out, null, 1));

if (profile) {
  // Self/inclusive JS time inside frames over 50 ms, split before/after the reveal.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const bad = ints.filter(([, d]) => d > 50).map(([t, d]) => [t - d, t]);
  const key = (x) => `${x.callFrame.functionName || '(anon)'} ${x.callFrame.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${x.callFrame.lineNumber + 1}`;
  const windows = [['LOADING', clickAt, hideT, false], ['REVEAL+0..10s', hideT, hideT + 10_000, false],
    [`REVEAL+${SECS - 5}..${SECS}s`, hideT + (SECS - 5) * 1000, hideT + SECS * 1000, false], ['>50ms FRAMES', hideT, hideT + SECS * 1000, true]];
  for (const [name, lo, hi, onlyBad] of windows) {
    let ts = profile.startTime, n = 0;
    const self = new Map(), incl = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      ts += profile.timeDeltas[i];
      const tms = (ts - profile.startTime) / 1000 + profStart;
      if (tms < lo || tms >= hi) continue;
      if (onlyBad && !bad.some(([a, b]) => tms >= a && tms <= b)) continue;
      const node = byId.get(profile.samples[i]);
      if (node.callFrame.functionName === '(idle)' || node.callFrame.functionName === '(program)') continue;
      n++;
      self.set(key(node), (self.get(key(node)) ?? 0) + 1);
      const seen = new Set();
      for (let id = node.id; id; id = parent.get(id)) {
        const k = key(byId.get(id));
        if (seen.has(k)) continue;
        seen.add(k);
        incl.set(k, (incl.get(k) ?? 0) + 1);
      }
    }
    console.log(`\n== ${name}: ${(n * 0.5).toFixed(0)} ms busy JS over ${((hi - lo) / 1000).toFixed(1)} s`);
    console.log('SELF\n' + [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${(v * 0.5).toFixed(0)}ms ${k}`).join('\n'));
    console.log('INCL\n' + [...incl].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, v]) => `${(v * 0.5).toFixed(0)}ms ${k}`).join('\n'));
  }
}

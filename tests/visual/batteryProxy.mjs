// Battery-proxy harness: an 8-player vs-bot match (?debug=1&bots=7&perf) on a scripted camera path (a steady yaw
// sweep plus a teleport through five spots), with Chrome CPU throttling (CDP Emulation.setCPUThrottlingRate) as a
// stand-in for a MacBook on battery (efficiency cores, lower clocks; 4× ≈ battery, 6× ≈ Low Power Mode).
// Per throttle rate (fresh browser each): drawn-frame p50/p95/p99, longest frame, spikes >33 / >50 ms per minute,
// the ?perf per-system main-thread ms, and with --trace=1 a CDP trace (timeline + V8 CPU profile) that attributes
// every spike: GC, JS function (nearest src/ frame), style/layout/paint, message decode, pipeline (shader)
// compile, texture upload, or an idle main thread (GPU / present wait). --heap=1 adds allocation sampling (top
// allocating functions, KB/s) for the zero-allocation hunt.
// Vsync stays on (headless = 60 Hz) unless --uncapped=1, so frame times read like a real display's.
// Needs a server at GAME_URL (an unminified prod build keeps function names: scratchpad runner). Run under heavy.sh.
//   node tests/visual/batteryProxy.mjs [--rates=1,4,6] [--secs=40] [--quality=high] [--trace=1] [--heap=0]
//        [--power=auto|performance|quality] [--battery=charging|discharging] [--dpr=1] [--label=x] [--out=file.json]
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const rates = arg('rates', '1,4,6').split(',').map(Number);
const secs = Number(arg('secs', '40'));
const quality = arg('quality', 'high');
const trace = arg('trace', '1') === '1';
const heap = arg('heap', '0') === '1';
const power = arg('power', '');
const battery = arg('battery', '');
const dpr = Number(arg('dpr', '1'));
const uncapped = arg('uncapped', '0') === '1';
const label = arg('label', 'run');
const out = arg('out', '');
const params = arg('params', '');

const q = (xs, k) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * k))] ?? 0; };
const base = (u) => (u || '').split('/').pop().split('?')[0];

const GC_RE = /^(MinorGC|MajorGC|V8\.GC_|BlinkGC\.|V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCIncrementalMarking|V8\.GCCompactor)/;
const LAYOUT_RE = /^(UpdateLayoutTree|Layout|RecalculateStyles|Paint|PrePaint|Layerize|Commit|UpdateLayer|HitTest|ParseAuthorStyleSheet)$/;
const MSG_RE = /deserialize|HandlePostMessage/i;

async function run(rate) {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--enable-precise-memory-info', ...(uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
  page.setDefaultTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.addInitScript(({ quality, power, battery }) => {
    try {
      const video = { quality, dynamicResolution: true };
      if (power) video.power = power;
      localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video }));
    } catch { /* fresh profile */ }
    if (battery) {
      const b = { charging: battery === 'charging', level: 0.8, chargingTime: Infinity, dischargingTime: 7200, addEventListener() {}, removeEventListener() {} };
      navigator.getBattery = () => Promise.resolve(b);
    }
    const w = window;
    w.__bp = { pipes: [], uploads: [] };
    if (window.GPUDevice) {
      for (const name of ['createRenderPipeline', 'createComputePipeline']) {
        const orig = GPUDevice.prototype[name];
        GPUDevice.prototype[name] = function (d) { const t = performance.now(); const r = orig.call(this, d); w.__bp.pipes.push([t, performance.now() - t, (d?.label ?? '').slice(0, 40)]); return r; };
      }
      for (const name of ['writeTexture', 'copyExternalImageToTexture']) {
        const orig = GPUQueue.prototype[name];
        GPUQueue.prototype[name] = function (...a) { const t = performance.now(); const r = orig.apply(this, a); w.__bp.uploads.push([t, performance.now() - t]); return r; };
      }
    }
  }, { quality, power, battery });
  await page.goto(`${url}/?debug=1&bots=7&perf${params ? `&${params}` : ''}`);
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
  await page.waitForTimeout(2500);
  const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
  const humanId = await dbg('humanId');
  const map = await dbg('map');
  const me0 = (await dbg('snapshot')).players.find((p) => p.id === humanId);
  const home = map[me0.island ?? 0];
  const yaw0 = home.bunker.facingYaw;
  const W = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
  const L = Math.hypot(home.center.x, home.center.z);
  const spots = [W(6, 13), W(-3, -15), W(-15, 12), W(-8, -12), { x: (home.center.x / L) * 6, z: (home.center.z / L) * 6 }];

  const cdp = await page.context().newCDPSession(page);
  if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  // scripted camera: a steady yaw sweep (~34°/s) and a little pitch wobble, invulnerable
  await page.evaluate(() => {
    const f = window.__faefight; let k = 0;
    window.__bpCam = setInterval(() => { k++; f.input.yaw += 0.03; f.input.pitch = -0.08 + 0.1 * Math.sin(k * 0.02); if (k % 10 === 0) f.hp(100000); }, 50);
  });
  await dbg('teleport', spots[0].x, spots[0].z);
  await page.waitForTimeout(1500);

  // trace: timeline + V8 sampling profile; only the events attribution needs are kept
  const evs = [];
  let traceDone = null;
  if (trace) {
    cdp.on('Tracing.dataCollected', ({ value }) => {
      for (const e of value) {
        if (e.ph === 'M' || e.name === 'Profile' || e.name === 'ProfileChunk' || e.name === 'TimeStamp' || e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask'
          || GC_RE.test(e.name) || LAYOUT_RE.test(e.name) || MSG_RE.test(e.name)) evs.push(e);
      }
    });
    traceDone = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.execute', 'disabled-by-default-v8.gc', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing'] },
    });
  }
  if (heap) { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.startSampling', { samplingInterval: 8192 }); }
  const syncPerf = await page.evaluate(() => { console.timeStamp('bp-sync'); return performance.now(); });
  await page.evaluate(() => { window.__bp.pipes.length = 0; window.__bp.uploads.length = 0; window.__faefight.resetFrames(); });
  const t0 = await page.evaluate(() => performance.now());

  const frames = []; // [t, dt]
  let lastT = 0;
  const pull = async () => {
    const { t, dt } = await dbg('frameLog');
    const sh = t.length - dt.length; // align from the newest frame (resetFrames may clear only dt)
    for (let i = Math.max(0, sh); i < t.length; i++) if (t[i] > lastT && t[i] > t0 && dt[i - sh] !== undefined) { frames.push([t[i], dt[i - sh]]); lastT = t[i]; }
  };
  const tEnd = Date.now() + secs * 1000;
  let spot = 0, nextSpot = Date.now() + 8000;
  while (Date.now() < tEnd) {
    await page.waitForTimeout(1200);
    await pull();
    if (Date.now() >= nextSpot) { spot = (spot + 1) % spots.length; nextSpot += 8000; await dbg('teleport', spots[spot].x, spots[spot].z); }
  }
  await pull();
  const probeStats = await dbg('perfProbe');
  const bp = await page.evaluate(() => window.__bp);
  const gfps = await page.evaluate(() => window.__faefight.gpuFps?.() ?? 0);
  const powerState = await page.evaluate(() => window.__faefight.power?.() ?? null);
  let heapTop = null;
  if (heap) {
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const by = new Map();
    const walk = (n, appFn) => {
      const cf = n.callFrame;
      const here = /\/src\//.test(cf.url) ? `${cf.functionName || '(anon)'} ${base(cf.url)}:${cf.lineNumber + 1}` : appFn;
      const self = n.selfSize ?? 0;
      if (self) { const k = /\/src\//.test(cf.url) ? here : `${here ?? '?'} → ${cf.functionName || '(anon)'}${cf.url ? ` ${base(cf.url)}` : ''}`; by.set(k, (by.get(k) ?? 0) + self); }
      for (const c of n.children ?? []) walk(c, here);
    };
    walk(profile.head, null);
    heapTop = [...by].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, b]) => ({ fn: k, kbPerSec: +(b / 1024 / secs).toFixed(1) }));
  }
  let spikes = null;
  if (trace) {
    await cdp.send('Tracing.end');
    await traceDone;
    try { spikes = attribute(evs, frames, syncPerf, bp); } catch (e) { spikes = { error: String(e.stack ?? e).slice(0, 400) }; }
  }
  await browser.close();

  const dts = frames.map((f) => f[1]);
  const mins = (frames.length ? frames[frames.length - 1][0] - t0 : 1) / 60000;
  return {
    rate, n: dts.length, fps: +(1000 / (dts.reduce((a, b) => a + b, 0) / (dts.length || 1))).toFixed(1), gpuFps: +gfps.toFixed(1),
    p50: +q(dts, 0.5).toFixed(1), p95: +q(dts, 0.95).toFixed(1), p99: +q(dts, 0.99).toFixed(1), max: +Math.max(0, ...dts).toFixed(1),
    s33: +(dts.filter((x) => x > 33.4).length / mins).toFixed(1), s50: +(dts.filter((x) => x > 50).length / mins).toFixed(1),
    pipes: bp.pipes.length, uploads: bp.uploads.length, probe: probeStats, power: powerState, heapTop, spikes, errors: errors.slice(0, 5),
  };
}

/** Attribute every drawn frame > 33 ms to what the main thread did inside it. */
function attribute(evs, frames, syncPerf, bp) {
  const sync = evs.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'bp-sync');
  if (!sync) return { error: 'no sync marker in trace' };
  const off = sync.ts - syncPerf * 1000; // trace µs = perf ms × 1000 + off
  const main = { pid: sync.pid, tid: sync.tid };
  const onMain = (e) => e.pid === main.pid && e.tid === main.tid;
  // complete events (X) on the main thread; B/E pairs are folded into X
  const xs = [];
  const open = new Map();
  for (const e of evs) {
    if (!onMain(e)) continue;
    if (e.ph === 'X') xs.push({ name: e.name, ts: e.ts, end: e.ts + (e.dur ?? 0) });
    else if (e.ph === 'B') open.set(e.name, e.ts);
    else if (e.ph === 'E' && open.has(e.name)) { xs.push({ name: e.name, ts: open.get(e.name), end: e.ts }); open.delete(e.name); }
  }
  // V8 CPU profile of the main thread → samples [ts, dur, leaf, appFrame]
  const prof = evs.find((e) => e.name === 'Profile' && e.pid === main.pid && e.tid === main.tid) ?? evs.find((e) => e.name === 'Profile' && e.pid === main.pid);
  const samples = [];
  if (prof) {
    const nodes = new Map();
    let t = prof.args.data.startTime;
    const ids = [], ts = [];
    for (const e of evs) {
      if (e.name !== 'ProfileChunk' || e.id !== prof.id) continue;
      const cp = e.args.data.cpuProfile ?? {};
      for (const n of cp.nodes ?? []) nodes.set(n.id, n);
      const s = cp.samples ?? [], d = e.args.data.timeDeltas ?? [];
      for (let i = 0; i < s.length; i++) { t += d[i] ?? 0; ids.push(s[i]); ts.push(t); }
    }
    const lab = new Map();
    const appOf = (id) => {
      if (lab.has(id)) return lab.get(id);
      let n = nodes.get(id), r = null;
      while (n) { const cf = n.callFrame; if (/\/src\//.test(cf.url)) { r = `${cf.functionName || '(anon)'} ${base(cf.url)}:${cf.lineNumber + 1}`; break; } n = nodes.get(n.parent); }
      lab.set(id, r);
      return r;
    };
    for (let i = 0; i < ids.length - 1; i++) {
      const n = nodes.get(ids[i]);
      if (!n) continue;
      const cf = n.callFrame;
      samples.push({ ts: ts[i], dur: ts[i + 1] - ts[i], leaf: `${cf.functionName || '(anon)'}${cf.url ? ` ${base(cf.url)}` : ''}`, app: appOf(ids[i]) });
    }
  }
  const clip = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const causes = new Map();
  const list = [];
  for (const [t, dt] of frames) {
    if (dt <= 33.4) continue;
    const w0 = (t - dt) * 1000 + off, w1 = t * 1000 + off;
    let busy = 0, gc = 0, layout = 0, msg = 0;
    for (const x of xs) {
      if (x.end < w0 || x.ts > w1) continue;
      const c = clip(x.ts, x.end, w0, w1);
      if (x.name === 'RunTask' || x.name === 'ThreadControllerImpl::RunTask') busy += c;
      else if (GC_RE.test(x.name)) gc += c;
      else if (LAYOUT_RE.test(x.name)) layout += c;
      else if (MSG_RE.test(x.name)) msg += c;
    }
    const js = new Map(), leaves = new Map();
    let pgcs = 0, native = 0;
    for (const s of samples) {
      if (s.ts + s.dur < w0 || s.ts > w1) continue;
      const c = clip(s.ts, s.ts + s.dur, w0, w1);
      if (s.leaf.startsWith('(garbage collector)')) pgcs += c;
      else if (s.leaf.startsWith('(program)')) native += c;
      else if (s.leaf.startsWith('(idle)') || s.leaf.startsWith('(root)')) continue;
      else { const k = s.app ?? s.leaf; js.set(k, (js.get(k) ?? 0) + c); leaves.set(`${k}|${s.leaf}`, (leaves.get(`${k}|${s.leaf}`) ?? 0) + c); }
    }
    gc = Math.max(gc, pgcs);
    const pipes = bp.pipes.filter((p) => p[0] >= t - dt && p[0] <= t);
    const ups = bp.uploads.filter((p) => p[0] >= t - dt && p[0] <= t);
    const topJs = [...js].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    const idle = Math.max(0, (w1 - w0) - busy);
    const cand = [['GC', gc], ['style/layout/paint', layout], ['snapshot message decode', msg], [`JS ${topJs[0]}`, topJs[1]], ['native (program: WebGPU/DOM bindings)', native]];
    cand.sort((a, b) => b[1] - a[1]);
    let cause = cand[0][0];
    if (pipes.length) cause = `pipeline compile (${pipes.length}: ${pipes[0][2] || 'unlabelled'})`;
    else if (ups.length && cand[0][1] < 8000) cause = 'texture upload';
    else if (idle > 0.6 * (w1 - w0) && cand[0][1] < 8000) cause = 'main idle (GPU / present wait)';
    const leaf = [...leaves].filter(([k]) => k.startsWith(`${topJs[0]}|`)).sort((a, b) => b[1] - a[1])[0]?.[0].split('|')[1] ?? '';
    list.push({ at: +((t - frames[0][0]) / 1000).toFixed(2), dt: +dt.toFixed(1), cause, busyMs: +(busy / 1000).toFixed(1), gcMs: +(gc / 1000).toFixed(1), layoutMs: +(layout / 1000).toFixed(1), jsTop: topJs[0], jsMs: +(topJs[1] / 1000).toFixed(1), leaf });
    const c = causes.get(cause) ?? { n: 0, ms: 0, over: 0, leaf: new Map() };
    c.n++; c.ms += dt; c.over += dt - 16.7;
    if (leaf) c.leaf.set(leaf, (c.leaf.get(leaf) ?? 0) + 1);
    causes.set(cause, c);
  }
  const top = [...causes].sort((a, b) => b[1].over - a[1].over).slice(0, 10)
    .map(([cause, c]) => ({ cause, n: c.n, avgMs: +(c.ms / c.n).toFixed(1), overMs: Math.round(c.over), leaf: [...c.leaf].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }));
  // whole-window main-thread self time by src/ frame (what the steady frame costs, for the allocation hunt)
  const all = new Map();
  for (const s of samples) { if (/^\((idle|root)\)/.test(s.leaf)) continue; const k = s.leaf.startsWith('(garbage collector)') ? '(GC)' : s.leaf.startsWith('(program)') ? '(program)' : s.app ?? s.leaf; all.set(k, (all.get(k) ?? 0) + s.dur); }
  const span = samples.length ? (samples[samples.length - 1].ts - samples[0].ts) / 1000 : 1;
  const steady = [...all].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, us]) => ({ fn: k, msPerSec: +(us / span).toFixed(2) }));
  return { n: list.length, top, worst: list.sort((a, b) => b.dt - a.dt).slice(0, 12), steady, samples: samples.length };
}

const rows = [];
for (const r of rates) {
  const row = await run(r);
  rows.push(row);
  console.error(`[${label}] ${r}× done: p50 ${row.p50} p99 ${row.p99} max ${row.max} s33/min ${row.s33}`);
}
console.log(`\n== ${label} (${quality}, dpr ${dpr}, ${secs}s, ${uncapped ? 'uncapped' : 'vsync 60'}${power ? `, power=${power}` : ''}${battery ? `, battery=${battery}` : ''}) ==`);
console.log('| throttle | fps | p50 | p95 | p99 | longest | >33 ms/min | >50 ms/min | pipelines | main ms (probe) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.rate}× | ${r.fps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.s33} | ${r.s50} | ${r.pipes} | ${r.probe?.total ?? '-'} |`);
for (const r of rows) {
  console.log(`\n-- ${r.rate}×: probe ${JSON.stringify(r.probe)}${r.power ? ` power ${JSON.stringify(r.power)}` : ''}`);
  if (r.spikes?.top) {
    console.log(`spike causes (${r.spikes.n} spikes, ${r.spikes.samples} samples):`);
    console.log('| # | cause | spikes | avg ms | ms over 16.7 | top leaf |');
    console.log('|---|---|---|---|---|---|');
    r.spikes.top.forEach((c, i) => console.log(`| ${i + 1} | ${c.cause} | ${c.n} | ${c.avgMs} | ${c.overMs} | ${c.leaf} |`));
    console.log('steady main-thread self time (ms/s):', r.spikes.steady.map((s) => `${s.fn}=${s.msPerSec}`).join('; '));
  } else if (r.spikes) console.log('spikes:', JSON.stringify(r.spikes));
  if (r.heapTop) console.log('alloc KB/s:', r.heapTop.map((h) => `${h.fn}=${h.kbPerSec}`).join('; '));
  if (r.errors.length) console.log('errors:', JSON.stringify(r.errors));
}
if (out) writeFileSync(out, JSON.stringify({ label, quality, dpr, secs, power, battery, rows }, null, 1));

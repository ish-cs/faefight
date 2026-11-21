// Frame profile of an 8-player match (headless, 1600×900, vsync off, high preset unless --preset=): CPU sampling
// profile of the main thread ranked by self time (function + file), GPU timestamp ms, frame stats, and the
// input→render latency probe (synthetic mouse-look events). Run under the heavy lock (perfAB.mjs does).
//   GAME_URL=… node tests/visual/profile.mjs [--preset=high] [--secs=5] [--label=x]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const preset = arg('preset', 'high');
const secs = Number(arg('secs', '5'));
const label = arg('label', 'profile');
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const vsync = arg('vsync', '0') === '1';

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', ...(vsync ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((q) => { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: q, dynamicResolution: false } })); }, preset);
await page.goto(`${url}/?debug=1&bots=7&gputime=1`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(2500);
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me.island ?? 0];
const yaw0 = home.bunker.facingYaw;
const W = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
await dbg('hp', 100000);
const at = W(6, 13), to = W(14, 60);
await dbg('teleport', at.x, at.z);
await page.evaluate((y) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = 0.02; }, Math.atan2(-(to.x - at.x), -(to.z - at.z)));
await page.waitForTimeout(1200);

// --- CPU profile + frame stats + GPU ms over the same window
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await dbg('resetFrames');
await cdp.send('Profiler.start');
await page.waitForTimeout(secs * 1000);
const { profile } = await cdp.send('Profiler.stop');
const frames = await dbg('frames');
const gpu = await dbg('gpuMs');
const info = await dbg('renderInfo');

// self time per node: samples × interval
const dt = (profile.endTime - profile.startTime) / 1000 / profile.samples.length; // ms per sample
const count = new Map();
for (const id of profile.samples) count.set(id, (count.get(id) ?? 0) + 1);
const byFn = new Map(), byFile = new Map();
for (const n of profile.nodes) {
  const c = count.get(n.id) ?? 0;
  if (!c) continue;
  const f = n.callFrame;
  const file = (f.url || '(native)').replace(/^.*\/(node_modules\/\.vite\/deps\/|src\/|@fs.*node_modules\/)/, '').replace(/\?.*$/, '');
  const fn = `${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`;
  byFn.set(fn, (byFn.get(fn) ?? 0) + c * dt);
  byFile.set(file, (byFile.get(file) ?? 0) + c * dt);
}
const total = profile.samples.length * dt;
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const perFrame = (ms) => (ms / (frames.n || 1)).toFixed(3);

// --- input → render latency (synthetic look events at ~250 Hz); builds without the probe report n=0
let lat = { n: 0, cpuAvg: 0, cpuP95: 0, gpuAvg: 0, gpuP95: 0 };
if (await page.evaluate(() => typeof window.__faefight.lookProbe === 'function')) {
  await dbg('lookProbe', true);
  await dbg('resetLatency');
  await page.evaluate(() => new Promise((res) => {
    const id = setInterval(() => window.dispatchEvent(new MouseEvent('mousemove', { movementX: 1, movementY: 0 })), 4);
    setTimeout(() => { clearInterval(id); res(); }, 3000);
  }));
  await page.waitForTimeout(300);
  lat = await dbg('latency');
  await dbg('lookProbe', false);
}
await browser.close();

console.log(`\n== ${label} (${preset}, ${secs}s, ${frames.n} frames) ==`);
console.log(`fps ${(1000 / frames.avg).toFixed(1)} · avg ${frames.avg.toFixed(2)} ms · p99 ${frames.p99.toFixed(2)} ms · hitches>25ms ${frames.hitches} · main-thread work ${frames.cpuAvg.toFixed(2)} ms/frame · gpu ${(gpu.avg ?? 0).toFixed(2)} ms · draws ${info.drawCalls} · tris ${(info.triangles / 1e6).toFixed(2)}M`);
console.log(`input→submit ${lat.cpuAvg.toFixed(2)} ms (p95 ${lat.cpuP95.toFixed(2)}) · input→GPU done ${lat.gpuAvg.toFixed(2)} ms (p95 ${lat.gpuP95.toFixed(2)}) · n=${lat.n}`);
console.log(`profiled ${total.toFixed(0)} ms main thread`);
console.log('-- top functions (self ms per frame) --');
for (const [k, v] of top(byFn, 30)) console.log(`${perFrame(v).padStart(7)}  ${k}`);
console.log('-- top files (self ms per frame) --');
for (const [k, v] of top(byFile, 20)) console.log(`${perFrame(v).padStart(7)}  ${k}`);
if (errors.length) console.log('errors', JSON.stringify(errors.slice(0, 5)));

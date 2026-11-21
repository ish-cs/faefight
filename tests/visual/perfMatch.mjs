// Engine perf harness: 8-player vs-bot match (?debug=1&bots=7), headless, fixed 1600×900 @1x, vsync off, dynamic
// resolution + governor off. Per preset (fresh page each): load time, avg fps, p99 frame ms, draw calls, triangles,
// averaged over fixed camera spots. Optional same-view screenshots.
// Needs a dev server (`pnpm vite --port 5299`); run under the heavy lock:
//   node tests/visual/perfMatch.mjs [--stress=3] [--presets=low,high,ultra] [--shots=docs/screens/perf-before] [--label=x]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const stress = Number(arg('stress', '1'));
const presets = arg('presets', 'low,high,ultra').split(',');
const shots = arg('shots', '');
const label = arg('label', stress > 1 ? `stress${stress}` : 'base');
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const sampleMs = Number(arg('sample', '3000'));
/** device pixel ratio of the page (2 = a Retina MacBook: the presets' render scale then applies) */
const dpr = Number(arg('dpr', '1'));
const competitive = arg('competitive', '0') === '1';
const views = arg('views', 'base');
/** extra URL params for both A and B (e.g. --params=taau=0) */
const params = arg('params', '');

const SPOTS = [
  { name: 'harbor', at: [6, 13], look: [14, 60], pitch: 0.02 },
  { name: 'across', at: [-3, -15], look: [-3, -80], pitch: -0.02 },
  { name: 'edge', at: [-15, 12], look: [-25, 30], pitch: -0.12 },
  { name: 'props', at: [-8, -12], look: [-1, -8], pitch: -0.32 },
];

async function run(quality) {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
  page.setDefaultTimeout(240_000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((q) => {
    try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: q.q, dynamicResolution: false, competitive: q.c }, onboarding: { howToSeen: true } })); } catch { /* fresh profile */ }
  }, { q: quality, c: competitive });
  await page.goto(`${url}/?debug=1&bots=7&gputime=1${stress > 1 ? `&stress=${stress}` : ''}${params ? `&${params}` : ''}`);
  const t0 = Date.now();
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 120_000 });
  await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
  const loadMs = Date.now() - t0;
  const pbr = await page.evaluate(() => window.__faefight.pbr?.() ?? null);
  await page.waitForTimeout(2500);
  const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
  const humanId = await dbg('humanId');
  const map = await dbg('map');
  const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
  const home = map[me.island ?? 0];
  const yaw0 = home.bunker.facingYaw;
  const toWorld = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
  const yawToward = (from, to) => { const a = toWorld(...from), b = toWorld(...to); return Math.atan2(-(b.x - a.x), -(b.z - a.z)); };
  const per = [];
  // --views=extra adds 'mid' (halfway to the map centre, looking across it at the other islands and bots) and
  // 'storm' (sudden death: rain + wall, irreversible, so it runs last)
  const L = Math.hypot(home.center.x, home.center.z), ux = home.center.x / L, uz = home.center.z / L;
  const spots = [...SPOTS, ...(views === 'extra' ? [
    { name: 'mid', world: { x: ux * L * 0.45, z: uz * L * 0.45 }, yaw: Math.atan2(ux, uz), pitch: 0.0 },
    { name: 'storm', storm: true, world: { x: ux * (L - 12), z: uz * (L - 12) }, yaw: Math.atan2(-ux, -uz), pitch: 0.04 },
  ] : [])];
  for (const s of spots) {
    await dbg('hp', 100000);
    if (s.storm) { await dbg('time', 899); await page.waitForTimeout(9000); await dbg('time', 1000); await page.waitForTimeout(1500); await dbg('hp', 100000); }
    const w = s.world ?? toWorld(...s.at);
    await dbg('teleport', w.x, w.z);
    await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [s.yaw ?? yawToward(s.at, s.look), s.pitch]);
    await page.waitForTimeout(900);
    await dbg('resetFrames');
    // draw calls / triangles: sampled a few times during the window (bots move, LOD changes)
    const infos = [];
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(sampleMs / 4); infos.push(await dbg('renderInfo')); }
    const f = await dbg('frames');
    const gpu = await dbg('gpuMs');
    per.push({
      spot: s.name, avgMs: f.avg, p99: f.p99, cpu: f.cpuAvg, gpu: gpu.avg ?? 0,
      draws: infos.reduce((a, x) => a + x.drawCalls, 0) / infos.length,
      tris: infos.reduce((a, x) => a + x.triangles, 0) / infos.length,
    });
    if (shots) await page.screenshot({ path: `${shots}-${quality}-${s.name}.png` });
  }
  await browser.close();
  const mean = (k) => per.reduce((a, x) => a + x[k], 0) / per.length;
  const avgMs = mean('avgMs');
  return {
    preset: quality, loadMs, pbr, fps: +(1000 / avgMs).toFixed(1), avgMs: +avgMs.toFixed(2), p99: +Math.max(...per.map((x) => x.p99)).toFixed(2),
    cpuMs: +mean('cpu').toFixed(2), gpuMs: +mean('gpu').toFixed(2), draws: Math.round(mean('draws')), tris: Math.round(mean('tris')),
    perSpot: per.map((x) => `${x.spot}:${(1000 / x.avgMs).toFixed(0)}fps/${x.gpu.toFixed(1)}gms/${x.cpu.toFixed(1)}cms/${Math.round(x.draws)}dc/${Math.round(x.tris / 1000)}kt`).join(' '),
    errors: errors.slice(0, 5),
  };
}

const rows = [];
for (const q of presets) rows.push(await run(q));
console.log(`\n== ${label} (stress ×${stress}) ==`);
console.log('| preset | load s | avg fps | p99 ms | cpu ms | gpu ms | draws | tris |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.preset} | ${(r.loadMs / 1000).toFixed(1)} | ${r.fps} | ${r.p99} | ${r.cpuMs} | ${r.gpuMs} | ${r.draws} | ${(r.tris / 1e6).toFixed(2)}M |`);
if (rows[0]?.pbr) console.log(`textures: ${JSON.stringify(rows[0].pbr)}`);
for (const r of rows) console.log(`${r.preset}: ${r.perSpot}${r.errors.length ? `  errors: ${JSON.stringify(r.errors)}` : ''}`);
console.log(JSON.stringify({ label, stress, rows }));

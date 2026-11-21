// Realism pass: same camera spots before/after + frame times per quality preset, 8 players (?debug=1&bots=7), 1600×900.
// Needs `pnpm vite --port 5299`; `node tests/visual/realism.mjs <outPrefix> [shots|perf|all] [quality]`
//   shots → <outPrefix>-<spot>.png (quality from arg, default ultra); perf → frame-time stats per preset.
import { chromium } from '@playwright/test';

const prefix = process.argv[2] ?? 'realism';
const mode = process.argv[3] ?? 'all';
const shotQuality = process.argv[4] ?? 'ultra';
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
// fixed resolution for comparable numbers (dynamic resolution would trade pixels for frame time)
await page.addInitScript(() => { try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { dynamicResolution: false } })); } catch { /* fresh profile */ } });
await page.goto(`${url}/?debug=1&bots=7&gputime=1`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 120_000 });
await page.waitForTimeout(3000);
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me.island ?? 0];
const yaw0 = home.bunker.facingYaw;
// island-local (x, z) → world; three.js Y rotation (matches sim/vec rotateY)
const toWorld = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
const yawToward = (from, to) => {
  const a = toWorld(...from), b = toWorld(...to);
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
};
const setQuality = (q) => page.evaluate((q) => window.__faefight.renderer.world.sky.setQuality(q), q);

async function goto(spot) {
  await dbg('hp', 100000);
  const w = toWorld(...spot.at);
  await dbg('teleport', w.x, w.z);
  await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [spot.yawWorld ?? yawToward(spot.at, spot.look), spot.pitch ?? -0.05]);
  await page.waitForTimeout(spot.wait ?? 1400);
}

const SPOTS = [
  { name: 'harbor', at: [6, 13], look: [14, 60], pitch: 0.02 },
  { name: 'across', at: [-3, -15], look: [-3, -80], pitch: -0.02 },
  { name: 'grass', at: [9.5, 5.5], look: [13, 10], pitch: -0.42 },
  { name: 'ground', at: [-6, -1], look: [-6, -5], pitch: -0.75 },
  { name: 'bunker', at: [-6, 9], look: [0, 15], pitch: -0.05 },
  { name: 'edge', at: [-15, 12], look: [-25, 30], pitch: -0.12 },
  { name: 'birds', at: [8, 10], look: [4, 32], pitch: 0.3 },
  { name: 'perch', at: [16.8, 6.6], look: [19.4, 9.36], pitch: -0.25 },
  { name: 'beach', at: [14, 15], look: [34, 36], pitch: -0.12 },
  { name: 'props', at: [-8, -12], look: [-1, -8], pitch: -0.32 },
  { name: 'gravel', at: [-9.5, 4.5], look: [-13, 9], pitch: -0.5 },
];
// toward the sun (SUN_DIR: elevation 38°, azimuth 58° in three.js spherical coords)
{
  const ph = (52 * Math.PI) / 180, th = (58 * Math.PI) / 180;
  SPOTS.push({ name: 'sun', at: [0, -6], yawWorld: Math.atan2(-Math.sin(ph) * Math.sin(th), -Math.sin(ph) * Math.cos(th)), pitch: 0.42 });
}

if (mode === 'shots' || mode === 'all') {
  await setQuality(shotQuality);
  await page.waitForTimeout(1500);
  for (const s of SPOTS) {
    await goto(s);
    await page.screenshot({ path: `${prefix}-${s.name}.png` });
  }
}

if (mode === 'perf' || mode === 'all') {
  const out = {};
  for (const q of ['low', 'high', 'ultra']) {
    await setQuality(q);
    await page.waitForTimeout(1500);
    const acc = [];
    for (const s of [SPOTS[0], SPOTS[1], SPOTS[2]]) {
      await goto({ ...s, wait: 600 });
      await dbg('resetFrames');
      await page.waitForTimeout(2500);
      acc.push({ ...(await dbg('frames')), gpu: (await dbg('gpuMs')).avg ?? 0 });
    }
    const avg = acc.reduce((a, f) => a + f.avg, 0) / acc.length;
    const p50 = acc.reduce((a, f) => a + f.p50, 0) / acc.length;
    const gpu = acc.reduce((a, f) => a + f.gpu, 0) / acc.length;
    out[q] = { gpuMs: +gpu.toFixed(2), p50: +p50.toFixed(2), avgMs: +avg.toFixed(2), fps: +(1000 / avg).toFixed(0), p95: +Math.max(...acc.map((f) => f.p95)).toFixed(2), p99: +Math.max(...acc.map((f) => f.p99)).toFixed(2), perSpot: acc.map((f) => +f.avg.toFixed(2)) };
  }
  console.log(JSON.stringify(out));
  console.log('renderInfo', JSON.stringify(await dbg('renderInfo')));
}
console.log(JSON.stringify({ errors: errors.slice(0, 10) }));
await browser.close();

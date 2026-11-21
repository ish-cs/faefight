// Realism pass 3 harness: match load time, frame times per preset (8 players: ?debug=1&bots=7) and 2560×1440 shots.
// Needs `pnpm vite --port 5299`; `node tests/visual/realism3.mjs <outPrefix> [perf|shots|all] [width] [height]`
//   perf  → load time + frame-time stats per preset (fixed resolution, dynamic resolution off)
//   shots → <outPrefix>-<spot>.png at ultra: harbor quay, island bunker, gravel piles + props close-up, barrels mid-tumble
import { chromium } from '@playwright/test';

const prefix = process.argv[2] ?? 'realism3';
const mode = process.argv[3] ?? 'all';
const W = +(process.argv[4] ?? 2560), H = +(process.argv[5] ?? 1440);
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (/\[world|\[props|\[debris|\[lighting|\[scatter/.test(m.text())) logs.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript(() => { try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { dynamicResolution: false, quality: 'high' } })); } catch { /* fresh profile */ } });
await page.goto(`${url}/?debug=1&bots=7&gputime=1`);
const tClick = Date.now();
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
const tSnap = Date.now();
await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 120_000 });
const tReady = Date.now();
const load = { firstSnapMs: tSnap - tClick, readyMs: tReady - tClick };
// longest main-thread stall over the first seconds of play
const stall = await page.evaluate(() => new Promise((res) => {
  let last = performance.now(), worst = 0;
  const end = last + 3000;
  const tick = () => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; if (t < end) requestAnimationFrame(tick); else res(worst); };
  requestAnimationFrame(tick);
}));
load.worstFrameFirst3sMs = Math.round(stall);
console.log('load', JSON.stringify(load));

const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me.island ?? 0];
const yaw0 = home.bunker.facingYaw;
const toWorld = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
const yawToward = (from, to) => { const a = toWorld(...from), b = toWorld(...to); return Math.atan2(-(b.x - a.x), -(b.z - a.z)); };
const setQuality = (q) => page.evaluate((q) => window.__faefight.renderer.world.sky.setQuality(q), q);
async function goto(spot) {
  await dbg('hp', 100000);
  const w = toWorld(...spot.at);
  await dbg('teleport', w.x, w.z);
  await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [spot.yawWorld ?? yawToward(spot.at, spot.look), spot.pitch ?? -0.05]);
  await page.waitForTimeout(spot.wait ?? 1400);
}

const SPOTS = {
  harbor: { at: [6, 13], look: [14, 60], pitch: 0.02 },
  across: { at: [-3, -15], look: [-3, -80], pitch: -0.02 },
  grass: { at: [9.5, 5.5], look: [13, 10], pitch: -0.42 },
  bunker: { at: [-6, 9], look: [0, 15], pitch: -0.05 },
  gravel: { at: [-14, -6], look: [-17, 2], pitch: -0.35 },
  quayEdge: { at: [3, 20.5], look: [12, 40], pitch: -0.1 },
};

if (mode === 'perf' || mode === 'all') {
  const out = {};
  for (const q of ['low', 'high', 'ultra']) {
    await setQuality(q);
    await page.waitForTimeout(1500);
    const acc = [];
    for (const s of [SPOTS.harbor, SPOTS.across, SPOTS.grass]) {
      await goto({ ...s, wait: 600 });
      await dbg('resetFrames');
      await page.waitForTimeout(2500);
      acc.push({ ...(await dbg('frames')), gpu: (await dbg('gpuMs')).avg ?? 0 });
    }
    const avg = acc.reduce((a, f) => a + f.avg, 0) / acc.length;
    const gpu = acc.reduce((a, f) => a + f.gpu, 0) / acc.length;
    out[q] = { gpuMs: +gpu.toFixed(2), avgMs: +avg.toFixed(2), fps: +(1000 / avg).toFixed(0), p95: +Math.max(...acc.map((f) => f.p95)).toFixed(2), perSpot: acc.map((f) => +f.avg.toFixed(2)) };
  }
  console.log('perf', JSON.stringify(out));
  console.log('renderInfo', JSON.stringify(await dbg('renderInfo')));
}

if (mode === 'shots' || mode === 'all') {
  await setQuality('ultra');
  await page.waitForTimeout(1500);
  for (const name of ['harbor', 'bunker', 'gravel', 'quayEdge']) {
    await goto(SPOTS[name]);
    await page.screenshot({ path: `${prefix}-${name}.png` });
  }
  // barrels mid-tumble: a client-side explosion event among the loose props near the camera
  await goto({ at: [-14, -6], look: [-17, 2], pitch: -0.25, wait: 1500 });
  const boom = await page.evaluate(() => {
    const r = window.__faefight.renderer;
    const p = r.world.debris?.nearestProp?.(r.camera.position);
    if (!p) return null;
    r.localEvent({ type: 'explosion', data: { pos: { x: p.x, y: p.y, z: p.z }, kind: 'grenade' } });
    return p;
  });
  await page.waitForTimeout(260);
  await page.screenshot({ path: `${prefix}-tumble.png` });
  console.log('tumble', JSON.stringify(boom));
}
console.log('logs', JSON.stringify(logs.slice(0, 20)));
console.log(JSON.stringify({ errors: errors.slice(0, 10) }));
await browser.close();

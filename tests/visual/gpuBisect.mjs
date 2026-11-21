// GPU cost bisect at one camera spot: per variant (one feature off / cheaper), GPU timestamp ms, input→GPU-done
// latency (frames queued on the GPU show up here) and fps. 8-player match, 1600×900 @1x, vsync off.
// Run under the heavy lock:  GAME_URL=… node tests/visual/gpuBisect.mjs [--preset=high]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const preset = arg('preset', 'high');
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const dpr = Number(arg('dpr', '1'));
const VARIANTS = arg('variants', 'base,msaa2,msaa1,noao,nobloom,noflare,dpr1,noshadow,nograss,noocean,base2').split(',');

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
page.setDefaultTimeout(240_000);
await page.addInitScript((q) => { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: q, dynamicResolution: false }, onboarding: { howToSeen: true } })); }, preset);
await page.goto(`${url}/?debug=1&bots=7&gputime=1`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const f = window.__faefight, me = f.snapshot().players.find((p) => p.id === f.humanId()), isl = f.map()[me.island ?? 0];
  const y = isl.bunker.facingYaw, W = (x, z) => ({ x: isl.center.x + x * Math.cos(y) + z * Math.sin(y), z: isl.center.z - x * Math.sin(y) + z * Math.cos(y) });
  const a = W(6, 13), b = W(14, 60);
  f.hp(100000); f.teleport(a.x, a.z);
  f.input.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z)); f.input.pitch = 0.02;
  f.lookProbe(true);
});

const rows = [];
for (const v of VARIANTS) {
  await page.evaluate((v) => {
    const r = window.__faefight.renderer, w = r.world, sky = w.sky;
    // reset everything, then switch one thing
    sky.debugPost({}); sky.setResolutionScale(1); sky.sun.castShadow = true; w.grass.root.visible = true;
    if (w.water?.mesh) w.water.mesh.visible = true;
    if (v === 'msaa2') sky.debugPost({ samples: 2 });
    if (v === 'msaa1') sky.debugPost({ samples: 0 });
    if (v === 'noao') sky.debugPost({ ao: false });
    if (v === 'nobloom') sky.debugPost({ bloom: false });
    if (v === 'noflare') sky.debugPost({ flare: false });
    if (v === 'dpr1') sky.setResolutionScale(1 / Math.max(1, sky.pixelRatio));
    if (v === 'noshadow') sky.sun.castShadow = false;
    if (v === 'nograss') w.grass.root.visible = false;
    if (v === 'noocean' && w.water?.mesh) w.water.mesh.visible = false;
  }, v);
  await page.waitForTimeout(3000); // recompiles settle
  await page.evaluate(() => { window.__faefight.resetFrames(); window.__faefight.resetLatency(); });
  await page.evaluate(() => new Promise((res) => {
    const id = setInterval(() => window.dispatchEvent(new MouseEvent('mousemove', { movementX: 1, movementY: 0 })), 8);
    setTimeout(() => { clearInterval(id); res(); }, 3000);
  }));
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => ({ f: window.__faefight.frames(), g: window.__faefight.gpuMs(), l: window.__faefight.latency(), pr: window.__faefight.renderer.world.sky.pixelRatio, i: window.__faefight.renderInfo() }));
  rows.push({ v, fps: (1000 / s.f.avg).toFixed(0), gpu: (s.g.avg ?? 0).toFixed(2), gpuP95: (s.g.p95 ?? 0).toFixed(2), lat: s.l.gpuAvg.toFixed(1), latP95: s.l.gpuP95.toFixed(1), pr: s.pr.toFixed(2), draws: s.i.drawCalls });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
await browser.close();
console.log(`\n== GPU bisect (${preset}) ==`);
console.log('| variant | fps (rAF) | GPU ms | GPU p95 | input→GPU done ms | p95 | pixel ratio | draws |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.v} | ${r.fps} | ${r.gpu} | ${r.gpuP95} | ${r.lat} | ${r.latP95} | ${r.pr} | ${r.draws} |`);

// GPU cost per pass at one camera spot, by LIVE toggles only (no shader recompiles, unlike gpuBisect's post rebuilds):
// each variant removes one pass's cost (shrinks its render target to ~nothing or stops its updates), and the GPU
// timestamp delta vs base is that pass's cost. 8-player match, 1600×900 @ --dpr, vsync off.
//   GAME_URL=… node tests/visual/passCost.mjs [--preset=ultra] [--dpr=2] [--params=taau=0]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const preset = arg('preset', 'ultra');
const dpr = Number(arg('dpr', '2'));
const params = arg('params', '');
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const VARIANTS = ['base', 'scene', 'ao', 'bloom', 'shadows', 'grass', 'ocean', 'output', 'base'];

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
page.setDefaultTimeout(240_000);
await page.addInitScript((q) => { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: q, dynamicResolution: false }, onboarding: { howToSeen: true } })); }, preset);
await page.goto(`${url}/?debug=1&bots=7&gputime=1${params ? `&${params}` : ''}`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const f = window.__faefight, me = f.snapshot().players.find((p) => p.id === f.humanId()), isl = f.map()[me.island ?? 0];
  const y = isl.bunker.facingYaw, W = (x, z) => ({ x: isl.center.x + x * Math.cos(y) + z * Math.sin(y), z: isl.center.z - x * Math.sin(y) + z * Math.cos(y) });
  const a = W(-3, -15), b = W(-3, -80);
  f.hp(100000); f.teleport(a.x, a.z);
  f.input.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z)); f.input.pitch = -0.02;
});

const rows = [];
for (const v of VARIANTS) {
  await page.evaluate((v) => {
    const w = window.__faefight.renderer.world, sky = w.sky, sp = sky.scenePass;
    const s0 = (sky.__s0 ??= sp.getResolutionScale());
    sp.setResolutionScale(v === 'scene' ? 0.05 : s0);
    if (sky.aoPass) sky.aoPass.resolutionScale = v === 'ao' ? 0.02 : (sky.__ao0 ??= sky.aoPass.resolutionScale);
    sky.bloomPass?.setResolutionScale(v === 'bloom' ? 0.02 : (sky.__b0 ??= sky.bloomPass.getResolutionScale()));
    sky.shadowCacheEnabled = v !== 'shadows';
    for (const l of sky.csm?.lights ?? []) { l.shadow.autoUpdate = v !== 'shadows'; l.shadow.needsUpdate = false; }
    w.grass.root.visible = v !== 'grass';
    if (w.water?.mesh) w.water.mesh.visible = v !== 'ocean';
    // output: everything at output resolution (TAAU resolve, grade, sharpen, flare) — drop the canvas to ~nothing
    const pr = (sky.__pr ??= window.__faefight.renderer.gpu.getPixelRatio());
    window.__faefight.renderer.gpu.setPixelRatio(v === 'output' ? 0.1 : pr);
    if (v === 'output') sp.setResolutionScale(s0 * pr / 0.1); // keep the scene's own resolution unchanged
  }, v);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__faefight.resetFrames());
  await page.waitForTimeout(2500);
  const s = await page.evaluate(() => ({ g: window.__faefight.gpuMs(), i: window.__faefight.renderInfo() }));
  rows.push({ v, gpu: s.g.avg ?? 0, draws: s.i.drawCalls });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
await browser.close();
const base = (rows[0].gpu + rows[rows.length - 1].gpu) / 2;
console.log(`\n== pass cost (${preset}, dpr ${dpr}${params ? `, ${params}` : ''}) base ${base.toFixed(2)} ms ==`);
console.log('| pass removed | GPU ms | ≈ pass cost ms |');
console.log('|---|---|---|');
for (const r of rows.slice(1, -1)) console.log(`| ${r.v} | ${r.gpu.toFixed(2)} | ${(base - r.gpu).toFixed(2)} |`);

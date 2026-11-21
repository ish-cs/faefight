// Black-artifact + spike bisect: default video settings (fresh profile), 8-player match, camera sweeping fast.
// For each config (one feature toggled off at a time) it measures frame spikes and the fraction of near-black
// pixels in screenshots taken mid-sweep, and saves the darkest shot. Run under the heavy lock.
//   GAME_URL=… node tests/visual/blackHunt.mjs [--out=/tmp/bh] [--configs=base,ao,cache,…] [--secs=6]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const out = arg('out', '/tmp/blackhunt');
const secs = Number(arg('secs', '6'));
const configs = arg('configs', 'base,ao,cache,impostor,ocean,critters,blobs,low,base2').split(',');
const query = arg('query', '');

// Toggles run in the page; each returns a description. They only switch things OFF (one per config).
const TOGGLES = {
  base: () => 'nothing off',
  base2: () => 'nothing off (repeat)',
  ao: (w) => { w.sky.setGovernor({ ao: false, shadowScale: 1 }); return 'GTAO off'; },
  cache: (w) => { w.sky.shadowCacheEnabled = false; return 'shadow cache off'; },
  impostor: (w, scene) => { let n = 0; scene.traverse((o) => { if (/impostor/.test(o.name)) { o.visible = false; o.userData.forceHidden = true; n++; } }); return `${n} impostor meshes hidden`; },
  ocean: (w) => { if (w.water?.mesh) w.water.mesh.visible = false; return 'ocean hidden'; },
  critters: (w, scene) => { let n = 0; scene.traverse((o) => { if (/^(critter|swarm)/.test(o.name) || o.name === 'critters') { o.visible = false; n++; } }); return `${n} critter objects hidden`; },
  blobs: (w, scene) => { let n = 0; scene.traverse((o) => { if (/blob|groundAO/.test(o.name)) { o.visible = false; n++; } }); return `${n} blob/AO meshes hidden`; },
  low: (w) => { w.sky.setQuality('low'); return 'preset low (no bloom, no GTAO)'; },
  grass: (w) => { w.grass.root.visible = false; return 'grass hidden'; },
};

// configs that change stored settings before load (fresh profile otherwise = default video settings)
const SETTINGS = { nogov: { video: { dynamicResolution: false } } };
TOGGLES.nogov = () => 'governor / dynamic resolution off';

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const results = [];
for (const cfg of configs) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || /NaN|webgpu|WebGPU/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (SETTINGS[cfg]) await page.addInitScript((v) => { localStorage.setItem('faefight.settings.v1', JSON.stringify(v)); }, SETTINGS[cfg]);
  await page.goto(`${url}/?debug=1&bots=7${query ? '&' + query : ''}`);
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
  await page.waitForTimeout(1500);
  const what = await page.evaluate(([name, src]) => {
    const r = window.__faefight.renderer;
    // eslint-disable-next-line no-new-func
    return new Function('w', 'scene', `return (${src})(w, scene)`)(r.world, r.scene);
  }, [cfg, TOGGLES[cfg].toString()]);
  await page.evaluate(() => window.__faefight.hp?.(100000));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__faefight.resetFrames());
  // sweep: fast yaw turns + pitch bobbing for `secs`, screenshots along the way
  const shots = [];
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < secs * 1000) {
    await page.evaluate((i) => { const inp = window.__faefight.input; inp.yaw += 0.35; inp.pitch = Math.sin(i * 0.7) * 0.35 - 0.05; }, k++);
    await page.waitForTimeout(60);
    if (k % 6 === 0) {
      const png = await page.screenshot({ type: 'png' });
      const frac = await page.evaluate(async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        // near-black in the 3D view (skip the HUD strips at the top/bottom)
        let black = 0, n = 0;
        for (let y = Math.floor(bmp.height * 0.12); y < bmp.height * 0.82; y += 2) for (let x = 0; x < bmp.width; x += 2) {
          const i = (y * bmp.width + x) * 4; n++;
          if (d[i] < 6 && d[i + 1] < 6 && d[i + 2] < 6) black++;
        }
        return black / n;
      }, png.toString('base64'));
      shots.push({ frac, png });
    }
  }
  const f = await page.evaluate(() => window.__faefight.frames());
  const gov = await page.evaluate(() => window.__faefight.governor?.() ?? null);
  const worst = shots.reduce((a, s) => (s.frac > a.frac ? s : a), { frac: -1 });
  const fs = await import('node:fs');
  fs.mkdirSync(out, { recursive: true });
  if (worst.png) fs.writeFileSync(`${out}/${cfg}-darkest.png`, worst.png);
  results.push({ cfg, what, fps: +(1000 / f.avg).toFixed(1), p99: +f.p99.toFixed(1), max: +f.max.toFixed(1), hitches25: f.hitches, govLevel: gov?.level ?? null, blackMax: +(worst.frac * 100).toFixed(2), blackAvg: +((shots.reduce((a, s) => a + s.frac, 0) / (shots.length || 1)) * 100).toFixed(2), shots: shots.length, errors: errors.slice(0, 4) });
  console.log(JSON.stringify(results[results.length - 1]));
  await page.close();
}
await browser.close();
console.log('\n| config | toggled | fps | p99 ms | max ms | >25ms | black max % | black avg % |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.cfg} | ${r.what} | ${r.fps} | ${r.p99} | ${r.max} | ${r.hitches25} | ${r.blackMax} | ${r.blackAvg} |`);

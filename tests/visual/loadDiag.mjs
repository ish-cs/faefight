// Load-time breakdown: for each URL variant, time to playable plus the world/warm-up console timings and the number
// of distinct materials in the scene. Needs a server at GAME_URL; run under the heavy lock (tests/visual/perfAB.mjs
// with --script=loadDiag.mjs, or heavy.sh).
//   node tests/visual/loadDiag.mjs --variants=,noprops,noweather,noprops&noweather
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const variants = arg('variants', ',noprops').split(',');
const url = process.env.GAME_URL ?? 'http://localhost:5299';

for (const v of variants) {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);
  const t0 = Date.now();
  const lines = [];
  page.on('console', (m) => { const t = m.text(); if (/\[(warmup|world|debris|props|scatter)/.test(t)) lines.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${t.slice(0, 160)}`); });
  await page.addInitScript(() => { try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: 'high', dynamicResolution: false } })); } catch { /* fresh */ } });
  await page.goto(`${url}/?debug=1&bots=7${v ? `&${v}` : ''}`);
  const tClick = Date.now();
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 120_000 });
  const tSnap = Date.now();
  await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
  const tReady = Date.now();
  const mats = await page.evaluate(() => {
    const set = new Set(), inst = new Set();
    window.__faefight.renderer.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) { set.add(x.uuid); if (o.isInstancedMesh) inst.add(x.uuid); }
    });
    return { materials: set.size, instancedMaterials: inst.size };
  });
  console.log(JSON.stringify({ variant: v || 'full', snapS: (tSnap - tClick) / 1000, readyS: (tReady - tClick) / 1000, ...mats }));
  for (const l of lines) console.log('   ', l);
  await browser.close();
}

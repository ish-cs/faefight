// Scene census: meshes grouped by name prefix (count, visible, shadow casters, triangles), for draw-call budgeting.
// `node tests/visual/sceneCensus.mjs [quality]` against GAME_URL (default http://localhost:5299).
import { chromium } from '@playwright/test';

const quality = process.argv[2] ?? 'high';
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(180_000);
await page.addInitScript((q) => { localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: q, dynamicResolution: false } })); }, quality);
await page.goto(`${url}/?debug=1&bots=7${process.env.STRESS ? `&stress=${process.env.STRESS}` : ''}`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => !window.__faefightLoading?.visible() && window.__faefight?.snapshot?.(), null, { timeout: 180_000 });
await page.waitForTimeout(2000);
const out = await page.evaluate(() => {
  const r = window.__faefight.renderer;
  const g = {};
  r.scene.traverse((o) => {
    if (!o.isMesh && !o.isSprite && !o.isPoints) return;
    let vis = o.visible; for (let p = o.parent; p; p = p.parent) vis = vis && p.visible;
    const key = (o.name || o.type).split('@')[0] + (o.name?.includes('@') ? '@' + o.name.split('@')[1].split(':')[0] : '');
    const e = (g[key] ??= { n: 0, vis: 0, cast: 0, tris: 0 });
    e.n++; if (vis) e.vis++; if (vis && o.castShadow) e.cast++;
    const geo = o.geometry; const idx = geo?.index ? geo.index.count : geo?.attributes?.position?.count ?? 0;
    const inst = o.isInstancedMesh ? o.count : geo?.instanceCount ?? 1;
    if (vis) e.tris += (idx / 3) * (Number.isFinite(inst) ? inst : 1);
  });
  return Object.entries(g).sort((a, b) => b[1].vis - a[1].vis);
});
let tot = { n: 0, vis: 0, cast: 0, tris: 0 };
for (const [k, e] of out) { for (const f in tot) tot[f] += e[f]; console.log(`${k.padEnd(40)} n=${e.n} vis=${e.vis} cast=${e.cast} tris=${Math.round(e.tris / 1000)}k`); }
console.log('TOTAL', JSON.stringify({ ...tot, tris: Math.round(tot.tris / 1000) + 'k' }));
console.log('renderInfo', JSON.stringify(await page.evaluate(() => window.__faefight.renderInfo())));
await browser.close();

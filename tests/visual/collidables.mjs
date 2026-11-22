// Camera/aim raycast targets (renderer.collidables) by triangle count: the 3rd-person camera casts 2-3 rays/frame at all of them.
//   GAME_URL=… node tests/visual/collidables.mjs
import { chromium } from '@playwright/test';

const url = process.env.GAME_URL ?? 'http://localhost:5299';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(240_000);
await page.addInitScript(() => { localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, video: { quality: 'high', dynamicResolution: false }, onboarding: { howToSeen: true } })); });
await page.goto(`${url}/?debug=1&bots=7`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(2000);
const rows = await page.evaluate(() => {
  const r = window.__faefight.renderer;
  const out = [];
  for (const o of r.collidables) {
    const g = o.geometry, tris = g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0;
    out.push({ name: o.name || o.type, tris, inst: o.isInstancedMesh ? o.count : 0, visible: o.visible });
  }
  return out.sort((a, b) => b.tris * Math.max(1, b.inst) - a.tris * Math.max(1, a.inst)).slice(0, 25);
});
await browser.close();
console.log('| collidable | tris | instances |');
console.log('|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.tris} | ${r.inst} |`);

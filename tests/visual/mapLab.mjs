// Draw calls / triangles / frame time for any player count, via the map lab page (no players, no bots).
// Needs a dev server: `pnpm vite --port 5331 --strictPort`, then
// `node tests/visual/mapLab.mjs [n=2,8] [templates=harbor,yard] [shotDir]`.
import { chromium } from '@playwright/test';

const ns = (process.argv[2] ?? '2,8').split(',').map(Number);
const templates = (process.argv[3] ?? 'harbor,yard').split(',');
const shotDir = process.argv[4];
const base = process.env.MAP_URL ?? 'http://localhost:5331';

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
for (const tpl of templates) for (const n of ns) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`${base}/tests/visual/map-lab.html?n=${n}&tpl=${tpl}`);
  await page.waitForFunction(() => window.mapLab?.ready, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => window.mapLab.measure(4000));
  if (shotDir) await page.screenshot({ path: `${shotDir}/lab-${tpl}-${n}.png` });
  console.log(JSON.stringify({ tpl, n, ...m, errors }));
  await page.close();
}
await browser.close();

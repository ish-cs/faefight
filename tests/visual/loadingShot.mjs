// Match loading screen frozen mid-load (shader compile under way), desktop + narrow phone width.
//   pnpm vite --port 5339 & node tests/visual/loadingShot.mjs http://localhost:5339 <out-prefix>
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5199';
const out = process.argv[3] ?? 'test-results/loading';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
for (const [tag, viewport] of [['desktop', { width: 1440, height: 900 }], ['narrow', { width: 390, height: 760 }]]) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`${base}/?debug=1`);
  await page.waitForFunction(() => window.__faefightLoading && !window.__faefightLoading.visible());
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const l = window.__faefightLoading.screen;
    l.show('match', { code: 15, gpu: 10, characters: 25, map: 15, shaders: 30, frames: 5 });
    l.progress('code', 1, 'Loading game code'); l.progress('gpu', 1, 'Starting WebGPU');
    l.progress('characters', 1, 'Downloading characters'); l.progress('map', 1, 'Building islands');
    l.progress('shaders', 0.45, 'Compiling shaders 41/92');
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}-${tag}.png` });
  await page.close();
}
await browser.close();
console.log('ok');

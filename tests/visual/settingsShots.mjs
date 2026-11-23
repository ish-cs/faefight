// Screenshots of the settings panel and loading screens → docs/screens (run with a dev server up):
//   pnpm vite --port 5325 & node tests/visual/settingsShots.mjs http://localhost:5325
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5199';
const out = process.argv[3] ?? 'docs/screens';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

// Loading screen frozen mid-load for a clean shot: show it as a match load and pin progress.
await page.goto(`${base}/?debug=1`);
await page.getByTestId('play-medium').waitFor();
await page.waitForTimeout(800); // boot screen fully faded
await page.evaluate(() => {
  const l = window.__faefightLoading.screen;
  l.show('match', { code: 15, gpu: 10, characters: 25, map: 15, shaders: 30, frames: 5 });
  l.progress('code', 1); l.progress('gpu', 1); l.progress('characters', 1); l.progress('map', 1);
  l.progress('shaders', 0.45, 'Compiling shaders');
});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/loading.png` });

await page.goto(`${base}/?debug=1`);
await page.getByTestId('play-medium').waitFor();
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/menu.png` });
await page.getByTestId('open-settings').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/settings.png` });
for (const tab of ['video', 'audio', 'gameplay']) {
  await page.getByTestId(`settings-tab-${tab}`).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/settings-${tab}.png` });
}
await browser.close();
console.log('ok');

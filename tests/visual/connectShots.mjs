// Connected-builds screenshots + fps. Needs a dev server: `pnpm vite --port 5301` then
// `node tests/visual/connectShots.mjs <outDir> <prefix>` → <outDir>/<prefix>-{wall,tower,stairs,destroyed,field}.png
// Headless only. LAB_URL overrides the page (used to shoot the pre-change tree for "before" images).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'shots';
const prefix = process.argv[3] ?? 'connect';
const base = process.env.LAB_URL ?? 'http://localhost:5301/tests/visual/connect.html';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 800)));
await page.goto(base);
await page.waitForFunction(() => window.lab?.ready, null, { timeout: 90_000 });
await page.waitForTimeout(2000);
const lab = (fn, ...a) => page.evaluate(([f, x]) => window.lab[f](...x), [fn, a]);

for (const [scene, name] of [['wallRun', 'wall'], ['tower', 'tower'], ['staircase', 'stairs']]) {
  await lab(scene);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/${prefix}-${name}.png` });
}
// destroy the 2nd steel plate of the wall run: its neighbours re-show their frames
await lab('wallRun');
await page.waitForTimeout(3000);
await lab('destroy', 1);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/${prefix}-destroyed.png` });

await lab('field');
await page.waitForTimeout(2500);
console.log('fps', JSON.stringify(await lab('measure', 6000)));
await page.screenshot({ path: `${out}/${prefix}-field.png` });
await browser.close();

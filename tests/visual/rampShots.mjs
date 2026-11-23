// node rampShots.mjs <url> <outDir> <prefix>: ramp chain from the side / below / under three-quarter / above, plus the staircase.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const [url, out, prefix] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
await page.goto(url);
await page.waitForFunction(() => window.lab?.ready, null, { timeout: 120_000 });
await page.waitForTimeout(2000);
const lab = (fn, ...a) => page.evaluate(([f, x]) => window.lab[f](...x), [fn, a]);
const { x0, z0, GY } = await lab('rampChain');
const views = {
  side: [x0 + 8, GY + 2.2, z0 + 3, x0, GY + 2.2, z0 + 3],
  below: [x0 + 2.2, GY + 0.6, z0 + 2.0, x0, GY + 3.6, z0 + 5.5],
  under3q: [x0 - 4, GY + 1.0, z0 + 9, x0, GY + 2.8, z0 + 3],
  above: [x0 + 5, GY + 7, z0 - 2, x0, GY + 2, z0 + 3],
};
for (const [name, v] of Object.entries(views)) {
  await lab('cam', ...v);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${prefix}-ramp-${name}.png` });
}
await lab('staircase');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/${prefix}-staircase.png` });
await browser.close();

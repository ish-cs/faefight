// FPS of the piece-damage lab: empty scene vs 100 damaged pieces vs 100 pieces under a continuous firefight.
// Needs `pnpm vite --port 5299`; `node tests/visual/perf.mjs [headed]`.
import { chromium } from '@playwright/test';

const headed = process.argv[2] === 'headed';
const browser = await chromium.launch({ channel: 'chromium', headless: !headed, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(process.env.LAB_URL ?? 'http://localhost:5299/tests/visual/piece-damage.html');
await page.waitForFunction(() => window.lab?.ready, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const ev = (f) => page.evaluate(f);
await ev(() => window.lab.setup('wood', []));
await page.waitForTimeout(500);
console.log('empty    ', JSON.stringify(await ev(() => window.lab.measure(3000))));
await ev(() => window.lab.field(100));
await page.waitForTimeout(800);
console.log('field100 ', JSON.stringify(await ev(() => window.lab.measure(4000))));
await ev(() => window.lab.firefight(true));
await page.waitForTimeout(1500);
console.log('firefight', JSON.stringify(await ev(() => window.lab.measure(6000))));
await browser.close();

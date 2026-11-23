// In a real vs-bot match (?debug=1): place sandbags, shoot them with a pistol, screenshot the damage.
// Needs `pnpm vite --port 5299`; `node tests/visual/ingame.mjs <out.png>`.
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'ingame.png';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5299/?debug=1');
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 60_000 });
await page.waitForTimeout(2000);
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me.island];
await dbg('give', { pieces: { sandbags: 1 }, weapons: { pistol: { mag: 12, spare: 200 } } });
await dbg('teleport', home.center.x, home.center.z);
await page.waitForTimeout(600);
await page.keyboard.press('KeyB');
await page.keyboard.press('Digit1');
await page.waitForTimeout(400);
await page.mouse.click(640, 360);
await page.waitForTimeout(500);
await page.keyboard.press('KeyB');
await page.keyboard.press('Digit2');
await page.evaluate(() => { window.__faefight.input.pitch = -0.28; });
await page.waitForTimeout(300);
const piece = () => page.evaluate((id) => window.__faefight.snapshot().pieces.find((p) => p.owner === id && p.kind === 'sandbags'), humanId);
const before = await piece();
for (let i = 0; i < 10; i++) {
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(260);
}
await page.waitForTimeout(150);
const after = await piece();
await page.screenshot({ path: out });
console.log(JSON.stringify({ before: before?.hp, after: after?.hp, errors }));
await browser.close();

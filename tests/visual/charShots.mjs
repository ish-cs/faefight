// Character screenshots + frame timing from the character lab (tests/visual/chars.html).
// Needs a server: `pnpm vite preview`/`pnpm vite --port 5299`, then `node tests/visual/charShots.mjs <prefix> [shots|perf|all]`
// → <prefix>-closeup.png, -group.png, -shop.png, -hands.png (+ -hands-pistol.png, -far.png).
import { chromium } from '@playwright/test';

const prefix = process.argv[2] ?? 'chars';
const mode = process.argv[3] ?? 'shots';
const base = process.env.LAB_URL ?? 'http://localhost:5299/tests/visual/chars.html';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(120_000);
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
await page.addInitScript(() => { try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, video: { quality: 'high', dynamicResolution: false } })); } catch { /* */ } });
await page.goto(base);
await page.waitForFunction(() => window.lab?.ready, null, { timeout: 90_000 });
await page.waitForTimeout(2500);
const lab = (fn, ...a) => page.evaluate(([f, x]) => window.lab[f](...x), [fn, a]);

if (mode === 'shots' || mode === 'all') {
  for (const s of ['face', 'closeup', 'back', 'group', 'shop', 'far']) {
    await lab('setup', s);
    await page.waitForTimeout(s === 'shop' ? 2600 : 2000);
    await page.screenshot({ path: `${prefix}-${s}.png` });
  }
  await lab('setup', 'fp');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${prefix}-hands.png` });
  await lab('fpWeapon', 'pistol');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${prefix}-hands-pistol.png` });
  await lab('fpWeapon', 'fists');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${prefix}-hands-fists.png` });
}
if (mode === 'perf' || mode === 'all') {
  for (const s of ['group', 'far']) {
    await lab('setup', s);
    await page.waitForTimeout(1500);
    console.log(s, JSON.stringify(await lab('measure', 4000)));
  }
}
await browser.close();

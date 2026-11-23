// Screenshots of the piece-damage lab. Needs a dev server: `pnpm vite --port 5299` then
// `node tests/visual/shots.mjs <outDir> [mode]` (mode: tiers | destroy | far | perf | all).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'shots';
const mode = process.argv[3] ?? 'all';
const base = process.env.LAB_URL ?? 'http://localhost:5299/tests/visual/piece-damage.html';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
await page.goto(base);
await page.waitForFunction(() => window.lab?.ready, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const lab = async (fn, ...a) => { if (fn === 'setup') await page.waitForTimeout(3200); return page.evaluate(([f, x]) => window.lab[f](...x), [fn, a]); };

const kinds = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'];
if (mode === 'tiers' || mode === 'all') {
  for (const k of kinds) {
    await lab('setup', k);
    await lab('shootToTier');
    await page.waitForTimeout(1800); // impact particles gone, holes stay
    await page.screenshot({ path: `${out}/tier-${k}.png` });
  }
}
if (mode === 'far' || mode === 'all') {
  for (const k of ['wood', 'metal', 'sandbags', 'steel']) {
    await lab('setup', k, [1, 0.6, 0.25], 22);
    await lab('shootToTier');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/far-${k}.png` });
  }
}
if (mode === 'destroy' || mode === 'all') {
  const ids = await lab('setup', 'wood', [0.2, 0.2, 0.2]);
  await page.evaluate((i) => { window.lab.destroy(i[0]); }, ids);
  await page.waitForTimeout(150);
  await page.evaluate((i) => { window.lab.destroy(i[1]); }, ids);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/destroy-wood.png` });
  const c = await lab('setup', 'container', [0.2]);
  await lab('destroy', c[0]);
  await page.waitForTimeout(380);
  await page.screenshot({ path: `${out}/destroy-container.png` });
  const s = await lab('setup', 'metal', [0.3, 0.3, 0.3]);
  await lab('shoot', s[1], 6);
  await page.waitForTimeout(40);
  await page.screenshot({ path: `${out}/impact-metal.png` });
  const sb = await lab('setup', 'sandbags', [0.2, 0.2, 0.2]);
  await page.evaluate((i) => { for (const x of i) window.lab.destroy(x); }, sb);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/destroy-sandbags.png` });
}
if (mode === 'impacts' || mode === 'all') {
  for (const k of ['steel', 'wood', 'sandbags']) {
    const ids = await lab('setup', k, [0.9], 3);
    await page.evaluate((id) => { window.lab.shoot(id, 3); setTimeout(() => window.lab.shoot(id, 3), 60); }, ids[0]);
    await page.waitForTimeout(110);
    await page.screenshot({ path: `${out}/impact-${k}.png` });
  }
}
if (mode === 'perf' || mode === 'all') {
  await lab('field', 100);
  await page.waitForTimeout(1000);
  console.log('static', JSON.stringify(await lab('measure', 4000)));
  await lab('firefight', true);
  await page.waitForTimeout(1500);
  console.log('firefight', JSON.stringify(await lab('measure', 6000)));
  await page.screenshot({ path: `${out}/perf-field.png` });
  await lab('firefight', false);
}
await browser.close();

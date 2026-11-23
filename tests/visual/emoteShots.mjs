// Front views of every emote (docs/screens/emotes-poses*.png). Needs a dev server:
// `pnpm vite --port 5332 --strictPort`, then `node tests/visual/emoteShots.mjs [outDir] [t=1.0,...]`.
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'docs/screens';
const ts = (process.argv[3] ?? '1.0').split(',');
const base = process.env.LAB_URL ?? 'http://localhost:5332';
const extra = process.env.LAB_QS ? `&${process.env.LAB_QS}` : '';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
for (const t of ts) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text().slice(0, 300)); });
  await page.goto(`${base}/tests/visual/emote-lab.html?t=${t}${extra}`);
  await page.waitForFunction(() => window.emoteLab?.ready, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const path = `${out}/emotes-poses${ts.length > 1 ? `-${t}` : ''}.png`;
  await page.screenshot({ path });
  console.log(path);
  await page.close();
}
await browser.close();

// Lobby map thumbnails, rendered offline from a real (headless) match: public/maps/<template>.jpg, 320×180.
// Needs a dev server: `pnpm vite --port 5347 --strictPort`, then `node tests/visual/mapThumbs.mjs [templates=harbor,yard]`.
// Spectates (/spectate) and flies the free camera high over the map, HUD hidden, then downscales in the page.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const templates = (process.argv[2] ?? 'harbor,yard').split(',');
const base = process.env.MAP_URL ?? 'http://localhost:5347';
const out = 'public/maps';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
for (const tpl of templates) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true } })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${tpl}] pageerror`, String(e).slice(0, 300)));
  await page.goto(`${base}/?debug=1`);
  await page.getByTestId(`menu-map-${tpl}`).click();
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
  await page.waitForTimeout(2000);
  // Watch instead of play: free-fly camera.
  await page.locator('canvas.game').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('/spectate');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__faefight.spectator().active, null, { timeout: 10_000 });
  const def = await page.evaluate(() => window.__faefight.mapDef());
  const pts = [...def.islands.map((i) => i.center), def.center.center];
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cz = pts.reduce((a, p) => a + p.z, 0) / pts.length;
  const reach = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.z - cz))) + 25;
  const from = { x: cx + reach * 0.55, y: reach * 0.75, z: cz + reach * 0.75 };
  const yaw = Math.atan2(-(cx - from.x), -(cz - from.z)); // forward(yaw) = (-sin, -cos)
  const pitch = -Math.atan2(from.y - 2, Math.hypot(cx - from.x, cz - from.z));
  await page.evaluate(([f, yaw, pitch]) => {
    window.__faefight.spectateAt(f.x, f.y, f.z);
    window.__faefight.input.yaw = yaw; window.__faefight.input.pitch = pitch;
    const st = document.createElement('style');
    st.textContent = '#app > :not(canvas), body > :not(#app) { visibility: hidden !important; }';
    document.head.append(st);
  }, [from, yaw, pitch]);
  await page.waitForTimeout(3000);
  const png = await page.screenshot({ type: 'png' });
  const jpg = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, 320, 180);
    return c.toDataURL('image/jpeg', 0.72).split(',')[1];
  }, png.toString('base64'));
  const buf = Buffer.from(jpg, 'base64');
  writeFileSync(`${out}/${tpl}.jpg`, buf);
  console.log(JSON.stringify({ tpl, bytes: buf.length, from, reach: Math.round(reach) }));
  await ctx.close();
}
await browser.close();

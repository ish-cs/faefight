// Free-camera views of a backdrop quay (camera overridden each frame). node quaycam.mjs <outPrefix> [quality]
import { chromium } from '@playwright/test';
const prefix = process.argv[2];
const q = process.argv[3] ?? 'ultra';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => { try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { dynamicResolution: false } })); } catch { } });
await page.goto(`${process.env.GAME_URL}/?debug=1&bots=7`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 120_000 });
await page.evaluate((q) => window.__faefight.renderer.world.sky.setQuality(q), q);
await page.evaluate(() => {
  const f = window.__faefight, r = f.renderer;
  const orig = r.render.bind(r);
  window.__cam = null;
  r.render = (y) => { if (window.__cam) { const c = window.__cam; r.camera.position.set(...c.p); r.camera.lookAt(...c.t); r.camera.updateMatrixWorld(); } orig(y); };
});
const hum = await page.evaluate(() => window.__faefight.humanId());
const map = await page.evaluate(() => window.__faefight.map());
const snap = await page.evaluate(() => window.__faefight.snapshot());
const isl = map[snap.players.find((p) => p.id === hum).island ?? 0];
const yaw = isl.bunker.facingYaw, c = Math.cos(yaw), s = Math.sin(yaw);
const W = (x, y, z) => [isl.center.x + x * c + z * s, y, isl.center.z - x * s + z * c];
const z0 = isl.radius + 14;
const views = {
  aerial: [W(0, 45, z0 - 20), W(0, 2, z0 + 35)],
  left: [W(-28, 9, z0 + 4), W(-20, 2, z0 + 30)],
  right: [W(26, 9, z0 + 4), W(20, 2, z0 + 30)],
  back: [W(0, 12, z0 + 40), W(0, 2, z0 + 70)],
  close: [W(-6, 4, z0 + 30), W(-2, 1.5, z0 + 42)],
  island: [W(0, 20, -8), W(0, 2, 6)],
};
for (const [k, [p, t]] of Object.entries(views)) {
  await page.evaluate(([p, t]) => { window.__cam = { p, t }; }, [p, t]);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${prefix}-${k}.png` });
}
console.log(JSON.stringify(await page.evaluate(() => ({ props: window.__faefight.renderer.world.props.stats().meshes, info: window.__faefight.renderInfo() }))));
console.log(JSON.stringify({ errors: errors.slice(0, 5) }));
await browser.close();

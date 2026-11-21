// Day/night cycle: same views at day / golden hour / dusk / night / night + storm. 1v1 vs a bot (?debug=1&bots=1), 1600×900.
// Needs a server (`pnpm vite --port 5299` or vite preview); run under heavy.sh:
//   node tests/visual/dayNight.mjs <outPrefix> [quality=high] [competitive=0]
import { chromium } from '@playwright/test';

const prefix = process.argv[2] ?? 'daynight';
const quality = process.argv[3] ?? 'high';
const competitive = process.argv[4] === '1';
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const SD = 900;
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((q) => {
  try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: q.q, dynamicResolution: false, competitive: q.c } })); } catch { /* fresh profile */ }
}, { q: quality, c: competitive });
await page.goto(`${url}/?debug=1&bots=1`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 120_000 });
await page.waitForTimeout(2000);
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me.island ?? 0];
const L = Math.hypot(home.center.x, home.center.z);
const ux = home.center.x / L, uz = home.center.z / L;
const at = (d, side = 0) => ({ x: ux * d - uz * side, z: uz * d + ux * side });
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
const look = (yaw, pitch) => page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [yaw, pitch]);
const views = [
  { name: 'out', d: L - 6, side: 3, fx: -ux, fz: -uz, pitch: 0.05 }, // looking toward the centre
  { name: 'home', d: L - 10, side: -2, fx: ux, fz: uz, pitch: 0.02 }, // looking out toward home island + harbor
];
const phases = [['day', 30], ['afternoon', 0.55 * SD], ['golden', 0.7 * SD], ['dusk', 0.83 * SD], ['night', 0.97 * SD]];
const info = [];
for (const [name, t] of phases) {
  await dbg('time', t);
  await page.waitForTimeout(1200);
  for (const v of views) {
    const p = at(v.d, v.side);
    await dbg('teleport', p.x, p.z);
    await dbg('hp', 100);
    await look(yawTo(v.fx, v.fz), v.pitch);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${prefix}-${name}-${v.name}.png` });
  }
  info.push({ name, t, phase: await page.evaluate(() => window.__faefight.renderer.dayNight.phase) });
}
// Night + storm (sudden death), and a lightning flash.
await dbg('time', SD - 0.5);
await page.waitForTimeout(8000);
const p = at(L - 6, 3);
await dbg('teleport', p.x, p.z);
await dbg('hp', 100);
await look(yawTo(-ux, -uz), 0.05);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${prefix}-storm-out.png` });
const s = at(L - 14, 3);
await dbg('strike', s.x, s.z);
await page.waitForTimeout(1060);
await page.screenshot({ path: `${prefix}-storm-flash.png` });
console.log(JSON.stringify({ info, errors: errors.slice(0, 10) }));
await browser.close();

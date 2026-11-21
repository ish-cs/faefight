// Sudden-death storm: screenshots + frame times clear vs storm per quality preset. 1v1 vs a bot (?debug=1&bots=1), 1600×900.
// Needs `pnpm vite --port 5299`; `node tests/visual/storm.mjs <outPrefix> [shots|perf|all|before]`
//   shots  → <prefix>-after.png (inside the ring, wall + rain), -telegraph.png, -flash.png, -outside.png
//   before → <prefix>-before.png: same spot at sudden death on a build without the storm (needs the debug `time` cmd)
//   perf   → frame-time stats per preset, clear sky (14:30) vs storm.
import { chromium } from '@playwright/test';

const prefix = process.argv[2] ?? 'storm';
const mode = process.argv[3] ?? 'all';
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const SD = 900;
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
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
// Unit vector from the map centre (origin) out to my island.
const L = Math.hypot(home.center.x, home.center.z);
const ux = home.center.x / L, uz = home.center.z / L;
const at = (d, side = 0) => ({ x: ux * d - uz * side, z: uz * d + ux * side });
const look = (yaw, pitch) => page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [yaw, pitch]);
// three.js yaw: forward = (-sin yaw, -cos yaw)
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
const setQuality = (q) => page.evaluate((q) => window.__faefight.renderer.world.sky.setQuality(q), q);
const place = async (d, side, fx, fz, pitch = 0.04) => {
  const p = at(d, side);
  await dbg('teleport', p.x, p.z);
  await look(yawTo(fx, fz), pitch);
};
const keepAlive = () => dbg('hp', 100);

await setQuality(process.argv[4] ?? 'high');
if (mode === 'before') {
  await dbg('time', SD - 1);
  await page.waitForTimeout(9000);
  await place(L - 12, 4, ux, uz);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${prefix}-before.png` });
} else {
  if (mode === 'shots' || mode === 'all') {
    await dbg('time', SD - 1);
    await page.waitForTimeout(9000); // weather eases in
    await dbg('time', SD + 100); // ring ~41 m from the centre: through the middle of the islands
    await place(L - 12, 4, ux, uz);
    await page.waitForTimeout(2500);
    await keepAlive();
    await page.screenshot({ path: `${prefix}-after.png` });
    // A strike called 9 m ahead: the telegraph, then the bolt.
    const s = at(L - 3, 4);
    await dbg('strike', s.x, s.z);
    await page.waitForTimeout(650);
    await page.screenshot({ path: `${prefix}-telegraph.png` });
    for (let i = 0; i < 6; i++) {
      await dbg('strike', s.x + 3, s.z);
      await page.waitForTimeout(1060 + i * 25);
      await page.screenshot({ path: `${prefix}-flash-${i}.png` });
    }
    // In the storm, looking back at the wall.
    await keepAlive();
    await place(L + 8, 4, -ux, -uz, 0.06);
    await page.waitForTimeout(1800);
    await keepAlive();
    await page.screenshot({ path: `${prefix}-outside.png` });
    await keepAlive();
  }
  if (mode === 'perf' || mode === 'all') {
    const out = {};
    const measure = async () => {
      const acc = [];
      for (const [d, side, fx, fz] of [[L - 12, 4, ux, uz], [L - 15, -6, -uz, ux], [L - 10, 0, -ux, -uz]]) {
        await keepAlive();
        await place(d, side, fx, fz);
        await page.waitForTimeout(600);
        await dbg('resetFrames');
        await page.waitForTimeout(2500);
        acc.push(await dbg('frames'));
      }
      const avg = acc.reduce((a, f) => a + f.avg, 0) / acc.length;
      return { avgMs: +avg.toFixed(2), fps: +(1000 / avg).toFixed(0), p95: +Math.max(...acc.map((f) => f.p95)).toFixed(2) };
    };
    // Sudden death can't be undone: every preset clear first (fresh match only), then the storm.
    const qs = ['low', 'high', 'ultra'];
    const fresh = !(await dbg('snapshot')).suddenDeath;
    if (fresh) for (const q of qs) { await setQuality(q); await page.waitForTimeout(1500); out[q] = { clear: await measure() }; }
    await dbg('time', SD - 0.5);
    await page.waitForTimeout(9000);
    for (const q of qs) {
      await dbg('time', SD + 100);
      await setQuality(q);
      await page.waitForTimeout(1500);
      out[q] = { ...out[q], storm: await measure() };
      if (process.env.STORM_PARTS) {
        // Cost breakdown: the same spots with the rain, then the wall, hidden.
        out[q].noRain = await (async () => { await page.evaluate(() => { window.__faefight.renderer.storm.debugHide = 'rain'; }); return measure(); })();
        out[q].noWall = await (async () => { await page.evaluate(() => { window.__faefight.renderer.storm.debugHide = 'wall'; }); return measure(); })();
        await page.evaluate(() => { window.__faefight.renderer.storm.debugHide = null; });
      }
    }
    console.log(JSON.stringify(out));
  }
}
console.log(JSON.stringify({ errors: errors.slice(0, 10) }));
await browser.close();

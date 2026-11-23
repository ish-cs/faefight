// Island beacons: screenshots by day, at night and in the storm (sudden death seals every bunker), plus a sealed
// bunker up close and an elimination's shutdown mid-animation. 8 players (?debug=1&bots=7), 1600×900.
// Needs a server (vite preview); run under heavy.sh:
//   node tests/visual/beacons.mjs <outDir> [quality=ultra]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'beacons';
const quality = process.argv[3] ?? 'ultra';
const url = process.env.GAME_URL ?? 'http://localhost:5299';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((q) => {
  try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, video: { quality: q, dynamicResolution: false }, audio: { muted: true }, onboarding: { howToSeen: true } })); } catch { /* fresh profile */ }
}, quality);
await page.goto(`${url}/?debug=1&bots=7`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 120_000 });
await page.waitForTimeout(2000);
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const snap0 = await dbg('snapshot');
const me = snap0.players.find((p) => p.id === humanId);
const home = map[me.island ?? 0];
const L = Math.hypot(home.center.x, home.center.z), ux = home.center.x / L, uz = home.center.z / L;
const bunker = home.bunker.center;
/** Pin the camera (renderer.debugView): eye and target in world metres. */
const view = (eye, look) => page.evaluate(([e, l]) => {
  const r = window.__faefight.renderer, V = r.camera.position.constructor;
  r.debugView = { pos: new V(e[0], e[1], e[2]), look: new V(l[0], l[1], l[2]) };
}, [eye, look]);
const keepAlive = () => dbg('hp', 100);
const shot = async (name) => { await keepAlive(); await page.screenshot({ path: `${out}/${name}.png` }); console.log(`shot ${out}/${name}.png`); };
const state = () => page.evaluate(() => {
  const b = window.__faefight.renderer.beacons;
  const list = [];
  for (let i = 0; i < b.states.count; i++) { const e = b.states.at(i); list.push(`${e.phase}${e.phase === 'down' ? `(cut ${e.cut.toFixed(2)})` : ''}`); }
  return { drawn: b.mesh.geometry.instanceCount, list };
});

// Views: high over my island looking across the map; at ground level on my island; close on my bunker.
const overview = () => view([ux * (L + 45), 55, uz * (L + 45)], [0, 20, 0]);
const ground = () => view([ux * (L - 14) - uz * 6, home.groundY + 2.2, uz * (L - 14) + ux * 6], [0, 30, 0]);
const close = () => view([bunker.x + ux * 30 - uz * 18, home.groundY + 10, bunker.z + uz * 30 + ux * 18], [bunker.x, home.groundY + 25, bunker.z]);

await dbg('teleport', ux * (L - 10), uz * (L - 10));
await page.waitForTimeout(1500);
console.log('day', JSON.stringify(await state()));
await overview(); await page.waitForTimeout(800); await shot('day-overview');
await ground(); await page.waitForTimeout(800); await shot('day-ground');

// Seal my bunker (an enemy plate in each doorway): thin, flickering beam.
const bot = snap0.players.find((p) => p.id !== humanId);
for (const door of [0, 1, 2]) await dbg('plugDoor', door, bot.id);
await page.waitForTimeout(1500);
await close(); await page.waitForTimeout(600); await shot('day-sealed-close');
console.log('sealed', JSON.stringify(await state()));

// Eliminate the bot across the map: burst, collapse, gone.
const far = (p) => Math.hypot(map[p.island].center.x - home.center.x, map[p.island].center.z - home.center.z);
const victim = snap0.players.filter((p) => p.id !== humanId && p.id !== bot.id).sort((a, b) => far(a) - far(b))[3];
await overview(); await page.waitForTimeout(500);
// Slow the animation 10× so the screenshots (each ~1 s at ultra) land inside it.
await page.evaluate(() => { window.__faefight.renderer.beacons.timeScale = 0.1; });
await dbg('eliminate', victim.id);
await page.waitForTimeout(1000); await shot('day-shutdown-burst');
console.log('shutdown', JSON.stringify(await state()));
await page.waitForTimeout(7000); await shot('day-shutdown-collapse');
console.log('shutdown', JSON.stringify(await state()));
await page.evaluate(() => { window.__faefight.renderer.beacons.timeScale = 1; });
await page.waitForTimeout(2000); await shot('day-shutdown-gone');

// Name tags next to their HUD chips: line five bots up in front of the camera.
const eye = [ux * (L - 14), home.groundY + 1.8, uz * (L - 14)];
await view(eye, [ux * (L - 24), home.groundY + 1.8, uz * (L - 24)]);
const lineup = snap0.players.filter((p) => p.id !== humanId && p.id !== victim.id).slice(0, 6);
for (let k = 0; k < lineup.length; k++) {
  const side = (k - (lineup.length - 1) / 2) * 2.2, d = L - 24;
  await dbg('teleport', ux * d - uz * side, uz * d + ux * side, lineup[k].id);
}
await page.waitForTimeout(600); await shot('day-tags');

// Night (clear), then the storm (sudden death: every bunker sealed together).
await dbg('time', 870);
await page.waitForTimeout(6000);
await overview(); await page.waitForTimeout(800); await shot('night-overview');
await ground(); await page.waitForTimeout(800); await shot('night-ground');
// Sudden death eliminates whoever dies now (likely us, sealed in): hide the HUD/end screen so the scene shows.
await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
await dbg('time', 905);
await page.waitForTimeout(9000); // the weather eases in
await overview(); await page.waitForTimeout(800); await shot('storm-overview');
await ground(); await page.waitForTimeout(800); await shot('storm-ground');
console.log('storm', JSON.stringify(await state()));

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();

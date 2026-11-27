// Same-view graphics screenshots for before/after comparisons: spawn island, mid-fight (centre island, bots), and
// ocean at sunset (match time 675 s, looking at the sun across the sea). Headless, 1600×900, ultra, Retina DPR 2.
// Needs a running server (GAME_URL); run under the heavy lock:
//   node tests/visual/gfxShots.mjs --out=/path/prefix [--preset=ultra] [--dpr=2] [--params=upscale=cas]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const out = arg('out', 'shot');
const quality = arg('preset', 'ultra');
const dpr = Number(arg('dpr', '2'));
const params = arg('params', '');
/** map template for the menu picker (harbor | yard); yard has the built-in container cover for the close-up view */
const mapName = arg('map', 'harbor');
const url = process.env.GAME_URL ?? 'http://localhost:5299';

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
  page.setDefaultTimeout(240_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(([q, m]) => {
    try {
      localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: q, dynamicResolution: false } }));
      localStorage.setItem('faefight.map', m);
    } catch { /* fresh profile */ }
  }, [quality, mapName]);
  await page.goto(`${url}/?debug=1&bots=7${params ? `&${params}` : ''}`);
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 120_000 });
  await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
  await page.waitForTimeout(2500);
  const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
  const humanId = await dbg('humanId');
  const map = await dbg('map');
  const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
  const home = map[me.island ?? 0];
  const yaw0 = home.bunker.facingYaw;
  const toWorld = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
  const look = async (w, yaw, pitch, name) => {
    await dbg('hp', 100000);
    await dbg('teleport', w.x, w.z);
    await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [yaw, pitch]);
    await page.waitForTimeout(2000); // camera settles, TAAU history converges
    await page.screenshot({ path: `${out}-${name}.png` });
  };
  // spawn island: from the island's front edge back toward the bunker
  const a = toWorld(-6, 14), b = toWorld(0, 0);
  await look(a, Math.atan2(-(b.x - a.x), -(b.z - a.z)), -0.08, 'spawn');
  // close-up container: the built-in container cover nearest the home island centre, from 4.5 m on its open side
  const def = await dbg('mapDef');
  const boxes = (def?.statics ?? []).filter((st) => st.look !== 'barrier');
  if (boxes.length) {
    const d2 = (st) => (st.center.x - home.center.x) ** 2 + (st.center.z - home.center.z) ** 2;
    const st = boxes.reduce((a, b) => (d2(b) < d2(a) ? b : a));
    const ox = home.center.x - st.center.x, oz = home.center.z - st.center.z, ol = Math.hypot(ox, oz) || 1;
    const p = { x: st.center.x + (ox / ol) * 4.5, z: st.center.z + (oz / ol) * 4.5 };
    await look(p, Math.atan2(-(st.center.x - p.x), -(st.center.z - p.z)), -0.05, 'container');
  } else console.log('no container cover on this map');
  // close-up bunker: the front door's jambs (spalls, rebar, pockmarks) from ~4 m, a little off-axis
  const bk = home.bunker, by = bk.facingYaw;
  const bWorld = (x, z) => ({ x: bk.center.x + x * Math.cos(by) + z * Math.sin(by), z: bk.center.z - x * Math.sin(by) + z * Math.cos(by) });
  { const p = bWorld(-1.6, -4.6), t = bWorld(0.8, -2.3); await look(p, Math.atan2(-(t.x - p.x), -(t.z - p.z)), 0.02, 'bunker'); }
  // close-up quay: from the far end of the home pier back at the rim wall beside it (beam, fenders, tide zone)
  const docks = (def?.docks ?? []).filter((d) => d.island === home.index);
  if (docks.length) {
    const dd = (d) => Math.hypot(d.center.x - home.center.x, d.center.z - home.center.z);
    const far = docks.reduce((a, b) => (dd(b) > dd(a) ? b : a)), near = docks.reduce((a, b) => (dd(b) < dd(a) ? b : a));
    const phi = Math.atan2(far.center.z - home.center.z, far.center.x - home.center.x) + 0.24;
    const t = { x: home.center.x + home.radius * Math.cos(phi), z: home.center.z + home.radius * Math.sin(phi) };
    const at = { x: (far.center.x + near.center.x) / 2, z: (far.center.z + near.center.z) / 2 };
    await look(at, Math.atan2(-(t.x - at.x), -(t.z - at.z)), -0.3, 'quay');
  } else console.log('no pier on the home island');
  // mid-fight: on the centre island looking across at the other islands and the bots
  const L = Math.hypot(home.center.x, home.center.z), ux = home.center.x / L, uz = home.center.z / L;
  await dbg('time', 150);
  await page.waitForTimeout(1500);
  await look({ x: ux * 6, z: uz * 6 }, Math.atan2(uz, -ux), 0.0, 'midfight');
  // ocean at sunset: sun at azimuth ~45° (dayCycle p≈0.75 → 675 s of 900); camera yaw = azimuth + π
  await dbg('time', 675);
  await page.waitForTimeout(4000); // key light steps every 3 s
  const az = (45 * Math.PI) / 180;
  const sx = Math.sin(az), sz = Math.cos(az);
  await look({ x: home.center.x + sx * 10, z: home.center.z + sz * 10 }, az + Math.PI, 0.04, 'sunset');
  if (errors.length) console.log('errors:', JSON.stringify(errors.slice(0, 5)));
  console.log(`shots: ${out}-{spawn,container,bunker,quay,midfight,sunset}.png`);
} finally {
  await browser.close();
}

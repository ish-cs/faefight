// Death ragdolls, footprints and wet ground, in a vs-bot match (?debug=1&bots=1), 1280×720.
// Needs a server (vite preview) at GAME_URL; `node tests/visual/ragdoll.mjs <outPrefix>` writes
//   -shot-{0,1,2}.png   bot killed by a shot (just after, falling, settled)
//   -blast-{0,1}.png    bot killed next to a rocket blast
//   -prints.png         looking back at my trail across sand
//   -wet.png / -wetprints.png   the same spots soaked (?wet=1), plus prints on the wet quay
import { chromium } from '@playwright/test';

const prefix = process.argv[2] ?? 'ragdoll';
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
const errors = [];

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${url}/?debug=1&bots=1${query}`);
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
  await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  return page;
}
const api = (page) => (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const view = (page, pos, look) => page.evaluate(([p, l]) => {
  const r = window.__faefight.renderer;
  r.debugView = { pos: new r.camera.position.constructor(p.x, p.y, p.z), look: new r.camera.position.constructor(l.x, l.y, l.z) };
}, [pos, look]);

/** A spot on my island where the ground is `surface` (scans the map's surface lookup). */
const findGround = (page, island, surface) => page.evaluate(([island, surface]) => {
  const f = window.__faefight, isl = f.map()[island], surf = f.renderer.world.impacts.surf;
  for (let r = 4; r < isl.radius - 3; r += 1.5) for (let a = 0; a < Math.PI * 2; a += 0.2) {
    const x = isl.center.x + Math.cos(a) * r, z = isl.center.z + Math.sin(a) * r;
    const ok = [0, 1.5, 3, 4.5].every((d) => surf.groundAt(x + d, z)?.surface === surface);
    if (ok) return { x, z, y: isl.groundY };
  }
  return null;
}, [island, surface]);

async function ragdolls(page) {
  const dbg = api(page);
  const humanId = await dbg('humanId');
  const snap = await dbg('snapshot');
  const me = snap.players.find((p) => p.id === humanId), bot = snap.players.find((p) => p.id !== humanId);
  const home = (await dbg('map'))[me.island];
  const g = home.groundY;
  const at = { x: home.center.x + 6, z: home.center.z + 6 };
  await dbg('teleport', at.x - 5, at.z, humanId);
  for (const [tag, blast] of [['shot', false], ['blast', true]]) {
    await dbg('teleport', at.x, at.z, bot.id);
    await page.waitForTimeout(1200);
    await view(page, { x: at.x - 4.5, y: g + 2.2, z: at.z + 3.5 }, { x: at.x, y: g + 0.6, z: at.z });
    if (blast) await dbg('explode', 'rocket', at.x + 1.2, at.z - 0.6, 0.3);
    await dbg('kill', bot.id, humanId);
    const times = blast ? [700, 2600] : [120, 500, 2400];
    let t = 0;
    for (let i = 0; i < times.length; i++) {
      await page.waitForTimeout(times[i] - t); t = times[i];
      await page.screenshot({ path: `${prefix}-${tag}-${i}.png` });
    }
    await page.waitForTimeout(3500); // respawn
  }
  const rd = await page.evaluate(() => {
    const av = window.__faefight.renderer.characters.avatars;
    return [...av.values()].map((a) => ({ ragdoll: !!a.ragdoll, awake: a.ragdollAwake }));
  });
  console.log('avatars after respawn', JSON.stringify(rd));
}

async function prints(page, tag) {
  const dbg = api(page);
  const humanId = await dbg('humanId');
  const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
  const home = (await dbg('map'))[me.island];
  for (const surface of tag === 'wet' ? ['sand', 'concrete'] : ['sand', 'gravel']) {
    const s = await findGround(page, me.island, surface);
    if (!s) { console.log(`no ${surface} found on island ${me.island}`); continue; }
    await dbg('teleport', s.x, s.z);
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__faefight.input.yaw = -Math.PI / 2; window.__faefight.input.pitch = 0; }); // face +x
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1600);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(500);
    const p = (await dbg('snapshot')).players.find((q) => q.id === humanId).pos;
    await view(page, { x: p.x + 1.5, y: home.groundY + 2.2, z: p.z + 1.6 }, { x: s.x + 1.5, y: home.groundY, z: s.z });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${prefix}-${tag}-${surface}.png` });
    await page.evaluate(() => { window.__faefight.renderer.debugView = null; });
  }
  const n = await page.evaluate(() => window.__faefight.renderer.world.footprints.mesh.count);
  console.log(`${tag}: ${n} prints laid`);
}

try {
  const dry = await open('');
  await ragdolls(dry);
  await prints(dry, 'prints');
  await dry.close();
  const wet = await open('&wet=1');
  await prints(wet, 'wet');
  await wet.close();
} finally {
  console.log(JSON.stringify({ errors: errors.slice(0, 12) }));
  await browser.close();
}

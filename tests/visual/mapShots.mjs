// Map art screenshots + render stats in a real vs-bot match (?debug=1).
// Needs a dev server: `pnpm vite --port 5331 --strictPort`, then
// `node tests/visual/mapShots.mjs [outDir] [templates=harbor,yard] [shots=1]`.
// Prints renderInfo (draw calls / triangles) and the HUD fps per template.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'docs/screens';
const templates = (process.argv[3] ?? 'harbor,yard').split(',');
const takeShots = (process.argv[4] ?? '1') === '1';
const base = process.env.MAP_URL ?? 'http://localhost:5331';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
for (const tpl of templates) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 500)));
  await page.goto(`${base}/?debug=1`);
  await page.getByTestId('menu-map').selectOption(tpl);
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
  const look = (yaw, pitch) => page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [yaw, pitch]);
  const def = await dbg('mapDef');
  const humanId = await dbg('humanId');
  const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
  const home = def.islands[me.island];
  // yaw convention: forward(yaw) = (-sin, -cos)
  const yawTo = (fx, fz, tx, tz) => Math.atan2(-(tx - fx), -(tz - fz));

  // overview: from the home island's back, looking across it toward the center island
  // from the center island's rim, looking across the gap at the home island and its cover
  const hl = Math.hypot(home.center.x, home.center.z);
  // the island nearest +X: the center's rim at 0° is clear of stations, barriers and lamps
  const isl = def.islands.reduce((a, b) => (b.center.x > a.center.x ? b : a));
  const cc = def.center.center; // off the origin with 2 players
  const back = { x: cc.x + def.center.radius - 2, z: cc.z + 0.5 };
  await dbg('teleport', back.x, back.z);
  await page.waitForTimeout(900);
  await look(yawTo(back.x, back.z, isl.center.x, isl.center.z), -0.05);
  await page.waitForTimeout(3500);
  const info = await dbg('renderInfo');
  const fps = await page.locator('.fps').textContent().catch(() => '?');
  if (takeShots) await page.screenshot({ path: `${out}/${tpl === 'yard' ? 'map-container-yard' : 'map-harbor'}.png` });
  console.log(JSON.stringify({ tpl, view: 'overview', info, fps, cosmetics: def.cosmetics.length, statics: def.statics.length }));

  // center island close-up
  const c = def.center;
  const pol = (r, deg) => ({ x: def.center.center.x + Math.cos((deg * Math.PI) / 180) * r, z: def.center.center.z + Math.sin((deg * Math.PI) / 180) * r });
  const from = pol(4.5, 318), to = pol(2.5, 140);
  await dbg('teleport', from.x, from.z);
  await page.waitForTimeout(900);
  await look(yawTo(from.x, from.z, to.x, to.z), -0.2);
  await page.waitForTimeout(2500);
  const info2 = await dbg('renderInfo');
  const fps2 = await page.locator('.fps').textContent().catch(() => '?');
  if (takeShots) await page.screenshot({ path: `${out}/${tpl === 'yard' ? 'center-island-yard' : 'center-island'}.png` });
  console.log(JSON.stringify({ tpl, view: 'center', info: info2, fps: fps2 }));

  // cosmetic breaking: shoot the nearest barrel on the center island with a rifle
  const target = def.cosmetics.filter((k) => k.kind === 'barrel' || k.kind === 'crate').sort((a, b) => Math.hypot(a.pos.x - c.center.x, a.pos.z - c.center.z) - Math.hypot(b.pos.x - c.center.x, b.pos.z - c.center.z))[0];
  if (target) {
    await page.evaluate(() => window.__faefight.give?.({ weapons: { pistol: { mag: 12, spare: 200 } } }));
    const dir = { x: target.pos.x - c.center.x, z: target.pos.z - c.center.z };
    const l = Math.hypot(dir.x, dir.z);
    const sx = target.pos.x - (dir.x / l) * 4, sz = target.pos.z - (dir.z / l) * 4;
    await dbg('teleport', sx, sz);
    await page.waitForTimeout(900);
    await page.keyboard.press('Digit1');
    const eye = 1.6;
    await look(yawTo(sx, sz, target.pos.x, target.pos.z), Math.atan2(target.pos.y + 0.45 - (2 + eye), 4));
    await page.waitForTimeout(400);
    const pitch0 = Math.atan2(target.pos.y + 0.45 - (2 + eye), 4);
    const yaw0 = yawTo(sx, sz, target.pos.x, target.pos.z);
    for (let i = 0; i < 24; i++) {
      await look(yaw0 + 0.05 * ((i % 5) - 2), pitch0 - 0.04 * Math.floor(i / 5));
      await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(200);
      if (((await dbg('snapshot')).broken ?? []).includes(target.id)) break;
    }
    await page.waitForTimeout(160);
    const broken = (await dbg('snapshot')).broken ?? [];
    if (takeShots) await page.screenshot({ path: `${out}/break-${tpl}.png` });
    console.log(JSON.stringify({ tpl, view: 'break', target: target.id, kind: target.kind, broken }));
  }
  console.log(JSON.stringify({ tpl, errors }));
  await page.close();
}
await browser.close();

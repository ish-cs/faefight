// Bunker firing slits: outside close-up + view out through a slit from inside, side by side.
// Needs a dev server: `pnpm vite --port 5331 --strictPort`, then `node tests/visual/bunkerShots.mjs [out.png] [harbor|yard]`.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const out = process.argv[2] ?? 'docs/screens/bunker-slits.png';
const tpl = process.argv[3] ?? 'harbor';
const base = process.env.MAP_URL ?? 'http://localhost:5331';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
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
const b = def.islands[me.island].bunker;
const yaw = b.facingYaw;
const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }, right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
const at = (f, s) => ({ x: b.center.x + fwd.x * f + right.x * s, z: b.center.z + fwd.z * f + right.z * s });

// outside: in front of the front wall, a little to the side, looking back at the bunker
const o = at(4.2, 2.2);
await dbg('teleport', o.x, o.z);
await page.waitForTimeout(900);
await look(yaw + Math.PI + 0.35, -0.02);
await page.waitForTimeout(1800);
const a = await page.screenshot();
// inside: just behind the left front-wall slit, looking out through it
const i = at(1.2, -1.55);
await dbg('teleport', i.x, i.z);
await page.waitForTimeout(900);
await look(yaw, 0.02);
await page.waitForTimeout(1800);
const c = await page.screenshot();

const comp = await browser.newPage({ viewport: { width: 1280, height: 360 } });
await comp.setContent('<canvas id="k" width="1280" height="360"></canvas>');
await comp.evaluate(async ([a, c]) => {
  const k = document.getElementById('k').getContext('2d');
  const load = (s) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = `data:image/png;base64,${s}`; });
  k.drawImage(await load(a), 0, 0, 640, 360);
  k.drawImage(await load(c), 640, 0, 640, 360);
}, [a.toString('base64'), c.toString('base64')]);
await comp.locator('#k').screenshot({ path: out });
console.log(JSON.stringify({ out, errors }));
await browser.close();
void readFileSync;

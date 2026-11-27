// Same-page A/B of a live render toggle (perf stage B): flips the toggle on/off in alternation on one page and one
// camera spot, so machine-load drift between separate runs (±20 %) cancels out. Per state: main-thread ms per frame
// (cpuAvg), ?perf submit ms, frame ms (vsync off) and GPU-done fps. 8-player vs-bot match, 1600×900.
//   GAME_URL=… node tests/visual/toggleAB.mjs --toggle=bundle [--preset=high] [--throttle=4] [--rounds=4] [--dpr=1]
// Toggles: bundle = render bundles (BundleGroup) off = drawn as plain groups (projected + culled per object).
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const preset = arg('preset', 'high');
const toggle = arg('toggle', 'bundle');
const throttle = Number(arg('throttle', '1'));
const rounds = Number(arg('rounds', '4'));
const dpr = Number(arg('dpr', '1'));
const sampleMs = Number(arg('sample', '2000'));
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const SPOTS = [
  { name: 'harbor', at: [6, 13], look: [14, 60], pitch: 0.02 },
  { name: 'across', at: [-3, -15], look: [-3, -80], pitch: -0.02 },
  { name: 'props', at: [-8, -12], look: [-1, -8], pitch: -0.32 },
];

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
page.setDefaultTimeout(240_000);
await page.addInitScript((q) => {
  localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: q, dynamicResolution: false, power: 'quality' } }));
}, preset);
await page.goto(`${url}/?debug=1&bots=7&perf`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(3000);
if (throttle > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me0 = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me0.island ?? 0];
const yaw0 = home.bunker.facingYaw;
const toWorld = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
const yawToward = (from, to) => { const a = toWorld(...from), b = toWorld(...to); return Math.atan2(-(b.x - a.x), -(b.z - a.z)); };

const set = (on) => page.evaluate(([t, on]) => {
  const sc = window.__faefight.renderer.scene;
  if (t === 'bundle') sc.traverse((o) => { if (o.type === 'BundleGroup') { o.isBundleGroup = on; if (on) o.needsUpdate = true; } });
}, [toggle, on]);

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const res = [];
for (const s of SPOTS) {
  await dbg('hp', 100000);
  const w = toWorld(...s.at);
  await dbg('teleport', w.x, w.z);
  await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [yawToward(s.at, s.look), s.pitch]);
  await page.waitForTimeout(1000);
  const acc = { on: [], off: [] };
  for (let r = 0; r < rounds * 2; r++) {
    const on = (r % 4 === 0 || r % 4 === 3); // on off off on: ABBA
    await set(on);
    await page.waitForTimeout(400);
    await dbg('resetFrames');
    await page.waitForTimeout(sampleMs);
    const f = await dbg('frames');
    const gfps = await page.evaluate(() => window.__faefight.gpuFps?.() ?? 0);
    const submit = (await dbg('perfProbe'))?.submit ?? 0;
    acc[on ? 'on' : 'off'].push({ cpu: f.cpuAvg, ms: f.avg, p99: f.p99, gfps, submit });
  }
  await set(true);
  const row = { spot: s.name };
  for (const k of ['on', 'off']) for (const m of ['cpu', 'submit', 'ms', 'p99', 'gfps']) row[`${k}.${m}`] = +med(acc[k].map((x) => x[m])).toFixed(3);
  res.push(row);
}
await browser.close();
console.log(`== toggle ${toggle} ${preset} ${throttle}x dpr${dpr} (medians of ${rounds} ABBA rounds)`);
console.log('| spot | cpu on/off ms | submit on/off | frame on/off ms | p99 on/off | GPU-done fps on/off |');
console.log('|---|---|---|---|---|---|');
for (const r of res) console.log(`| ${r.spot} | ${r['on.cpu']} / ${r['off.cpu']} | ${r['on.submit']} / ${r['off.submit']} | ${r['on.ms']} / ${r['off.ms']} | ${r['on.p99']} / ${r['off.p99']} | ${r['on.gfps']} / ${r['off.gfps']} |`);

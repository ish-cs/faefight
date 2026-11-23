// Per-frame GPU uploads (queue.writeBuffer) at one view, grouped by buffer label and size: finds which instance
// matrices / uniforms are re-uploaded every frame. 8-player match, ultra, headless.
//   GAME_URL=… node tests/visual/uploads.mjs [--spot=props|mid|harbor] [--preset=ultra] [--secs=3]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const preset = arg('preset', 'ultra');
const spot = arg('spot', 'props');
const secs = Number(arg('secs', '3'));
const label = arg('label', 'uploads');
const url = process.env.GAME_URL ?? 'http://localhost:5299';

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
await page.addInitScript((q) => {
  localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, video: { quality: q, dynamicResolution: false }, onboarding: { howToSeen: true } }));
  const rec = (window.__uploads = { on: false, by: new Map(), frames: 0 });
  const orig = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buf, off, data, dOff, size) {
    if (rec.on) {
      const bytes = size ?? (data.byteLength - (dOff ?? 0) * (data.BYTES_PER_ELEMENT ?? 1));
      const k = `${buf.label || '(unlabeled)'} [${buf.size}B]`;
      const e = rec.by.get(k) ?? { n: 0, bytes: 0 };
      e.n++; e.bytes += bytes;
      rec.by.set(k, e);
    }
    return orig.call(this, buf, off, data, dOff, size);
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { if (rec.on) rec.frames++; cb(t); });
}, preset);
await page.goto(`${url}/?debug=1&bots=7`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(2500);
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me.island ?? 0];
const y0 = home.bunker.facingYaw;
const W = (x, z) => ({ x: home.center.x + x * Math.cos(y0) + z * Math.sin(y0), z: home.center.z - x * Math.sin(y0) + z * Math.cos(y0) });
const L = Math.hypot(home.center.x, home.center.z), ux = home.center.x / L, uz = home.center.z / L;
const [at, to, pitch] = spot === 'props' ? [W(-8, -12), W(-1, -8), -0.32]
  : spot === 'mid' ? [{ x: ux * L * 0.45, z: uz * L * 0.45 }, { x: 0, z: 0 }, 0] : [W(6, 13), W(14, 60), 0.02];
await dbg('hp', 100);
await dbg('teleport', at.x, at.z);
await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [Math.atan2(-(to.x - at.x), -(to.z - at.z)), pitch]);
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__uploads.on = true; });
await page.waitForTimeout(secs * 1000);
const out = await page.evaluate(() => {
  const r = window.__uploads; r.on = false;
  return { frames: r.frames, rows: [...r.by].map(([k, e]) => [k, e.n / r.frames, e.bytes / r.frames]).sort((a, b) => b[2] - a[2]) };
});
await browser.close();
const tot = out.rows.reduce((a, r) => [a[0] + r[1], a[1] + r[2]], [0, 0]);
console.log(`\n== ${label} (${preset}, ${spot}, ${out.frames} frames) ${tot[0].toFixed(0)} writes / ${(tot[1] / 1024).toFixed(0)} KB per frame ==`);
console.log('| buffer | writes/frame | KB/frame |');
console.log('|---|---|---|');
for (const [k, n, b] of out.rows.slice(0, 30)) console.log(`| ${k} | ${n.toFixed(1)} | ${(b / 1024).toFixed(1)} |`);

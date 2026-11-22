// Frame profile of an 8-player match (headless, 1600×900, vsync off, high preset unless --preset=): CPU sampling
// profile of the main thread ranked by self time (function + file), GPU timestamp ms, frame stats, and the
// input→render latency probe (synthetic mouse-look events). Run under the heavy lock (perfAB.mjs does).
//   GAME_URL=… node tests/visual/profile.mjs [--preset=high] [--secs=5] [--label=x]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const preset = arg('preset', 'high');
const secs = Number(arg('secs', '5'));
const label = arg('label', 'profile');
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const vsync = arg('vsync', '0') === '1';
const dpr = Number(arg('dpr', '1'));
/** harbor | props | mid */
const spot = arg('spot', 'harbor');

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', ...(vsync ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dpr });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript((q) => { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: q, dynamicResolution: false }, onboarding: { howToSeen: true } })); }, preset);
const params = arg('params', '');
await page.goto(`${url}/?debug=1&bots=7&gputime=1${params ? `&${params}` : ''}`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(2500);
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me.island ?? 0];
const yaw0 = home.bunker.facingYaw;
const W = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
await dbg('hp', 100000);
const L = Math.hypot(home.center.x, home.center.z), ux = home.center.x / L, uz = home.center.z / L;
const [at, to, pitch] = spot === 'props' ? [W(-8, -12), W(-1, -8), -0.32]
  : spot === 'edge' ? [W(-15, 12), W(-25, 30), -0.12]
  : spot === 'across' ? [W(-3, -15), W(-3, -80), -0.02]
  : spot === 'mid' ? [{ x: ux * L * 0.45, z: uz * L * 0.45 }, { x: 0, z: 0 }, 0]
    : [W(6, 13), W(14, 60), 0.02];
await dbg('teleport', at.x, at.z);
await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [Math.atan2(-(to.x - at.x), -(to.z - at.z)), pitch]);
await page.waitForTimeout(1200);

// --- CPU profile + frame stats + GPU ms over the same window
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await dbg('resetFrames');
await cdp.send('Profiler.start');
await page.waitForTimeout(secs * 1000);
const { profile } = await cdp.send('Profiler.stop');
const frames = await dbg('frames');
const gpu = await dbg('gpuMs');
const info = await dbg('renderInfo');

// self time per node: samples × interval
const dt = (profile.endTime - profile.startTime) / 1000 / profile.samples.length; // ms per sample
const count = new Map();
for (const id of profile.samples) count.set(id, (count.get(id) ?? 0) + 1);
const byFn = new Map(), byFile = new Map();
for (const n of profile.nodes) {
  const c = count.get(n.id) ?? 0;
  if (!c) continue;
  const f = n.callFrame;
  const file = (f.url || '(native)').replace(/^.*\/(node_modules\/\.vite\/deps\/|src\/|@fs.*node_modules\/)/, '').replace(/\?.*$/, '');
  const fn = `${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`;
  byFn.set(fn, (byFn.get(fn) ?? 0) + c * dt);
  byFile.set(file, (byFile.get(file) ?? 0) + c * dt);
}
const total = profile.samples.length * dt;
// --stack=fnName: who calls it (self time of fnName, by its 5 nearest callers)
const stackOf = arg('stack', '');
const stacks = new Map();
if (stackOf) {
  const parent = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  for (const n of profile.nodes) {
    if (n.callFrame.functionName !== stackOf || !count.get(n.id)) continue;
    const chain = [];
    for (let id = parent.get(n.id); id && chain.length < 5; id = parent.get(id)) { const f = byId.get(id).callFrame; chain.push(`${f.functionName || '(anon)'}:${(f.url.split('/').pop() || '').replace(/\?.*$/, '')}:${f.lineNumber + 1}`); }
    const k = chain.join(' < ');
    stacks.set(k, (stacks.get(k) ?? 0) + count.get(n.id) * dt);
  }
}
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const perFrame = (ms) => (ms / (frames.n || 1)).toFixed(3);

// --- input → render latency (synthetic look events at ~250 Hz); builds without the probe report n=0
let lat = { n: 0, cpuAvg: 0, cpuP95: 0, gpuAvg: 0, gpuP95: 0 };
if (await page.evaluate(() => typeof window.__faefight.lookProbe === 'function')) {
  await dbg('lookProbe', true);
  await dbg('resetLatency');
  await page.evaluate(() => new Promise((res) => {
    const id = setInterval(() => window.dispatchEvent(new MouseEvent('mousemove', { movementX: 1, movementY: 0 })), 4);
    setTimeout(() => { clearInterval(id); res(); }, 3000);
  }));
  await page.waitForTimeout(300);
  lat = await dbg('latency');
  await dbg('lookProbe', false);
}
// draws per pass: tally the renderer's per-object draws by camera for 60 frames (main camera, each shadow camera, post quads)
const { passes, groups: passGroups } = await page.evaluate((byGroup) => new Promise((res) => {
  const r = window.__faefight.renderer, gpu = r.gpu, orig = gpu._renderObjectDirect;
  const tally = new Map(), names = new Map(), groups = new Map();
  let frames = 0;
  gpu._renderObjectDirect = function (object, material, scene, camera, ...rest) {
    const k = camera === r.camera ? (scene === r.scene ? 'camera' : 'camera:other-scene') : camera.isOrthographicCamera && scene === r.scene ? `shadow#${(names.has(camera) ? names : names.set(camera, names.size)).get(camera)}` : `post/other (${object.name || object.type})`;
    if (byGroup && (k === 'camera' || k.startsWith('shadow'))) {
      const nm = (object.name || object.parent?.name || object.type).replace(/\d+/g, '#').split(':').slice(0, 2).join(':');
      const gk = `${k}|${nm}`;
      groups.set(gk, (groups.get(gk) ?? 0) + 1);
    }
    const e = tally.get(k) ?? { draws: 0, tris: 0 };
    e.draws++;
    const g = object.geometry, n = g ? (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3 : 0;
    e.tris += n * (object.isInstancedMesh ? object.count : g?.isInstancedBufferGeometry ? g.instanceCount : 1);
    tally.set(k, e);
    return orig.call(this, object, material, scene, camera, ...rest);
  };
  const tick = () => { if (++frames < 60) requestAnimationFrame(tick); else { gpu._renderObjectDirect = orig; res({ passes: [...tally].map(([k, e]) => [k, Math.round(e.draws / 60), Math.round(e.tris / 60)]), groups: [...groups].map(([k, n]) => [k, +(n / 60).toFixed(1)]).sort((a, b) => b[1] - a[1]) }); } };
  requestAnimationFrame(tick);
}), arg('groups', '') === '1');
console.log('-- draws / tris per pass (per frame, 60-frame mean) --');
for (const [k, d, t] of passes) console.log(`${String(d).padStart(5)} ${String(Math.round(t / 1000)).padStart(6)}kt  ${k}`);
if (passGroups.length) { console.log('-- draws per frame by pass|group (--groups=1) --'); for (const [k, n] of passGroups) console.log(`${String(n).padStart(6)}  ${k}`); }
const graph = await page.evaluate(() => {
  const sc = window.__faefight.renderer.scene;
  let all = 0, meshes = 0, auto = 0, autoW = 0, visible = 0;
  sc.traverse((o) => { all++; if (o.isMesh || o.isSprite || o.isPoints || o.isLine) meshes++; if (o.matrixAutoUpdate) auto++; if (o.matrixWorldAutoUpdate) autoW++; });
  sc.traverseVisible(() => { visible++; });
  return { all, meshes, visible, matrixAutoUpdate: auto, matrixWorldAutoUpdate: autoW };
});
console.log(`-- scene graph: ${JSON.stringify(graph)} --`);
// draw census at this view: visible meshes inside the camera frustum, grouped by name prefix
const census = await page.evaluate(([full, sortTris]) => {
  const r = window.__faefight.renderer, cam = r.camera, scene = r.scene;
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
  const e = m.elements, planes = [[e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]], [e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]], [e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]], [e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]], [e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]], [e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]]];
  const out = {};
  const visit = (o) => {
    if (!o.visible || !(o.layers.mask & cam.layers.mask)) return;
    if (o.isMesh || o.isSprite || o.isLine || o.isPoints) {
      let inside = true;
      if (o.frustumCulled !== false && o.geometry) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        if (o.isInstancedMesh && !o.boundingSphere) o.computeBoundingSphere();
        const bs = o.isInstancedMesh ? o.boundingSphere : o.geometry.boundingSphere, c = bs.center.clone().applyMatrix4(o.matrixWorld), rad = bs.radius * o.matrixWorld.getMaxScaleOnAxis();
        for (const p of planes) { const n = Math.hypot(p[0], p[1], p[2]); if ((p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3]) / n < -rad) { inside = false; break; } }
      }
      if (inside && !(o.isInstancedMesh && o.count === 0)) {
        const nm = o.name || o.parent?.name || o.type;
        const k = full ? nm.replace(/\d+/g, '#').split(':').slice(0, 3).join(':') : nm.split(/[:#\d]/)[0] || o.type;
        const mats = Array.isArray(o.material) ? o.material.length : 1;
        const g = o.geometry, n = g ? (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3 : 0;
        const inst = o.isInstancedMesh ? o.count : (g?.isInstancedBufferGeometry ? g.instanceCount : 1);
        const e = (out[k] ??= [0, 0]); e[0] += mats; e[1] += n * inst;
      }
    }
    for (const ch of o.children) visit(ch);
  };
  visit(scene);
  return Object.entries(out).sort((a, b) => (sortTris ? b[1][1] - a[1][1] : b[1][0] - a[1][0])).slice(0, full ? 60 : 25);
}, [arg('census', '') !== '', arg('census', '') === 'tris']);
await browser.close();
console.log('-- camera draws / triangles by group (approx; --census=full|tris) --');
const totT = census.reduce((a, [, v]) => a + v[1], 0);
console.log(`(listed: ${census.reduce((a, [, v]) => a + v[0], 0)} draws, ${(totT / 1e6).toFixed(2)} M tris)`);
for (const [k, v] of census) console.log(`${String(v[0]).padStart(5)} ${String(Math.round(v[1] / 1000)).padStart(6)}kt  ${k}`);

console.log(`\n== ${label} (${preset}, ${spot}, dpr ${dpr}, ${secs}s, ${frames.n} frames) ==`);
console.log(`fps ${(1000 / frames.avg).toFixed(1)} · avg ${frames.avg.toFixed(2)} ms · p99 ${frames.p99.toFixed(2)} ms · hitches>25ms ${frames.hitches} · main-thread work ${frames.cpuAvg.toFixed(2)} ms/frame · gpu ${(gpu.avg ?? 0).toFixed(2)} ms · draws ${info.drawCalls} · tris ${(info.triangles / 1e6).toFixed(2)}M`);
console.log(`input→submit ${lat.cpuAvg.toFixed(2)} ms (p95 ${lat.cpuP95.toFixed(2)}) · input→GPU done ${lat.gpuAvg.toFixed(2)} ms (p95 ${lat.gpuP95.toFixed(2)}) · n=${lat.n}`);
console.log(`profiled ${total.toFixed(0)} ms main thread`);
console.log('-- top functions (self ms per frame) --');
for (const [k, v] of top(byFn, 30)) console.log(`${perFrame(v).padStart(7)}  ${k}`);
if (stackOf) { console.log(`-- callers of ${stackOf} (ms per frame) --`); for (const [k, v] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${(v / (frames.n || 1)).toFixed(3).padStart(7)}  ${k}`); }
console.log('-- top files (self ms per frame) --');
for (const [k, v] of top(byFile, 20)) console.log(`${perFrame(v).padStart(7)}  ${k}`);
if (errors.length) console.log('errors', JSON.stringify(errors.slice(0, 5)));

// Render-submit census (perf stage B): where three's CPU submit time goes per frame. 8-player vs-bot match,
// 1600×900 @1x, vsync off, governor/dyn-res off. Hooks the WebGPURenderer in-page and reports per frame:
// renderer.render() passes by kind (camera / shadow cascade / post) with exclusive wall ms and objects drawn,
// queue writeBuffer / writeTexture calls + KB, scene.updateMatrixWorld ms, scene object counts (auto-matrix ones),
// BatchedMesh / InstancedMesh / SkinnedMesh counts. Spots = perfMatch's. Run under heavy.sh against GAME_URL.
//   node tests/visual/submitCensus.mjs [--preset=high] [--frames=120] [--params=x=1]
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const preset = arg('preset', 'high');
const frames = Number(arg('frames', '120'));
const params = arg('params', '');
const url = process.env.GAME_URL ?? 'http://localhost:5299';
const SPOTS = [
  { name: 'harbor', at: [6, 13], look: [14, 60], pitch: 0.02 },
  { name: 'props', at: [-8, -12], look: [-1, -8], pitch: -0.32 },
];

const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.addInitScript((q) => {
  localStorage.setItem('faefight.settings.v1', JSON.stringify({ v: 2, onboarding: { howToSeen: true }, video: { quality: q, dynamicResolution: false, power: 'quality' } }));
}, preset);
await page.goto(`${url}/?debug=1&bots=7&perf${params ? `&${params}` : ''}`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const R = window.__faefight.renderer, gpu = R.gpu, scene = R.scene;
  const C = (window.__census = { frames: 0, pass: {}, wb: 0, wbKB: 0, wt: 0, wtKB: 0, umw: 0, objs: 0, draws: 0, by: {} });
  const stack = [];
  const kind = (cam, rt) => {
    if (cam.isOrthographicCamera && rt?.depthTexture) return `shadow:${rt.width}`;
    if (cam.isOrthographicCamera) return rt ? `ortho:${rt.width}` : 'ortho';
    return rt ? `cam:${rt.width}x${rt.height}${rt.textures?.length > 1 ? `/mrt${rt.textures.length}` : ''}` : 'cam:canvas';
  };
  const origRender = gpu.render.bind(gpu);
  gpu.render = function (s, cam) {
    const k = kind(cam, gpu.getRenderTarget()) + (s === scene ? '' : '+quad');
    const t0 = performance.now();
    stack.push({ k, t0, child: 0, objs: 0 });
    try { return origRender(s, cam); } finally {
      const e = stack.pop(), dt = performance.now() - t0;
      const p = (C.pass[e.k] ??= { n: 0, ms: 0, objs: 0 });
      p.n++; p.ms += dt - e.child; p.objs += e.objs;
      if (stack.length) stack[stack.length - 1].child += dt;
    }
  };
  const origRO = gpu._renderObjectDirect.bind(gpu);
  const nameOf = (o) => (o.isBatchedMesh ? 'B:' : o.isInstancedMesh ? 'I:' : o.isSkinnedMesh ? 'S:' : '') + ((o.name || o.parent?.name || o.type).split(/[:@#]/)[0]);
  gpu._renderObjectDirect = function (o, ...a) {
    const top = stack[stack.length - 1];
    if (top) top.objs++;
    C.draws++;
    const t = performance.now(), wb0 = C.wb;
    try { return origRO(o, ...a); } finally {
      const k = `${top?.k.split(':')[0] ?? '?'} ${nameOf(o)}`;
      const e = (C.by[k] ??= { n: 0, ms: 0, wb: 0 });
      e.n++; e.ms += performance.now() - t; e.wb += C.wb - wb0;
    }
  };
  const q = gpu.backend.device?.queue;
  if (q) {
    const wb = q.writeBuffer.bind(q), wt = q.writeTexture.bind(q);
    q.writeBuffer = (b, o, d, ...r) => { C.wb++; C.wbKB += ((r[1] ?? d.byteLength) * (d.BYTES_PER_ELEMENT ?? 1)) / 1024; return wb(b, o, d, ...r); };
    q.writeTexture = (dst, d, l, s) => { C.wt++; C.wtKB += (d.byteLength ?? 0) / 1024; return wt(dst, d, l, s); };
  }
  const umw = scene.updateMatrixWorld.bind(scene);
  scene.updateMatrixWorld = function (f) { const t = performance.now(); try { return umw(f); } finally { C.umw += performance.now() - t; } };
  C.sub = {};
  const wrap = (obj, fn, key) => {
    const f = obj[fn]; if (typeof f !== 'function') return;
    let depth = 0;
    obj[fn] = function (...a) {
      if (depth++) { try { return f.apply(this, a); } finally { depth--; } }
      const t = performance.now();
      try { return f.apply(this, a); } finally { depth--; const e = (C.sub[key] ??= { n: 0, ms: 0 }); e.n++; e.ms += performance.now() - t; }
    };
  };
  if (new URLSearchParams(location.search).has('sub')) {
    wrap(gpu, 'renderObject', 'renderObject(all)');
    wrap(gpu._objects, 'get', 'objects.get');
    wrap(gpu._nodes, 'needsRefresh', 'nodes.needsRefresh');
    wrap(gpu._nodes, 'updateBefore', 'nodes.updateBefore');
    wrap(gpu._geometries, 'updateForRender', 'geometries.updateForRender');
    wrap(gpu._nodes, 'updateForRender', 'nodes.updateForRender');
    wrap(gpu._bindings, 'updateForRender', 'bindings.updateForRender');
    wrap(gpu._bindings, 'updateSharedForRender', 'bindings.updateShared');
    wrap(gpu._pipelines, 'updateForRender', 'pipelines.updateForRender');
    wrap(gpu.backend, 'draw', 'backend.draw');
    wrap(gpu._nodes, 'updateAfter', 'nodes.updateAfter');
    wrap(gpu._drawingPipeline, 'project', 'project(cull)');
    wrap(gpu, '_renderObjects', '_renderObjects');
    wrap(gpu._nodes, 'updateScene', 'nodes.updateScene');
    wrap(gpu, '_renderScene', '_renderScene(all)');
    wrap(scene, 'onBeforeRender', 'scene.onBeforeRender');
  }
  C.bind = {}; C.uni = {};
  if (new URLSearchParams(location.search).has('bind')) {
    const ub = gpu.backend.updateBinding.bind(gpu.backend);
    gpu.backend.updateBinding = (b) => {
      const k = `${b.name}`;
      const e = (C.bind[k] ??= { n: 0, ranges: 0, uniforms: b.uniforms?.length ?? 0, bytes: 0 });
      e.n++; e.ranges += b.updateRanges?.length ?? 0; e.bytes += b.buffer?.byteLength ?? 0;
      return ub(b);
    };
    // which uniforms change: hook updateByType on UniformsGroup prototype via the first group seen
    let hooked = false;
    const ufr = gpu._bindings.updateForRender.bind(gpu._bindings);
    gpu._bindings.updateForRender = (ro) => {
      if (!hooked) {
        for (const g of ro.getBindings()) for (const b of g.bindings) if (b.isUniformsGroup && !hooked) {
          const proto = Object.getPrototypeOf(Object.getPrototypeOf(b)).updateByType ? Object.getPrototypeOf(Object.getPrototypeOf(b)) : Object.getPrototypeOf(b);
          const orig = proto.updateByType;
          proto.updateByType = function (u) { const r = orig.call(this, u); if (r) { const nm = `${this.name}/${u.name ?? u.nodeUniform?.name ?? '?'}:${u.nodeUniform?.node?.name || u.nodeUniform?.node?.constructor?.name || ''}`; C.uni[nm] = (C.uni[nm] ?? 0) + 1; } return r; };
          hooked = true;
        }
      }
      return ufr(ro);
    };
  }
  const tick = () => { C.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let o = 0, auto = 0, autoW = 0, bm = 0, bmInst = 0, im = 0, sk = 0, meshes = 0;
  scene.traverse((x) => {
    o++; if (x.matrixAutoUpdate) auto++; if (x.matrixWorldAutoUpdate) autoW++;
    if (x.isBatchedMesh) { bm++; bmInst += x.instanceCount ?? x._instanceInfo?.length ?? 0; }
    else if (x.isInstancedMesh) im++;
    else if (x.isSkinnedMesh) sk++;
    else if (x.isMesh) meshes++;
  });
  C.scene = { objects: o, matrixAutoUpdate: auto, matrixWorldAutoUpdate: autoW, batched: bm, batchedInstances: bmInst, instanced: im, skinned: sk, meshes };
});

const out = [];
const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
const humanId = await dbg('humanId');
const map = await dbg('map');
const me0 = (await dbg('snapshot')).players.find((p) => p.id === humanId);
const home = map[me0.island ?? 0];
const yaw0 = home.bunker.facingYaw;
const toWorld = (x, z) => ({ x: home.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: home.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
const yawToward = (from, to) => { const a = toWorld(...from), b = toWorld(...to); return Math.atan2(-(b.x - a.x), -(b.z - a.z)); };
for (const s of SPOTS) {
  await dbg('hp', 100000);
  const w = toWorld(...s.at);
  await dbg('teleport', w.x, w.z);
  await page.evaluate(([y, p]) => { window.__faefight.input.yaw = y; window.__faefight.input.pitch = p; }, [yawToward(s.at, s.look), s.pitch]);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async (n) => {
    const C = window.__census;
    const reset = () => { C.frames = 0; C.pass = {}; C.wb = 0; C.wbKB = 0; C.wt = 0; C.wtKB = 0; C.umw = 0; C.draws = 0; C.by = {}; C.sub = {}; C.bind = {}; C.uni = {}; };
    reset();
    const t0 = performance.now();
    while (C.frames < n) await new Promise((r) => setTimeout(r, 50));
    const f = C.frames, wall = performance.now() - t0;
    const pass = {};
    for (const [k, p] of Object.entries(C.pass)) pass[k] = { perFrame: +(p.n / f).toFixed(2), ms: +(p.ms / f).toFixed(3), objs: +(p.objs / f).toFixed(1) };
    const by = Object.entries(C.by).map(([k, e]) => [k, +(e.n / f).toFixed(1), +(e.ms / f).toFixed(3), +(e.wb / e.n).toFixed(1)]).sort((a, b) => b[2] - a[2]).slice(0, 40);
    const sub = Object.entries(C.sub).map(([k, e]) => [k, +(e.n / f).toFixed(1), +(e.ms / f).toFixed(3)]);
    const bind = Object.entries(C.bind).map(([k, e]) => [k, +(e.n / f).toFixed(1), e.uniforms, +(e.ranges / e.n).toFixed(1), Math.round(e.bytes / e.n)]).sort((a, b) => b[1] - a[1]);
    const uni = Object.entries(C.uni).map(([k, n]) => [k, +(n / f).toFixed(1)]).sort((a, b) => b[1] - a[1]).slice(0, 50);
    return { bind, uni, sub, by, fps: +((f * 1000) / wall).toFixed(1), draws: +(C.draws / f).toFixed(1), wb: +(C.wb / f).toFixed(1), wbKB: +(C.wbKB / f).toFixed(1), wt: +(C.wt / f).toFixed(1), wtKB: +(C.wtKB / f).toFixed(1), umwMs: +(C.umw / f).toFixed(3), probe: window.__faefight.perfProbe?.(), pass, scene: C.scene };
  }, frames);
  out.push({ spot: s.name, ...r });
}
await browser.close();
for (const r of out) {
  console.log(`== ${preset} ${r.spot}: fps ${r.fps} draws/frame ${r.draws} writeBuffer ${r.wb} (${r.wbKB} KB) writeTexture ${r.wt} (${r.wtKB} KB) updateMatrixWorld ${r.umwMs} ms submit ${r.probe?.submit} total ${r.probe?.total}`);
  console.log('   scene', JSON.stringify(r.scene));
  for (const [k, p] of Object.entries(r.pass).sort((a, b) => b[1].ms - a[1].ms)) console.log(`   ${k.padEnd(28)} ×${p.perFrame} ${p.ms} ms objs ${p.objs}`);
  for (const b of r.bind ?? []) console.log(`   bind ${b[0].padEnd(24)} ×${b[1]}/frame uniforms ${b[2]} ranges/write ${b[3]} bytes ${b[4]}`);
  for (const b of r.uni ?? []) console.log(`   uni ${b[0].padEnd(50)} ×${b[1]}/frame`);
  for (const b of r.sub) console.log(`   sub ${b[0].padEnd(30)} ×${b[1]} ${b[2]} ms`);
  console.log('   by object (pass name: draws/frame, ms/frame inside _renderObjectDirect, writeBuffers/draw)');
  for (const b of r.by) console.log(`     ${b[0].padEnd(40)} ${b[1]}  ${b[2]} ms  wb ${b[3]}`);
}
if (errors.length) console.log('errors', errors.slice(0, 5));

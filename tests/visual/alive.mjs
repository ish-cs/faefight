// "Alive world" pass: wildlife + waves. Load time, frame times per preset (8 players: ?debug=1&bots=7, 1600×900,
// fixed resolution) and fixed camera shots (rats on the quay, crabs on the beach, flies over trash, shoreline waves,
// open sea). Needs a dev server: `pnpm vite --port 5341 --strictPort`, then
//   node tests/visual/alive.mjs <outPrefix> [load|perf|shots|all] [qualities=high]
// shots → <outPrefix>-<spot>.png at ultra; perf → JSON per preset; load → "[loading] match ready" ms over 3 cold runs.
import { chromium } from '@playwright/test';

const prefix = process.argv[2] ?? 'alive';
const mode = process.argv[3] ?? 'all';
const qualities = (process.argv[4] ?? 'low,high,ultra').split(',');
const url = process.env.GAME_URL ?? 'http://localhost:5341';
const ARGS = ['--enable-unsafe-webgpu', '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
const browser = await chromium.launch({ channel: 'chromium', args: ARGS });

async function openGame(quality = 'high') {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240_000);
  const errors = [];
  let readyMs = null;
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t.slice(0, 300));
    const k = /\[loading\] match ready in (\d+) ms/.exec(t);
    if (k) readyMs = +k[1];
  });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 500)));
  await page.addInitScript((q) => {
    try { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { dynamicResolution: false, quality: q }, onboarding: { howToSeen: true } })); } catch { /* fresh profile */ }
  }, quality);
  await page.goto(`${url}/?debug=1&bots=7&gputime=1`);
  const clicked = performance.now();
  await page.getByTestId('play-easy').click();
  await page.waitForFunction(() => window.__faefight?.snapshot?.(), null, { timeout: 90_000 });
  await page.waitForFunction(() => !window.__faefightLoading?.visible(), null, { timeout: 120_000 });
  const wall = performance.now() - clicked;
  return { ctx, page, errors, ready: () => readyMs, wall };
}

const out = {};

if (mode === 'load' || mode === 'all') {
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const g = await openGame('high');
    await g.page.waitForTimeout(500);
    runs.push({ ready: g.ready(), wall: Math.round(g.wall) });
    await g.ctx.close();
  }
  const warm = runs.slice(1); // first run pays Vite's on-demand transform; drop it
  out.load = { runs, avgReadyMs: Math.round(warm.reduce((a, r) => a + r.ready, 0) / warm.length) };
  console.log('load', JSON.stringify(out.load));
}

if (mode === 'perf' || mode === 'shots' || mode === 'all') {
  const g = await openGame('high');
  const { page } = g;
  await page.waitForTimeout(3000);
  const dbg = (f, ...a) => page.evaluate(([f, a]) => window.__faefight[f](...a), [f, a]);
  const humanId = await dbg('humanId');
  const def = await dbg('mapDef');
  const me = (await dbg('snapshot')).players.find((p) => p.id === humanId);
  const home = def.islands[me.island ?? 0];
  const yaw = home.bunker.facingYaw;
  const W = (x, z) => ({ x: home.center.x + x * Math.cos(yaw) + z * Math.sin(yaw), z: home.center.z - x * Math.sin(yaw) + z * Math.cos(yaw) });
  const gy = home.groundY;
  // backdrop quay frame (islands.ts backdropFrame)
  const ring = Math.hypot(home.center.x, home.center.z), z0 = home.radius + 14, n = def.islands.length;
  const hw = Math.max(25, Math.min(60, (ring + z0) * Math.sin(Math.PI / n) - 8));
  const view = async (from, fy, to, ty, wait = 2200) => {
    await page.evaluate(([a, b]) => {
      const T = window.__faefight.renderer.camera.position.constructor;
      window.__faefight.renderer.debugView = { pos: new T(a.x, a.y, a.z), look: new T(b.x, b.y, b.z) };
    }, [{ ...from, y: fy, z: from.z }, { ...to, y: ty, z: to.z }].map((p) => ({ x: p.x, y: p.y, z: p.z })));
    await page.waitForTimeout(wait);
  };
  const v3 = (p, y) => ({ x: p.x, y, z: p.z });
  const gapDir = (() => { // halfway between this island and the next one around the ring, outward
    const a0 = Math.atan2(home.center.z, home.center.x), nx = def.islands[(home.index + 1) % n];
    const a1 = Math.atan2(nx.center.z, nx.center.x);
    let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    return a0 + d / 2;
  })();
  const SPOTS = {
    // rats along the left flank quay wall, near the rope coil / tyre clutter
    quay: [v3(W(-15.5, 5), gy + 1.1), v3(W(-20.6, -1), gy + 0.1)],
    // crabs on the harbor beach in front of the backdrop quay wall
    beach: [v3(W(0.72 * hw, z0 - 10.5), 2.2), v3(W(0.76 * hw, z0 - 4.5), 0.2)],
    // flies over the litter pile in front of the bunker side
    trash: [v3(W(-3.4, -7.3), gy + 0.75), v3(W(-5, -9), gy + 0.25)],
    // shoreline: from the quay edge down at the water against the wall
    shore: [v3(W(0, -home.radius + 1.5), gy + 1.7), v3(W(0, -home.radius - 9), 0)],
    // open sea through the gap between two backdrop quays, out past the ring
    sea: [{ x: Math.cos(gapDir) * (ring + 60), y: 7, z: Math.sin(gapDir) * (ring + 60) }, { x: Math.cos(gapDir) * (ring + 400), y: 0, z: Math.sin(gapDir) * (ring + 400) }],
  };

  if (mode === 'shots' || mode === 'all') {
    await page.evaluate(() => window.__faefight.renderer.world.sky.setQuality('ultra'));
    await dbg('hp', 100000);
    // Wildlife close-ups: go to the habitat anchor nearest the home island, let the animals spawn/emerge, then frame
    // the nearest one. Poses are saved so the "before" build can shoot the very same views (POSES=<file>).
    const CRIT = [
      ['quay', 'quay', ['rat', 'pigeon', 'cat', 'dog']],
      ['beach', 'beach', ['crab', 'turtle', 'hermit']],
      ['trash', 'trash', []],
      ['wall', 'wall', ['lizard', 'gecko']],
      ['birds', 'piling', ['pelican', 'cormorant']],
      ['palm', 'palm', ['parrot']],
      ['shallows', 'shallows', ['heron', 'jelly']],
      ['rocks', 'rocks', ['starfish', 'hermit', 'crab']],
    ];
    const posesIn = process.env.POSES ? JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(process.env.POSES, 'utf8'))) : null;
    const poses = {};
    for (const [name, hab, focus] of CRIT) {
      let pose = posesIn?.[name];
      if (!posesIn) {
        const anchor = await page.evaluate(([hab, cx, cz]) => {
          const list = window.__faefight.renderer.world.critters?.hab?.[hab] ?? [];
          return list.slice().sort((a, b) => (a.x - cx) ** 2 + (a.z - cz) ** 2 - (b.x - cx) ** 2 - (b.z - cz) ** 2)[0] ?? null;
        }, [hab, home.center.x, home.center.z]);
        if (!anchor) { console.log('no anchor for', name); continue; }
        // stand back toward the island centre, a bit above
        const dx = home.center.x - anchor.x, dz = home.center.z - anchor.z, l = Math.hypot(dx, dz) || 1;
        const ay = anchor.water ? anchor.y + 0.2 : anchor.y + (anchor.wall ? 0.6 : 0.1);
        const ax = anchor.wall ? anchor.x + anchor.wall.ux * anchor.wall.w * 0.5 : anchor.x, az = anchor.wall ? anchor.z + anchor.wall.uz * anchor.wall.w * 0.5 : anchor.z;
        const back = anchor.wall ? { x: ax + anchor.wall.nx * 3, z: az + anchor.wall.nz * 3 } : { x: ax + (dx / l) * 4.5, z: az + (dz / l) * 4.5 };
        pose = [{ x: back.x, y: ay + 1.6, z: back.z }, { x: ax, y: ay, z: az }];
        await view(pose[0], pose[0].y, pose[1], pose[1].y, 3500);
        // frame the nearest focus animal from ~2 m
        const hit = await page.evaluate(([focus, x, z]) => {
          const c = window.__faefight.renderer.world.critters;
          let best = null, bd = 400;
          for (const f of focus) for (const p of c.where(f)) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = p; } }
          return best;
        }, [focus, ax, az]);
        if (hit) {
          const ex = pose[0].x - hit.x, ez = pose[0].z - hit.z, el = Math.hypot(ex, ez) || 1;
          const r = focus.some((f) => ['pelican', 'cormorant', 'dog', 'heron', 'turtle'].includes(f)) ? 3.2 : 1.9;
          pose = [{ x: hit.x + (ex / el) * r, y: hit.y + r * 0.45, z: hit.z + (ez / el) * r }, { x: hit.x, y: hit.y + 0.05, z: hit.z }];
        }
      }
      if (!pose) continue;
      poses[name] = pose;
      await view(pose[0], pose[0].y, pose[1], pose[1].y, posesIn ? 2500 : 450);
      await page.screenshot({ path: `${prefix}-${name}.png` });
    }
    for (const name of ['shore', 'sea']) {
      const [a, b] = posesIn?.[name] ?? SPOTS[name];
      poses[name] = [a, b];
      await view(a, a.y, b, b.y);
      await page.screenshot({ path: `${prefix}-${name}.png` });
    }
    if (!posesIn) (await import('node:fs')).writeFileSync(`${prefix}-poses.json`, JSON.stringify(poses));
    out.critters = await page.evaluate(() => window.__faefight.renderer.world.critters?.stats?.() ?? null);
    await page.evaluate(() => { window.__faefight.renderer.debugView = null; });
  }

  if (mode === 'perf' || mode === 'all') {
    out.perf = {};
    // same three views as realism.mjs perf (harbor, across, grass) + the shoreline (water fill-rate)
    const views = [
      [v3(W(6, 13), gy + 1.7), v3(W(14, 60), gy + 1.0)],
      [v3(W(-3, -15), gy + 1.7), v3(W(-3, -80), gy + 0.5)],
      [v3(W(9.5, 5.5), gy + 1.7), v3(W(13, 10), gy - 1)],
      SPOTS.shore,
    ];
    for (const q of qualities) {
      await page.evaluate((q) => window.__faefight.renderer.world.sky.setQuality(q), q);
      await page.waitForTimeout(1500);
      const acc = [];
      for (const [a, b] of views) {
        await view(a, a.y, b, b.y, 700);
        await dbg('resetFrames');
        await page.waitForTimeout(2500);
        acc.push({ ...(await dbg('frames')), gpu: (await dbg('gpuMs')).avg ?? 0 });
      }
      const mean = (k) => acc.reduce((s, f) => s + f[k], 0) / acc.length;
      out.perf[q] = { gpuMs: +mean('gpu').toFixed(2), avgMs: +mean('avg').toFixed(2), fps: +(1000 / mean('avg')).toFixed(0), p95: +Math.max(...acc.map((f) => f.p95)).toFixed(2), perSpot: acc.map((f) => +f.avg.toFixed(2)), gpuPerSpot: acc.map((f) => +f.gpu.toFixed(2)) };
      console.log('perf', q, JSON.stringify(out.perf[q]));
    }
    out.renderInfo = await dbg('renderInfo');
  }
  out.errors = g.errors.slice(0, 10);
  await g.ctx.close();
}
console.log(JSON.stringify(out));
await browser.close();

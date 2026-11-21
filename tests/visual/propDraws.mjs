// Draw calls / fps contributed by each prop layer at the harbor spot: toggles one layer's visibility at a time.
// Draw counts are deterministic (unlike fps under load). Run under the heavy lock (perfAB --script=propDraws.mjs).
import { chromium } from '@playwright/test';

const url = process.env.GAME_URL ?? 'http://localhost:5299';
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240_000);
await page.addInitScript(() => { localStorage.setItem('faefight.settings.v1', JSON.stringify({ video: { quality: 'high', dynamicResolution: false } })); });
await page.goto(`${url}/?debug=1&bots=7&gputime=1`);
await page.getByTestId('play-easy').click();
await page.waitForFunction(() => window.__faefight?.snapshot?.() && !window.__faefightLoading?.visible(), null, { timeout: 180_000 });
await page.waitForTimeout(3000);
for (const [name, at, look] of [['harbor', [6, 13], [14, 60]], ['across', [-3, -15], [-3, -80]]]) {
  await page.evaluate(([at, look]) => {
    const f = window.__faefight, me = f.snapshot().players.find((p) => p.id === f.humanId()), isl = f.map()[me.island ?? 0];
    const y = isl.bunker.facingYaw, W = (x, z) => ({ x: isl.center.x + x * Math.cos(y) + z * Math.sin(y), z: isl.center.z - x * Math.sin(y) + z * Math.cos(y) });
    const a = W(...at), b = W(...look);
    f.hp(100000); f.teleport(a.x, a.z);
    f.input.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z)); f.input.pitch = 0.02;
  }, [at, look]);
  await page.waitForTimeout(1500);
  for (const layer of ['all', 'debris', 'gameProps', 'props', 'dressing']) {
    await page.evaluate((layer) => {
      const w = window.__faefight.renderer.world;
      const roots = { debris: w.debris.root, gameProps: w.gameProps?.root, props: w.props.root };
      for (const r of Object.values(roots)) if (r) r.visible = true;
      w.islands?.traverse((o) => { if (o.name.startsWith('dressing:')) o.visible = true; });
      if (layer === 'dressing') w.islands?.traverse((o) => { if (o.name.startsWith('dressing:')) o.visible = false; });
      else if (roots[layer]) roots[layer].visible = false;
    }, layer);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.__faefight.resetFrames());
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => ({ f: window.__faefight.frames(), i: window.__faefight.renderInfo() }));
    console.log(JSON.stringify({ spot: name, hidden: layer, fps: Math.round(1000 / s.f.avg), draws: s.i.drawCalls, tris: s.i.triangles }));
  }
}
await browser.close();

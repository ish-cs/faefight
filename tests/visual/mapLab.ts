/**
 * Dev-only map lab (served by the dev server at /tests/visual/map-lab.html?n=8&tpl=yard, not part of the build).
 * Builds the real Renderer with buildMapDef(n, tpl) and no players, for draw-call / triangle / frame-time
 * numbers at any player count. Used by tests/visual/mapShots.mjs (lab mode).
 */
import { buildMapDef, type MapTemplate } from '../../src/sim/map';
import type { Snapshot } from '../../src/sim/types';
import { Renderer } from '../../src/client/render';

const q = new URLSearchParams(location.search);
const n = Number(q.get('n') ?? 8);
const tpl = (q.get('tpl') ?? 'harbor') as MapTemplate;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const r = await Renderer.create(canvas);
const def = buildMapDef(n, tpl);
r.setMap(def, 0);
const snap: Snapshot = {
  time: 0, tick: 0, players: [], pieces: [], loot: [], generators: [], sealed: def.islands.map(() => false), waterY: 0,
  suddenDeath: false, winner: null, events: [],
};
r.pushSnapshot(snap);

/** Camera on the center island's rim, looking out at island `i` (the typical mid-match view). */
function view(i = 0, h = 4) {
  const isl = def.islands[i];
  const l = Math.hypot(isl.center.x, isl.center.z);
  const dx = isl.center.x / l, dz = isl.center.z / l;
  r.camera.position.set(-dx * 4, def.center.groundY + h, -dz * 4);
  r.camera.lookAt(isl.center.x, def.center.groundY + 1, isl.center.z);
}
view();

let frameMs: number[] = [];
let last = performance.now();
const loop = () => {
  const now = performance.now();
  frameMs.push(now - last);
  last = now;
  r.render(0);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

async function measure(ms: number) {
  frameMs = [];
  await new Promise((res) => setTimeout(res, ms));
  const a = frameMs.slice(5).sort((x, y) => x - y);
  const avg = a.reduce((s, x) => s + x, 0) / a.length;
  return { frames: a.length, fps: Math.round(1000 / avg), p95ms: +a[Math.floor(a.length * 0.95)].toFixed(1), info: r.info() };
}

(window as unknown as { mapLab: unknown }).mapLab = { view, measure, def, ready: true };

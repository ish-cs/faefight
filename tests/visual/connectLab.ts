/**
 * Dev-only lab for connected builds (served by `pnpm vite` at /tests/visual/connect.html, not part of the build).
 * Drives the real Renderer with synthetic snapshots: a long mixed wall run, a stacked steel tower, a ramp staircase,
 * and a 120-piece field for fps. Used by tests/visual/connectShots.mjs → docs/screens/connect-*.png.
 * Only uses the public Renderer API so it also runs against the pre-change tree for "before" shots.
 */
import { PIECES } from '../../src/sim/constants';
import { buildMapDef } from '../../src/sim/map';
import type { MatchEvent, PieceKind, PieceState, Snapshot } from '../../src/sim/types';
import { Renderer } from '../../src/client/render';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const label = document.getElementById('label')!;
const r = await Renderer.create(canvas);
r.world.sky.setQuality('high');
const def = buildMapDef(2);
await r.setMap(def, 0);
const C = def.islands[0].center, GY = def.islands[0].groundY;

let pieces: PieceState[] = [];
let tick = 0;
let pending: MatchEvent[] = [];
const push = () => {
  const s: Snapshot = {
    time: tick / 30, tick: tick++, players: [], pieces, loot: [], projectiles: [], generators: [], genLevels: [1, 1], sealed: [false, false], waterY: 0,
    suddenDeath: false, winner: null, potionShops: [], events: pending,
  };
  pending = [];
  r.pushSnapshot(s);
};
let nextId = 1;
const P = (kind: PieceKind, x: number, y: number, z: number, rotY = 0, hpFrac = 1): PieceState =>
  ({ id: nextId++, kind, owner: 0, pos: { x, y, z }, rotY, hp: PIECES[kind].hp * hpFrac });
const cam = (x: number, y: number, z: number, tx: number, ty: number, tz: number) => { r.camera.position.set(x, y, z); r.camera.lookAt(tx, ty, tz); };

/** Run along +X from x0: steel ×3 (middle one damaged), wood ×2, metal ×2, sandbags ×3, then a steel corner return. */
function wallRun() {
  const kinds: PieceKind[] = ['steel', 'steel', 'steel', 'wood', 'wood', 'metal', 'metal', 'sandbags', 'sandbags', 'sandbags'];
  const x0 = C.x - 9, z = C.z;
  pieces = kinds.map((k, i) => P(k, x0 + i * 2, GY, z, 0, i === 1 ? 0.35 : i === 4 ? 0.5 : 1));
  const t = PIECES.steel.d;
  pieces.push(P('steel', x0 - 1 - t / 2, GY, z - 1 + t / 2, Math.PI / 2)); // corner at the left end
  label.textContent = 'mixed wall run';
  cam(x0 + 12, GY + 3.4, z - 10, x0 + 7.5, GY + 0.9, z);
  push();
}

/** 3 wide × 3 high steel, the centre plate damaged. */
function tower() {
  const h = PIECES.steel.h, x0 = C.x - 2, z = C.z;
  pieces = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) pieces.push(P('steel', x0 + col * 2, GY + row * (h + 0.05), z, 0, row === 1 && col === 1 ? 0.3 : 1));
  label.textContent = 'stacked steel tower';
  cam(x0 + 2 - 3.2, GY + 4.2, z - 8.5, x0 + 2, GY + 3.6, z);
  push();
}

/** Three ramps chained forward + up (like the practice range), to look at from below and the side. */
function rampChain() {
  const { h: rh, d: rd } = PIECES.ramp;
  const x0 = C.x - 1, z0 = C.z - 6;
  pieces = [0, 1, 2].map((k) => P('ramp', x0, GY + k * rh, z0 + k * rd));
  label.textContent = 'ramp chain';
  cam(x0 + 7, GY + 2.5, z0 + 3, x0, GY + 1.5, z0 + 3);
  push();
  return { x0, z0, GY };
}

/** Two ramps side by side up onto a 2×2 scaffold deck, then two more ramps up onto a second deck. */
function staircase() {
  const { h: rh, d: rd } = PIECES.ramp, sh = PIECES.scaffold.h, sd = PIECES.scaffold.d;
  const x0 = C.x - 1, z0 = C.z - 6;
  pieces = [];
  const deck1 = GY + rh - sh, deck2 = deck1 + sh + rh - sh;
  for (const dx of [0, 2]) {
    pieces.push(P('ramp', x0 + dx, GY, z0));
    pieces.push(P('scaffold', x0 + dx, deck1, z0 + rd / 2 + sd / 2));
    pieces.push(P('scaffold', x0 + dx, deck1, z0 + rd / 2 + sd * 1.5));
    pieces.push(P('ramp', x0 + dx, deck1 + sh, z0 + rd / 2 + sd * 2 + rd / 2, 0, dx === 0 ? 0.4 : 1));
    pieces.push(P('scaffold', x0 + dx, deck2, z0 + rd + sd * 2 + sd / 2));
  }
  label.textContent = 'ramp staircase';
  cam(x0 + 9, GY + 6.5, z0 - 4, x0 + 1, GY + 1.6, z0 + 5);
  push();
}

/** 120 pieces in connected runs and stacks (fps scene). */
function field() {
  const kinds: PieceKind[] = ['steel', 'wood', 'metal', 'sandbags'];
  pieces = [];
  for (let run = 0; run < 6; run++) {
    const a = (run / 6) * Math.PI * 2, rad = 9;
    const rot = Math.round((-a + Math.PI / 2) / (Math.PI / 12)) * (Math.PI / 12);
    for (let i = 0; i < 10; i++) {
      const k = kinds[(run + Math.floor(i / 3)) % kinds.length];
      const along = (i - 4.5) * 2;
      const x = C.x + Math.cos(a) * rad + Math.cos(rot) * along, z = C.z + Math.sin(a) * rad - Math.sin(rot) * along;
      pieces.push(P(k, x, GY, z, rot, 0.3 + 0.7 * ((i * 37) % 10) / 10));
      pieces.push(P(k, x, GY + PIECES[k].h + 0.05, z, rot, 1));
    }
  }
  label.textContent = `${pieces.length} pieces`;
  cam(C.x - 24, GY + 9, C.z - 18, C.x, GY, C.z);
  push();
}

function destroy(i: number) {
  const p = pieces[i];
  pieces = pieces.filter((q) => q !== p);
  pending.push({ t: 0, type: 'destroyed', data: { piece: p.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y + PIECES[p.kind].h / 2, z: p.pos.z }, rotY: p.rotY } });
  push();
}

let frameMs: number[] = [];
let lastT = performance.now();
const loop = () => {
  const now = performance.now();
  frameMs.push(now - lastT); lastT = now;
  r.render(0);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

async function measure(ms: number) {
  frameMs = [];
  await new Promise((res) => setTimeout(res, ms));
  const a = frameMs.slice(5).sort((x, y) => x - y);
  const avg = a.reduce((s, x) => s + x, 0) / a.length;
  return { frames: a.length, fps: Math.round(1000 / avg), p95ms: +a[Math.floor(a.length * 0.95)].toFixed(2), info: r.info() };
}

(window as unknown as { lab: unknown }).lab = { wallRun, tower, staircase, field, destroy, measure, cam, rampChain, ready: true };

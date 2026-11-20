/**
 * Dev-only visual lab for piece damage (served by `pnpm dev` at /tests/visual/piece-damage.html, not part of the build).
 * Drives the real Renderer with synthetic snapshots so each piece kind can be shown at fixed hp, shot, and destroyed.
 * Used by tests/visual/shots.mjs to produce docs/screens/piece-damage.png and piece-destroy.png.
 */
import { PIECES } from '../../src/sim/constants';
import { buildMapDef } from '../../src/sim/map';
import type { MatchEvent, PieceKind, PieceState, Snapshot } from '../../src/sim/types';
import { Renderer } from '../../src/client/render';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const label = document.getElementById('label')!;
const tiersEl = document.getElementById('tiers')!;
const r = await Renderer.create(canvas);
const def = buildMapDef(2);
const map = def.islands;
r.setMap(def, 0);
const C = map[0].center, GY = map[0].groundY;

let pieces: PieceState[] = [];
let tick = 0;
let pending: MatchEvent[] = [];
const push = () => {
  const s: Snapshot = {
    time: tick / 30, tick: tick++, players: [], pieces, loot: [], generators: [], sealed: [false, false], waterY: 0,
    suddenDeath: false, winner: null, events: pending,
  };
  pending = [];
  r.pushSnapshot(s);
};

let nextId = 1;
const setCam = (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
  r.camera.position.set(x, y, z);
  r.camera.lookAt(tx, ty, tz);
};

/** Place `hps` (fractions) of one kind in a row facing the camera; returns their ids. */
function setup(kind: PieceKind, hps: number[] = [1, 0.6, 0.25], dist = 0) {
  const s = PIECES[kind];
  const gap = Math.max(s.w, 2) + (kind === 'container' ? 0.8 : 1.2);
  const y = kind === 'scaffold' ? GY + 1.2 : GY;
  pieces = hps.map((f, i) => ({
    id: nextId++, kind, owner: 0, pos: { x: C.x - 3 - (i - (hps.length - 1) / 2) * gap, y, z: C.z }, rotY: 0, hp: Math.max(1, s.hp * f),
  }));
  label.textContent = kind;
  tiersEl.innerHTML = hps.map((f) => `<span>${Math.round(f * 100)}% hp</span>`).join('');
  const span = gap * hps.length;
  const back = dist || Math.max(4, span * 0.4 + s.h * 0.6);
  const cy = y + s.h * 0.55;
  if (kind === 'scaffold' || kind === 'ramp') setCam(C.x - 3, y + s.h + 2.4 + span * 0.08, C.z - back, C.x - 3, y + s.h * 0.4, C.z + 0.6);
  else setCam(C.x - 3, cy + 0.9, C.z - back, C.x - 3, cy, C.z);
  push();
  return pieces.map((p) => p.id);
}

/** Random hull point on the face toward the camera (local -Z, or top for flat pieces). */
function facePoint(p: PieceState) {
  const s = PIECES[p.kind];
  const lx = (Math.random() - 0.5) * s.w * 0.85;
  if (p.kind === 'scaffold') return { x: p.pos.x + lx, y: p.pos.y + s.h, z: p.pos.z + (Math.random() - 0.5) * s.d * 0.8 };
  if (p.kind === 'ramp') { const t = Math.random() * 0.8 + 0.1; return { x: p.pos.x + lx, y: p.pos.y + t * s.h, z: p.pos.z - s.d / 2 + t * s.d }; }
  return { x: p.pos.x + lx, y: p.pos.y + s.h * (0.1 + Math.random() * 0.8), z: p.pos.z - s.d / 2 };
}

/** Fire `n` bullet hits at piece `id` (decals scale with its damage), optionally lowering hp by `dmg` each. */
function shoot(id: number, n: number, dmg = 0) {
  const p = pieces.find((q) => q.id === id);
  if (!p) return;
  for (let i = 0; i < n; i++) {
    p.hp = Math.max(1, p.hp - dmg);
    pending.push({ t: 0, type: 'pieceHit', data: { piece: id, kind: p.kind, by: 99, source: 'bullet', amount: dmg, hp: p.hp, maxHp: PIECES[p.kind].hp, pos: facePoint(p) } });
  }
  push();
}

/** Bullet holes proportional to damage taken, so the tiers look like they were shot to that hp. */
function shootToTier() {
  for (const p of pieces) {
    const lost = 1 - p.hp / PIECES[p.kind].hp;
    shoot(p.id, Math.round(lost * 22));
  }
}

function explode(id: number) {
  const p = pieces.find((q) => q.id === id);
  if (!p) return;
  pending.push({ t: 0, type: 'pieceHit', data: { piece: id, kind: p.kind, by: 99, source: 'explosive', amount: PIECES[p.kind].hp * 0.3, hp: p.hp, maxHp: PIECES[p.kind].hp, pos: { ...p.pos, y: p.pos.y + 0.5 } } });
  push();
}

function destroy(id: number) {
  const p = pieces.find((q) => q.id === id);
  if (!p) return;
  pieces = pieces.filter((q) => q !== p);
  pending.push({ t: 0, type: 'destroyed', data: { piece: id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y + PIECES[p.kind].h / 2, z: p.pos.z }, rotY: p.rotY } });
  push();
}

/** ~n damaged pieces of every kind spread over the island (perf scene). */
function field(n: number) {
  const kinds = Object.keys(PIECES) as PieceKind[];
  pieces = [];
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length];
    const a = (i / n) * Math.PI * 2 * 3.7, rad = 4 + (i / n) * 15;
    pieces.push({ id: nextId++, kind, owner: 0, pos: { x: C.x + Math.cos(a) * rad, y: GY, z: C.z + Math.sin(a) * rad }, rotY: a, hp: PIECES[kind].hp * (0.2 + 0.7 * ((i * 37) % 10) / 10) });
  }
  label.textContent = `${n} damaged pieces`;
  tiersEl.innerHTML = '';
  setCam(C.x - 24, GY + 9, C.z - 18, C.x, GY, C.z);
  push();
}

/** Continuous firefight: every frame, a few bullet hits + occasional explosive/destroy+respawn. */
let firing = 0;
function firefight(on: boolean) { firing = on ? 1 : 0; }

let frames = 0, frameMs: number[] = [];
let lastT = performance.now();
const loop = () => {
  const now = performance.now();
  frameMs.push(now - lastT); lastT = now;
  frames++;
  if (firing && pieces.length) {
    for (let k = 0; k < 4; k++) {
      const p = pieces[(Math.random() * pieces.length) | 0];
      pending.push({ t: 0, type: 'pieceHit', data: { piece: p.id, kind: p.kind, by: 99, source: 'bullet', amount: 1, hp: p.hp, maxHp: PIECES[p.kind].hp, pos: facePoint(p) } });
    }
    if (frames % 45 === 0) {
      const p = pieces[(Math.random() * pieces.length) | 0];
      pieces = pieces.filter((q) => q !== p);
      pending.push({ t: 0, type: 'destroyed', data: { piece: p.id, kind: p.kind, pos: { x: p.pos.x, y: p.pos.y + PIECES[p.kind].h / 2, z: p.pos.z }, rotY: p.rotY } });
      pieces.push({ ...p, id: nextId++ });
    }
    if (frames % 2 === 0) push();
  }
  r.render(0);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

async function measure(ms: number) {
  frameMs = [];
  await new Promise((res) => setTimeout(res, ms));
  const a = frameMs.slice(5).sort((x, y) => x - y);
  const avg = a.reduce((s, x) => s + x, 0) / a.length;
  return { frames: a.length, fps: 1000 / avg, p95ms: a[Math.floor(a.length * 0.95)], info: r.info(), live: r.world.pieceFx.particles.live, decals: r.world.pieceFx.decals.active };
}

(window as unknown as { lab: unknown }).lab = { setup, shoot, shootToTier, explode, destroy, field, firefight, measure, renderer: r, ready: true };

import * as THREE from 'three/webgpu';
import { DOCK } from '../../sim/constants';
import type { DockDef } from '../../sim/map';
import { ChunkedInstances, type LodPart } from './chunked';
import { brokenDiff } from './cosmeticDiff';
import { boxUV, mat, StaticBatch } from './geo';
import { releaseLods } from './lod';
import { mats } from './materials';
import type { Particles } from './particles';

/**
 * Wooden piers (sim MapDef.docks): every section drawn as one instance of three shared models (whole, scorched,
 * broken stubs), so a blast only swaps instance matrices (zero-scale hide), never rebuilds a batch. The piles stay
 * standing under a broken section (charred stumps); they're merged static geometry built once per map.
 */

const W = DOCK.width, L = DOCK.chunk;
const BOARD = 0.19, PITCH = 0.2, BOARD_T = 0.06;
const STRINGER_X = W / 2 - 0.35;
const PILE_X = W / 2 - 0.15;
/** Whole model up to this (m, high preset; LOD-scaled), a plain slab beyond, culled past FAR. */
const NEAR = 90, FAR = 700;
const CHUNK = 64;

/** Deterministic little hash in [0, 1) so every client draws the same boards. */
const h01 = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

type Look = 'whole' | 'scorched' | 'broken';

function deckModel(look: Look): LodPart[] {
  const M = mats();
  const b = new StaticBatch();
  const boards = Math.round(L / PITCH);
  const fresh = [0x6e5034, 0x62472e, 0x785838, 0x5b4129];
  const burnt = [0x2a1f16, 0x34271b, 0x1f1812, 0x3e2e20];
  for (let i = 0; i < boards; i++) {
    const z = -L / 2 + PITCH / 2 + i * PITCH;
    const r = h01(i + 1);
    const len = W - 0.02 - r * 0.06, off = (h01(i + 7) - 0.5) * 0.05;
    if (look === 'broken') {
      // Only the ragged ends of the boards nailed over each end stringer pair survive, burnt.
      if (i !== 0 && i !== boards - 1 && !(i === 1 && r < 0.6) && !(i === boards - 2 && r > 0.4)) continue;
      for (const side of [-1, 1]) {
        const stub = 0.35 + h01(i * 3 + side) * 0.7;
        b.add(M.wood, boxUV(stub, BOARD_T, BOARD, 0.8), mat(side * (W / 2 - stub / 2), -BOARD_T / 2 - 0.01, z, 0, 0, side * (0.04 + r * 0.1)), burnt[(i + side + 2) % 4]);
      }
      continue;
    }
    // A scorched deck: blackened boards, one split short.
    const col = look === 'scorched' ? burnt[(i + Math.floor(r * 4)) % 4] : fresh[(i + Math.floor(r * 4)) % 4];
    const short = look === 'scorched' && i === 3 ? 0.55 : 1;
    b.add(M.wood, boxUV(len * short, BOARD_T, BOARD, 0.8), mat(off + (short < 1 ? (W - len * short) / 2 - 0.02 : 0), -BOARD_T / 2, z), col);
  }
  // Stringers under the boards, along the pier: whole, or snapped off near each end.
  const sCol = look === 'whole' ? 0x4a3622 : 0x221a13;
  for (const x of [-STRINGER_X, STRINGER_X]) {
    if (look === 'broken') {
      for (const end of [-1, 1]) {
        const stub = 0.3 + h01(x * 10 + end) * 0.35;
        b.add(M.wood, boxUV(0.12, 0.24, stub, 0.8), mat(x, -BOARD_T - 0.12 - 0.03, end * (L / 2 - stub / 2), end * 0.12, 0, 0), sCol);
      }
    } else b.add(M.wood, boxUV(0.12, 0.24, L, 0.8), mat(x, -BOARD_T - 0.12, 0), sCol);
  }
  return b.take().map(({ material, geometry, cast, receive }) => ({ material, geometry, cast, receive }));
}

/** Far stand-in: a plain slab (nothing for a broken section). */
function slabModel(look: Look): LodPart[] | null {
  if (look === 'broken') return null;
  const b = new StaticBatch();
  b.add(mats().wood, boxUV(W, DOCK.deck, L, 1.5), mat(0, -DOCK.deck / 2, 0), look === 'whole' ? 0x66492f : 0x2a1f16, false);
  return b.take().map(({ material, geometry, cast, receive }) => ({ material, geometry, cast, receive }));
}

export class DockLayer {
  readonly root = new THREE.Group();
  private layers: Record<Look, ChunkedInstances>;
  private index = new Map<number, number>();
  private byId = new Map<number, DockDef>();
  private gone = new Set<number>();
  private hot = new Set<number>();

  constructor(defs: DockDef[], waterY: number) {
    this.root.name = 'docks';
    const make = (look: Look) => new ChunkedInstances({
      name: `dock:${look}`,
      levels: [{ parts: deckModel(look), maxDist: NEAR }, { parts: slabModel(look), maxDist: FAR }],
      chunk: CHUNK,
    });
    this.layers = { whole: make('whole'), scorched: make('scorched'), broken: make('broken') };
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (const d of defs) {
      const m = new THREE.Matrix4().compose(p.set(d.center.x, d.center.y + d.half.y, d.center.z), q.setFromAxisAngle(up, d.rotY), one);
      let k = -1;
      for (const look of ['whole', 'scorched', 'broken'] as const) k = this.layers[look].add(m);
      this.index.set(d.id, k); // same slot in every layer (added in lockstep)
      this.byId.set(d.id, d);
      this.layers.scorched.setVisible(k, false);
      this.layers.broken.setVisible(k, false);
    }
    for (const look of ['whole', 'scorched', 'broken'] as const) this.root.add(this.layers[look].build());
    pileBatch(defs, waterY).build(this.root, 'docks', { chunked: true });
  }

  /** Snapshot state: `docks` broken ids (append-only), `hurt` scorched ones still standing. */
  sync(broken: readonly number[], hurt: readonly number[]) {
    const { hide, reset } = brokenDiff(this.gone, broken);
    if (reset) { for (const id of [...this.gone]) this.show(id, 'whole'); this.gone.clear(); }
    for (const id of hide) this.show(id, 'broken');
    if (hurt.length !== this.hot.size || reset) {
      for (const id of hurt) if (!this.hot.has(id) && !this.gone.has(id)) { this.hot.add(id); this.show(id, 'scorched'); }
      if (this.hot.size > hurt.length) {
        const now = new Set(hurt);
        for (const id of [...this.hot]) if (!now.has(id)) { this.hot.delete(id); if (!this.gone.has(id)) this.show(id, 'whole'); }
      }
    }
  }

  private show(id: number, look: Look) {
    const k = this.index.get(id);
    if (k === undefined) return; // a stale id from another map
    if (look === 'broken') { this.gone.add(id); this.hot.delete(id); }
    for (const l of ['whole', 'scorched', 'broken'] as const) this.layers[l].setVisible(k, l === look);
  }

  /** `dockBroken` event: swap to the stubs now (the snapshot agrees a moment later) and throw the planks. */
  onBroken(data: Record<string, unknown>, particles: Particles, waterY: number) {
    const d = this.byId.get(data.id as number);
    if (!d) { console.warn('[world/docks] dockBroken for an unknown section', data); return; }
    if (!this.gone.has(d.id)) this.show(d.id, 'broken');
    burst(d, particles, waterY);
  }

  dispose() {
    for (const l of Object.values(this.layers)) l.dispose();
    releaseLods(this.root);
    this.root.traverse((o) => { if (o instanceof THREE.Mesh && o.name.startsWith('docks:')) o.geometry.dispose(); });
    this.root.removeFromParent();
  }
}

/** Piles (two per section joint), pile caps and a cross brace under each joint: merged once, never change. */
function pileBatch(defs: DockDef[], waterY: number): StaticBatch {
  const M = mats();
  const b = new StaticBatch();
  const pile = new THREE.CylinderGeometry(0.13, 0.15, 1, 8);
  for (const d of defs) {
    const top = d.center.y - d.half.y;
    const base = waterY - 3;
    const S = mat(d.center.x, 0, d.center.z, 0, d.rotY, 0);
    for (const end of d.row === 0 ? [-1, 1] : [1]) {
      const z = end * (L / 2);
      for (const x of [-PILE_X, PILE_X]) b.add(M.wood, pile, S.clone().multiply(mat(x, (top + base) / 2, z, 0, 0, 0, 1, top - base, 1)), 0x4d3b28, true);
      b.add(M.wood, boxUV(W, 0.16, 0.18, 1), S.clone().multiply(mat(0, top - 0.08, z)), 0x5a4430, false); // pile cap
      // cross brace between the two piles, from the waterline up to the cap
      const rise = top - 0.16 - (waterY + 0.3);
      b.add(M.wood, boxUV(Math.hypot(2 * PILE_X, rise), 0.16, 0.08), S.clone().multiply(mat(0, waterY + 0.3 + rise / 2, z + 0.16, 0, 0, Math.atan2(rise, 2 * PILE_X))), 0x4a3826, false);
    }
  }
  return b;
}

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();

/** Planks and splinters flying, a puff of dust and smoke, and the spray where the wreckage hits the water. */
function burst(d: DockDef, particles: Particles, waterY: number) {
  const { debris, dust } = particles;
  const top = d.center.y + d.half.y;
  const c = Math.cos(d.rotY), s = Math.sin(d.rotY);
  const at = (lx: number, lz: number) => ({ x: d.center.x + lx * c + lz * s, z: d.center.z - lx * s + lz * c });
  for (let i = 0; i < 12; i++) {
    const p = at(rr(-W / 2, W / 2), rr(-L / 2, L / 2));
    const a = R() * Math.PI * 2, out = rr(0.5, 3);
    debris.spawn(p.x, top - 0.05, p.z, Math.cos(a) * out, rr(2, 6), Math.sin(a) * out, rr(0.6, 1.6), BOARD_T, BOARD,
      i % 3 ? 0x8f6e47 : 0x3b2c1f, rr(2.2, 3.4), waterY - 0.1, d.rotY + rr(-0.5, 0.5));
  }
  for (let i = 0; i < 22; i++) {
    const p = at(rr(-W / 2, W / 2), rr(-L / 2, L / 2));
    const a = R() * Math.PI * 2, out = rr(1, 5);
    debris.spawn(p.x, top, p.z, Math.cos(a) * out, rr(3, 8), Math.sin(a) * out, rr(0.08, 0.3), rr(0.015, 0.03), rr(0.015, 0.04),
      i % 2 ? 0xd9b27a : 0x5a4430, rr(1, 2), waterY - 0.1);
  }
  for (let i = 0; i < 8; i++) {
    const p = at(rr(-W / 2, W / 2), rr(-L / 2, L / 2));
    const a = R() * Math.PI * 2, v = rr(0.4, 1.4);
    dust.spawn(p.x, top + rr(0, 0.4), p.z, Math.cos(a) * v, rr(0.4, 1.2), Math.sin(a) * v, rr(1.2, 2.2), rr(0.4, 0.7), rr(1.2, 2.2), 0.42, 0.38, 0.33, 0.6, -0.3, 1.6);
  }
  // Spray as the wreckage drops in.
  for (let i = 0; i < 14; i++) {
    const p = at(rr(-W / 2, W / 2), rr(-L / 2, L / 2));
    const a = R() * Math.PI * 2, v = rr(0.3, 1.4);
    dust.spawn(p.x, waterY + 0.05, p.z, Math.cos(a) * v, rr(2.5, 5), Math.sin(a) * v, rr(0.6, 1), rr(0.08, 0.14), rr(0.25, 0.45), 0.85, 0.9, 0.95, 0.85, 9, 0.5);
  }
}

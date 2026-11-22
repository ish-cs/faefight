import * as THREE from 'three/webgpu';
import { attribute, float, texture, uv, vec2 } from 'three/tsl';
import { PIECES, WEAPONS } from '../../sim/constants';
import type { MapDef } from '../../sim/map';
import type { MatchEvent, PieceState, PlayerState, Vec3, WeaponKind } from '../../sim/types';
import { rotateY, v3 } from '../../sim/vec';
import { canvasTex, makeRng } from './textures';
import type { Particles } from './particles';
import type { Quality } from './sky';
import { isPropOwner, MARK, OWNER_WORLD, ownCosmetic, ownDock, ownHazard, ownProp, SURFACE_BURST, SURFACE_MARK, SurfaceMap, type MarkKind, type SurfaceHit, type WorldSurface } from './surfaces';

/** Most marks alive at once per quality preset; the oldest fade out as they near eviction. */
export const DECAL_CAP: Record<Quality, number> = { low: 120, high: 300, ultra: 480 };
const MAX_CAP = Math.max(...Object.values(DECAL_CAP));
/** The oldest this many marks fade (linearly) toward eviction. */
const FADE_N = 24;

/**
 * Ring buffer of decal slots (no rendering): reuses free slots, then grows to the cap, then evicts the oldest.
 * `owner` ties a mark to what it sits on (a building piece, pier section, prop: see surfaces.ts owners) so it goes
 * away with it; -1 = the static world. Owned slots are indexed by owner: dropping one owner touches only its marks.
 */
export class DecalRing {
  private seq: Float64Array;
  private own: Int32Array;
  private free: number[] = [];
  private byOwner = new Map<number, Set<number>>();
  private high = 0;
  private counter = 0;
  private n = 0;

  constructor(private cap: number, readonly max = cap) {
    this.seq = new Float64Array(max);
    this.own = new Int32Array(max).fill(-1);
  }

  /** Slots ever used (draw count). */
  get used() { return this.high; }
  get live() { return this.n; }
  get limit() { return this.cap; }

  /** Lower/raise the cap (quality change). Returns slots to clear (dropped beyond a lowered cap). */
  setCap(cap: number): number[] {
    const c = Math.max(1, Math.min(this.max, cap));
    const dropped: number[] = [];
    if (c < this.cap) {
      // Keep the newest `c` marks; drop the rest.
      const order = this.liveSlots().sort((a, b) => this.seq[b] - this.seq[a]);
      for (const s of order.slice(c)) { this.release(s); dropped.push(s); }
    }
    this.cap = c;
    return dropped;
  }

  private liveSlots(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.high; i++) if (this.seq[i] > 0) out.push(i);
    return out;
  }

  private release(s: number) {
    if (this.seq[s] > 0) this.n--;
    this.unindex(s);
    this.seq[s] = 0;
    this.own[s] = -1;
    this.free.push(s);
  }

  private unindex(s: number) {
    const o = this.own[s];
    if (o === OWNER_WORLD) return;
    const set = this.byOwner.get(o);
    if (!set) return;
    set.delete(s);
    if (!set.size) this.byOwner.delete(o);
  }

  /** A slot for a new mark (evicting the oldest when full). `evicted` = whether a live mark was replaced. */
  add(owner = -1): { slot: number; evicted: boolean } {
    let slot = -1, evicted = false;
    if (this.live >= this.cap) {
      let best = Infinity;
      for (let i = 0; i < this.high; i++) if (this.seq[i] > 0 && this.seq[i] < best) { best = this.seq[i]; slot = i; }
      evicted = true;
    } else if (this.free.length) slot = this.free.pop()!;
    else if (this.high < this.max) slot = this.high++;
    else {
      let best = Infinity;
      for (let i = 0; i < this.high; i++) if (this.seq[i] < best) { best = this.seq[i]; slot = i; }
      evicted = this.seq[slot] > 0;
    }
    if (!(this.seq[slot] > 0)) this.n++;
    else this.unindex(slot);
    this.seq[slot] = ++this.counter;
    this.own[slot] = owner;
    if (owner !== OWNER_WORLD) {
      const set = this.byOwner.get(owner);
      if (set) set.add(slot); else this.byOwner.set(owner, new Set([slot]));
    }
    return { slot, evicted };
  }

  /** Opacity of a slot's mark: 1, falling to ~0 for the oldest FADE_N while the ring is full. */
  alpha(slot: number): number {
    const s = this.seq[slot];
    if (s <= 0) return 0;
    const n = this.live;
    if (n < this.cap - FADE_N) return 1;
    // Rank from the oldest (0) among live marks, approximated by sequence numbers.
    const rank = s - (this.counter - n);
    const fullness = Math.min(1, (n - (this.cap - FADE_N)) / FADE_N);
    return Math.min(1, 1 - fullness + fullness * Math.min(1, rank / FADE_N));
  }

  /** Drop every mark owned by `owner` (not the world's: see clear); returns the freed slots. */
  removeOwner(owner: number): number[] {
    const set = this.byOwner.get(owner);
    if (!set) return [];
    const out = [...set];
    for (const i of out) this.release(i);
    return out;
  }

  /** Drop every mark; returns the freed slots. */
  clear(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.high; i++) if (this.seq[i] > 0) { this.release(i); out.push(i); }
    return out;
  }

  /** Owners with live marks (the world excluded). */
  owners(): IterableIterator<number> { return this.byOwner.keys(); }

  /** Live slots of `owner`, if any. */
  slotsOf(owner: number): ReadonlySet<number> | undefined { return this.byOwner.get(owner); }
}

/** Mark size (m) by atlas cell. */
const MARK_SIZE: Record<MarkKind, number> = { chip: 0.13, dent: 0.12, paint: 0.2, splinter: 0.15, bark: 0.17, divot: 0.22, scorch: 2.4, crater: 1.3 };

let atlas: THREE.CanvasTexture | null = null;
/** 4×2 atlas: chip, dent, paint, splinter / bark, divot, scorch, crater (see MARK). */
export function impactAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const { rnd, rr } = makeRng(4141);
  atlas = canvasTex(1024, 512, (g) => {
    g.clearRect(0, 0, 1024, 512);
    const S = 256;
    const cell = (i: number, draw: (cx: number, cy: number, R: number) => void) => {
      const x = (i % 4) * S, y = Math.floor(i / 4) * S;
      g.save(); g.beginPath(); g.rect(x, y, S, S); g.clip();
      draw(x + S / 2, y + S / 2, S / 2);
      g.restore();
    };
    const radial = (cx: number, cy: number, r: number, stops: [number, string][]) => {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      for (const [o, c] of stops) gr.addColorStop(o, c);
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    };
    const jag = (cx: number, cy: number, r0: number, r1: number, n: number, fill: string) => {
      g.fillStyle = fill; g.beginPath();
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2, r = k % 2 ? rr(r0, r1) : rr(r0 * 0.7, r0);
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      g.fill();
    };
    const flecks = (cx: number, cy: number, R: number, n: number, fill: string, s0: number, s1: number) => {
      g.fillStyle = fill;
      for (let k = 0; k < n; k++) { const a = rnd() * Math.PI * 2, r = R * Math.sqrt(rnd()); g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rr(s0, s1), 0, Math.PI * 2); g.fill(); }
    };
    // chip: concrete — pale spalled crater, dark core, dust halo
    cell(MARK.chip, (cx, cy, R) => {
      radial(cx, cy, R * 0.95, [[0, 'rgba(60,58,55,0.5)'], [1, 'rgba(60,58,55,0)']]);
      jag(cx, cy, R * 0.45, R * 0.7, 18, 'rgba(205,200,190,0.95)');
      jag(cx, cy, R * 0.28, R * 0.36, 12, 'rgba(70,66,62,1)');
      jag(cx, cy, R * 0.12, R * 0.17, 9, 'rgba(18,17,16,1)');
      flecks(cx, cy, R * 0.85, 14, 'rgba(90,86,80,0.8)', 2, 5);
    });
    // dent: bare metal — shiny dish, dark rim
    cell(MARK.dent, (cx, cy, R) => {
      radial(cx, cy, R * 0.9, [[0, 'rgba(20,20,20,0.55)'], [1, 'rgba(20,20,20,0)']]);
      radial(cx, cy, R * 0.46, [[0, 'rgba(250,250,250,1)'], [0.5, 'rgba(190,192,196,1)'], [0.9, 'rgba(80,82,86,1)'], [1, 'rgba(80,82,86,0)']]);
      radial(cx, cy, R * 0.14, [[0, 'rgba(40,40,42,1)'], [1, 'rgba(120,120,125,1)']]);
    });
    // paint: painted container — chipped paint flakes round a dent (bare metal + primer)
    cell(MARK.paint, (cx, cy, R) => {
      jag(cx, cy, R * 0.6, R * 0.95, 26, 'rgba(150,152,150,0.95)');
      flecks(cx, cy, R * 0.95, 18, 'rgba(160,162,160,0.9)', 4, 10);
      jag(cx, cy, R * 0.35, R * 0.5, 16, 'rgba(120,70,45,0.9)'); // primer/rust
      radial(cx, cy, R * 0.3, [[0, 'rgba(245,245,245,1)'], [0.6, 'rgba(170,172,176,1)'], [1, 'rgba(90,92,95,1)']]);
      radial(cx, cy, R * 0.1, [[0, 'rgba(30,30,32,1)'], [1, 'rgba(90,90,95,1)']]);
    });
    // splinter: planks/crates — fresh splinters round a dark hole
    cell(MARK.splinter, (cx, cy, R) => {
      radial(cx, cy, R * 0.95, [[0, 'rgba(40,24,10,0.5)'], [1, 'rgba(40,24,10,0)']]);
      jag(cx, cy, R * 0.4, R * 0.8, 22, 'rgba(232,196,140,1)');
      g.strokeStyle = 'rgba(120,80,40,0.8)'; g.lineWidth = 3;
      for (let k = 0; k < 9; k++) { const a = rnd() * Math.PI * 2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R * rr(0.4, 0.75), cy + Math.sin(a) * R * rr(0.4, 0.75)); g.stroke(); }
      jag(cx, cy, R * 0.26, R * 0.34, 14, 'rgba(12,7,3,1)');
    });
    // bark: palm trunk — torn bark showing pale fibre, vertical tear
    cell(MARK.bark, (cx, cy, R) => {
      g.fillStyle = 'rgba(200,170,120,1)';
      g.beginPath(); g.ellipse(cx, cy, R * 0.34, R * 0.7, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(140,105,60,0.9)'; g.lineWidth = 2.5;
      for (let k = 0; k < 12; k++) { const x = cx + rr(-R * 0.3, R * 0.3); g.beginPath(); g.moveTo(x, cy - R * rr(0.4, 0.7)); g.lineTo(x + rr(-6, 6), cy + R * rr(0.4, 0.7)); g.stroke(); }
      jag(cx, cy, R * 0.16, R * 0.24, 10, 'rgba(30,20,10,1)');
    });
    // divot: sand / gravel / grass — dark kicked-up pit with a spray of grains
    cell(MARK.divot, (cx, cy, R) => {
      radial(cx, cy, R * 0.9, [[0, 'rgba(60,48,30,0.55)'], [0.6, 'rgba(60,48,30,0.25)'], [1, 'rgba(60,48,30,0)']]);
      radial(cx, cy, R * 0.32, [[0, 'rgba(35,28,18,0.95)'], [1, 'rgba(70,56,36,0.0)']]);
      flecks(cx, cy, R * 0.9, 26, 'rgba(80,64,40,0.7)', 2, 6);
    });
    // scorch: blast soot, streaky edge
    cell(MARK.scorch, (cx, cy, R) => {
      radial(cx, cy, R * 0.98, [[0, 'rgba(8,7,6,0.95)'], [0.45, 'rgba(14,12,10,0.8)'], [0.8, 'rgba(25,22,20,0.35)'], [1, 'rgba(25,22,20,0)']]);
      g.strokeStyle = 'rgba(10,9,8,0.55)'; g.lineCap = 'round';
      for (let k = 0; k < 40; k++) {
        const a = rnd() * Math.PI * 2, r0 = R * rr(0.3, 0.55), r1 = R * rr(0.7, 0.98);
        g.lineWidth = rr(3, 9); g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke();
      }
    });
    // crater: dark pit, raised pale lip, rubble specks
    cell(MARK.crater, (cx, cy, R) => {
      radial(cx, cy, R * 0.95, [[0, 'rgba(0,0,0,0)'], [0.55, 'rgba(0,0,0,0)'], [0.72, 'rgba(150,140,125,0.85)'], [0.85, 'rgba(110,100,90,0.5)'], [1, 'rgba(60,55,50,0)']]);
      jag(cx, cy, R * 0.5, R * 0.62, 24, 'rgba(20,18,16,0.98)');
      radial(cx, cy, R * 0.45, [[0, 'rgba(5,5,5,1)'], [1, 'rgba(30,27,24,1)']]);
      flecks(cx, cy, R * 0.95, 40, 'rgba(70,64,58,0.9)', 2, 7);
    });
  });
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
  return atlas;
}

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _n = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1), _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _v = new THREE.Vector3();
const _f = new THREE.Matrix4(), _one = new THREE.Vector3(1, 1, 1);

/** A dynamic thing a shot can end on (gameplay prop, hazard); `frame` = a moving prop's current pose. */
export type SolidHit = SurfaceHit & { frame?: { pos: THREE.Vector3; rot: THREE.Quaternion } };

const TINT: Record<WorldSurface, [number, number, number]> = {
  concrete: [0.62, 0.6, 0.57], quay: [0.58, 0.56, 0.52], asphalt: [0.36, 0.36, 0.37], metal: [0.4, 0.4, 0.4], container: [0.4, 0.4, 0.4],
  wood: [0.6, 0.5, 0.38], bark: [0.5, 0.4, 0.3], sand: [0.84, 0.74, 0.54], gravel: [0.6, 0.58, 0.54], grass: [0.46, 0.44, 0.3], water: [0.85, 0.9, 0.95],
};
const CHIP_COLOR: Partial<Record<WorldSurface, number>> = {
  concrete: 0xb8b2a8, quay: 0xa8a294, asphalt: 0x4a4a4c, wood: 0xd9b27a, bark: 0x8a6a44, gravel: 0x8e8a82, sand: 0xd8c08a, grass: 0x6e6a3e, container: 0x9a9c9a,
};

/**
 * Bullet marks and blast marks on the world itself (ground, quay walls, cover, bunkers, cranes, props), matched to
 * the surface, with material-appropriate impact particles: one instanced decal mesh (1 draw call, capped per
 * quality, oldest fade out first). Driven by the existing `shot` / `explosion` events, so online guests get the
 * same marks with no extra state. Built pieces keep their own marks (pieceFx/decals.ts); blast scorch on a piece
 * here is owned by it and vanishes with it. Every mark is owned by what it sits on (surfaces.ts owners): a broken
 * pier section, broken cosmetic, gone hazard or removed piece takes its marks with it (state-driven from snapshots,
 * so replays, spectating and host migration agree); a gameplay prop's marks ride along as it moves.
 */
export class ImpactMarks {
  readonly mesh: THREE.InstancedMesh;
  readonly ring = new DecalRing(DECAL_CAP.high, MAX_CAP);
  private cell: THREE.InstancedBufferAttribute;
  private fade: THREE.InstancedBufferAttribute;
  /** The map's solid boxes + ground surfaces (also read by footprints and ragdolls). */
  surf: SurfaceMap | null = null;
  private dirtyFade = false;
  /** Prop-relative matrix (16 floats per slot) of marks on gameplay props, so they follow the prop. */
  private local = new Float32Array(MAX_CAP * 16);
  /** Pieces the latest sync removed: a shot in the same snapshot may have ended on one (the shot that broke it). */
  private gone: PieceState[] = [];
  private lastPieces: readonly PieceState[] = [];
  /** Gameplay props / hazards at a point (set by the world; null = none). */
  solid: ((p: Vec3) => SolidHit | null) | null = null;

  constructor(private particles: Particles) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CAP), 1).setUsage(THREE.DynamicDrawUsage);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CAP), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('cell', this.cell);
    geo.setAttribute('fade', this.fade);
    const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    mat.name = 'impactDecal';
    const c = attribute('cell', 'float');
    const off = vec2(c.mod(4), float(1).sub(c.div(4).floor()));
    const t = texture(impactAtlas(), uv().mul(vec2(0.25, 0.5)).add(off.mul(vec2(0.25, 0.5))));
    mat.colorNode = t;
    mat.opacityNode = t.a.mul(attribute('fade', 'float'));
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CAP);
    for (let i = 0; i < MAX_CAP; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'impactDecals';
  }

  setMap(def: MapDef) {
    this.surf = new SurfaceMap(def);
    for (let i = 0; i < this.ring.used; i++) this.mesh.setMatrixAt(i, _zero);
    this.ring.clear();
    this.gone = [];
    this.lastPieces = [];
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setQuality(q: Quality) {
    if (this.ring.limit === DECAL_CAP[q]) return;
    for (const s of this.ring.setCap(DECAL_CAP[q])) this.mesh.setMatrixAt(s, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirtyFade = true;
  }

  get active() { return this.ring.live; }

  /** Place a mark of `kind` at `point` facing `normal` (unit), owned by what it sits on (surfaces.ts owners). */
  mark(kind: MarkKind, point: Vec3, normal: Vec3, size = MARK_SIZE[kind], owner = OWNER_WORLD, frame?: SolidHit['frame']) {
    const { slot } = this.ring.add(owner);
    _n.set(normal.x, normal.y, normal.z);
    _q.setFromUnitVectors(_z, _n);
    _q2.setFromAxisAngle(_z, R() * Math.PI * 2);
    _q.multiply(_q2);
    const s = size * rr(0.85, 1.2);
    // Big blast marks sit a touch higher so they stay above uneven ground.
    _m.compose(_p.set(point.x, point.y, point.z).addScaledVector(_n, size > 1 ? 0.02 : 0.006), _q, _s.set(s, s, 1));
    this.mesh.setMatrixAt(slot, _m);
    if (frame && isPropOwner(owner)) _f.compose(frame.pos, frame.rot, _one).invert().multiply(_m).toArray(this.local, slot * 16);
    this.cell.setX(slot, MARK[kind]);
    this.mesh.count = this.ring.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cell.needsUpdate = true;
    this.dirtyFade = true;
  }

  /** Drop every mark of `owner` (cost: its own marks only). */
  drop(owner: number) {
    if (!this.ring.slotsOf(owner)) return;
    for (const s of this.ring.removeOwner(owner)) this.mesh.setMatrixAt(s, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirtyFade = true;
  }

  /** Snapshot pieces (`ids` = their ids): drop marks of pieces no longer there, remember the ones just removed. */
  syncPieces(pieces: readonly PieceState[], ids: ReadonlySet<number>) {
    this.gone.length = 0;
    for (const p of this.lastPieces) if (!ids.has(p.id)) this.gone.push(p);
    this.lastPieces = pieces;
    for (const o of this.ring.owners()) if (o >= 0 && !ids.has(o)) this.drop(o);
  }

  /** Snapshot state of breakables: broken cosmetics, broken pier sections, gone hazards (`hz` st 2) lose their marks. */
  syncBroken(cosmetics: readonly number[], docks: readonly number[], hz: readonly { id: number; st: number }[] | undefined) {
    for (const id of cosmetics) this.drop(ownCosmetic(id));
    for (const id of docks) this.drop(ownDock(id));
    if (this.surf && this.surf.brokenDocks.size !== docks.length) this.surf.brokenDocks = new Set(docks);
    if (hz) for (const h of hz) if (h.st === 2) this.drop(ownHazard(h.id));
  }

  /** A gameplay prop moved: its marks follow (only that prop's marks are touched). */
  followProp(id: number, pos: THREE.Vector3, rot: THREE.Quaternion) {
    const slots = this.ring.slotsOf(ownProp(id));
    if (!slots) return;
    _f.compose(pos, rot, _one);
    for (const s of slots) this.mesh.setMatrixAt(s, _m.fromArray(this.local, s * 16).premultiply(_f));
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  onEvent(e: MatchEvent, view: ImpactView) {
    if (!this.surf || e.data.echo) return;
    if (e.type === 'shot') this.onShot(e.data, view);
    else if (e.type === 'explosion') this.onExplosion(e.data, view);
  }

  private onShot(d: Record<string, unknown>, view: ImpactView) {
    const weapon = d.weapon as WeaponKind;
    if (weapon === 'fists' || weapon === 'rocket' || !WEAPONS[weapon]) return;
    const from = d.from as Vec3, ends = [d.to as Vec3, ...((d.tos as Vec3[] | undefined) ?? [])];
    const range = WEAPONS[weapon].range;
    const broken = new Set(view.broken);
    const ctx = { pieces: view.pieces, players: view.players, waterY: view.waterY, gone: this.gone, solid: this.solid };
    ends.forEach((to, i) => {
      if (!from || !to) return;
      const k = i === 0 ? 1 : 0.5; // shotgun pellets: lighter bursts
      for (const h of this.surf!.propHits(from, to, broken)) this.hit(h, k);
      const h = this.surf!.classify(from, to, range, ctx);
      if (h) this.hit(h, k);
    });
  }

  private hit(h: SolidHit, k: number) {
    const m = SURFACE_MARK[h.surface];
    if (m) this.mark(m, h.point, h.normal, MARK_SIZE[m], h.owner ?? OWNER_WORLD, h.frame);
    this.burst(h.surface, h.point, h.normal, k);
  }

  /** Impact spray by material: concrete dust and chips, sparks on metal, splinters, sand puffs, water splash. */
  burst(surface: WorldSurface, p: Vec3, n: Vec3, k = 1) {
    const { dust, sparks, debris } = this.particles;
    _n.set(n.x, n.y, n.z);
    _t1.set(_n.y, _n.z, -_n.x).cross(_n).normalize();
    _t2.crossVectors(_n, _t1);
    const cone = (speed: number, spread: number) => {
      const a = R() * Math.PI * 2, s = R() * spread;
      return _v.copy(_n).addScaledVector(_t1, Math.cos(a) * s).addScaledVector(_t2, Math.sin(a) * s).normalize().multiplyScalar(speed);
    };
    const [tr, tg, tb] = TINT[surface];
    const style = SURFACE_BURST[surface];
    const floorY = p.y - 3;
    if (style === 'sparks') {
      for (let i = 0; i < Math.round(9 * k); i++) {
        const v = cone(rr(3, 8), 0.9);
        sparks.spawn(p.x, p.y, p.z, v.x, v.y + 1, v.z, rr(0.18, 0.4), rr(0.05, 0.08), 0.015, 1, rr(0.55, 0.8), 0.25, 1, 9, 1.5);
      }
      sparks.spawn(p.x + n.x * 0.03, p.y + n.y * 0.03, p.z + n.z * 0.03, 0, 0, 0, 0.08, 0.3, 0.12, 1, 0.8, 0.45, 1, 0, 0);
      if (surface === 'container') for (let i = 0; i < Math.round(3 * k); i++) { const v = cone(rr(1.5, 3), 0.8); debris.spawn(p.x, p.y, p.z, v.x, v.y + 0.5, v.z, 0.02, 0.004, 0.02, CHIP_COLOR.container!, rr(0.6, 1), floorY); }
      return;
    }
    if (style === 'splash') {
      for (let i = 0; i < Math.round(10 * k); i++) {
        const a = R() * Math.PI * 2, s = rr(0.3, 1.2);
        dust.spawn(p.x, p.y + 0.02, p.z, Math.cos(a) * s, rr(2.5, 4.5), Math.sin(a) * s, rr(0.5, 0.8), rr(0.05, 0.09), rr(0.15, 0.25), tr, tg, tb, 0.85, 9, 0.5);
      }
      dust.spawn(p.x, p.y + 0.05, p.z, 0, 0.3, 0, 0.6, 0.15, 0.6, tr, tg, tb, 0.5, 0, 2);
      return;
    }
    const chip = CHIP_COLOR[surface] ?? 0x999999;
    const puffs = style === 'sand' ? 8 : style === 'dust' ? 5 : 3;
    for (let i = 0; i < Math.round(puffs * k); i++) {
      const v = cone(rr(0.6, 1.8), 0.9);
      dust.spawn(p.x, p.y, p.z, v.x, v.y + (style === 'sand' ? 0.6 : 0), v.z, rr(0.6, 1.1), rr(0.06, 0.1), rr(0.35, 0.65), tr, tg, tb, 0.7, style === 'sand' ? 1.4 : -0.2, 2.2);
    }
    const bits = style === 'splinters' ? 5 : style === 'sand' ? 4 : 4;
    for (let i = 0; i < Math.round(bits * k); i++) {
      const v = cone(rr(1.5, 4), 0.8);
      if (style === 'splinters') debris.spawn(p.x, p.y, p.z, v.x, v.y + 1, v.z, rr(0.06, 0.13), rr(0.012, 0.02), rr(0.012, 0.02), chip, rr(0.6, 1), floorY);
      else debris.spawn(p.x, p.y, p.z, v.x, v.y + 0.6, v.z, rr(0.02, 0.04), rr(0.02, 0.04), rr(0.02, 0.04), chip, rr(0.5, 0.9), floorY);
    }
    if (style === 'dust' && R() < 0.5 * k) sparks.spawn(p.x, p.y, p.z, n.x, n.y + 0.5, n.z, 0.06, 0.12, 0.02, 1, 0.85, 0.6, 1, 0, 0); // ricochet glint
  }

  private onExplosion(d: Record<string, unknown>, view: { pieces: readonly PieceState[]; waterY: number }) {
    const pos = d.pos as Vec3 | undefined;
    const kind = d.kind as 'rocket' | 'grenade' | 'charge';
    if (!pos || !this.surf) return;
    const big = kind === 'rocket' ? 1.15 : kind === 'charge' ? 0.8 : 1;
    // Ground: scorch (+ a crater for rockets and charges) when the blast is low enough to touch it.
    const g = this.surf.groundAt(pos.x, pos.z);
    if (g && pos.y - g.y < 1.6) {
      const at = v3(pos.x, g.y, pos.z), up = v3(0, 1, 0);
      const fall = 1 - Math.max(0, pos.y - g.y) / 1.6;
      this.mark('scorch', at, up, MARK_SIZE.scorch * big * (0.6 + 0.4 * fall));
      if (kind !== 'grenade' || pos.y - g.y < 0.4) this.mark('crater', at, up, MARK_SIZE.crater * big * (0.5 + 0.5 * fall));
      this.groundDebris(at, g.surface, big);
    } else if (pos.y <= view.waterY + 0.8) {
      for (let i = 0; i < 3; i++) this.burst('water', v3(pos.x + rr(-0.6, 0.6), view.waterY, pos.z + rr(-0.6, 0.6)), v3(0, 1, 0), 2);
    }
    // Walls: scorch on any solid face within reach of the blast (map cover, bunkers, cranes)...
    for (const b of this.surf.boxes) {
      if (b.dock !== undefined && this.surf.brokenDocks.has(b.dock)) continue;
      const l = rotateY(v3(pos.x - b.center.x, pos.y - b.center.y, pos.z - b.center.z), -b.rotY);
      const c = v3(Math.max(-b.half.x, Math.min(b.half.x, l.x)), Math.max(-b.half.y, Math.min(b.half.y, l.y)), Math.max(-b.half.z, Math.min(b.half.z, l.z)));
      const dd = Math.hypot(l.x - c.x, l.y - c.y, l.z - c.z);
      if (dd > 1.3 || dd < 1e-3) continue;
      const nl = v3((l.x - c.x) / dd, (l.y - c.y) / dd, (l.z - c.z) / dd);
      if (Math.abs(nl.y) > 0.7) continue; // roofs: the ground scorch reads fine
      const w = rotateY(c, b.rotY), nw = rotateY(axisOf(nl), b.rotY);
      this.mark('scorch', v3(b.center.x + w.x, b.center.y + w.y, b.center.z + w.z), nw, MARK_SIZE.scorch * 0.7 * big * (1 - dd / 1.6), b.owner);
    }
    // ...and on surviving built pieces (owned: gone with the piece).
    for (const pc of view.pieces) {
      const s = PIECES[pc.kind];
      const l = rotateY(v3(pos.x - pc.pos.x, pos.y - pc.pos.y - s.h / 2, pos.z - pc.pos.z), -pc.rotY);
      const c = v3(Math.max(-s.w / 2, Math.min(s.w / 2, l.x)), Math.max(-s.h / 2, Math.min(s.h / 2, l.y)), Math.max(-s.d / 2, Math.min(s.d / 2, l.z)));
      const dd = Math.hypot(l.x - c.x, l.y - c.y, l.z - c.z);
      if (dd > 1.6 || dd < 1e-3) continue;
      const nl = axisOf(v3((l.x - c.x) / dd, (l.y - c.y) / dd, (l.z - c.z) / dd));
      const w = rotateY(c, pc.rotY), nw = rotateY(nl, pc.rotY);
      this.mark('scorch', v3(pc.pos.x + w.x, pc.pos.y + s.h / 2 + w.y, pc.pos.z + w.z), nw, Math.min(1.6, MARK_SIZE.scorch * 0.6 * big * (1 - dd / 2)), pc.id);
    }
  }

  /** Chunks of whatever the blast dug up. */
  private groundDebris(at: Vec3, surface: WorldSurface, big: number) {
    const col = CHIP_COLOR[surface] ?? 0x8a8478;
    const [tr, tg, tb] = TINT[surface];
    for (let i = 0; i < Math.round(14 * big); i++) {
      const a = R() * Math.PI * 2, s = rr(2, 6);
      const z = rr(0.04, 0.12);
      this.particles.debris.spawn(at.x, at.y + 0.1, at.z, Math.cos(a) * s, rr(3, 7), Math.sin(a) * s, z, z * rr(0.6, 1), z, col, rr(1.5, 2.6), at.y);
    }
    for (let i = 0; i < Math.round(10 * big); i++) {
      const a = R() * Math.PI * 2, s = rr(1, 3);
      this.particles.dust.spawn(at.x, at.y + 0.2, at.z, Math.cos(a) * s, rr(0.5, 2), Math.sin(a) * s, rr(1.5, 3), rr(0.4, 0.7), rr(1.6, 2.6), tr, tg, tb, 0.6, -0.2, 1.2);
    }
  }

  /** Per frame: refresh fades after changes (cheap: one small attribute upload). */
  update() {
    if (!this.dirtyFade) return;
    this.dirtyFade = false;
    const n = this.ring.used;
    for (let i = 0; i < n; i++) this.fade.setX(i, this.ring.alpha(i));
    this.fade.clearUpdateRanges(); this.fade.addUpdateRange(0, n); this.fade.needsUpdate = true;
  }
}

export type ImpactView = { pieces: readonly PieceState[]; players: readonly PlayerState[]; waterY: number; broken: readonly number[] };

/** Snap a unit vector to its dominant axis (box face normal). */
function axisOf(n: Vec3): Vec3 {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  return ax >= ay && ax >= az ? v3(Math.sign(n.x), 0, 0) : ay >= az ? v3(0, Math.sign(n.y), 0) : v3(0, 0, Math.sign(n.z));
}

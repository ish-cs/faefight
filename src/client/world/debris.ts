import * as THREE from 'three/webgpu';
import { installBatchCull } from './batchCull';
import type { MapDef } from '../../sim/map';
import type { MatchEvent, PieceState, Vec3 } from '../../sim/types';
import { DEBRIS_KINDS, DEBRIS_SPEC, type DebrisKind, placeDebris } from './debrisPlace';
import { DebrisSim } from './debrisSim';
import { merge, part } from './geo';
import { boxTape, faceLabel, labelMaterial } from './labels';
import { SHADOW_ONLY_FIRST_LAYER } from './lod';
import { mats } from './materials';
import type { Quality } from './sky';
import { movingVariant } from './weathering';

/**
 * Tier-B cosmetic debris (bottles, cans, small boxes, cones, planks, small buoys): instanced meshes driven by the
 * client-only DebrisSim. Purely visual: nothing here reaches the sim, blocks players or bullets.
 */
/** low: no physics debris at all (frame budget; the static scatter still litters the ground) */
const DENSITY: Record<Quality, number> = { low: 0, high: 0.75, ultra: 1 };
const CAP: Record<Quality, number> = { low: 60, high: 150, ultra: 150 };

/** One place per kind for geometry (centred on the body origin, like the colliders). */
function geometryFor(kind: DebrisKind): THREE.BufferGeometry {
  const [hx, hy, hz] = DEBRIS_SPEC[kind].half;
  switch (kind) {
    case 'bottle': {
      const prof = [0, 0.033, 0.035, 0.035, 0.03, 0.014, 0.013, 0.015, 0];
      const ys = [0, 0, 0.005, 0.15, 0.18, 0.21, 0.26, 0.265, 0.265];
      return new THREE.LatheGeometry(prof.map((r, i) => new THREE.Vector2(r, ys[i] - hy)), 8);
    }
    case 'can': return new THREE.CylinderGeometry(hx, hx, hy * 2, 10);
    case 'box': return new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    case 'cone': return new THREE.ConeGeometry(hx, hy * 2, 12);
    case 'plank': return new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    case 'buoy': return new THREE.SphereGeometry(hx, 12, 8);
  }
}

/** Printed/taped overlay per kind (a second instanced mesh sharing the body's matrices). */
function overlayFor(kind: DebrisKind): THREE.BufferGeometry | null {
  if (kind !== 'box') return null;
  const [hx, hy, hz] = DEBRIS_SPEC.box.half;
  return merge([
    ...boxTape(hx, hy, hz).map((g) => part(g, null)),
    part(faceLabel(0.16, 0.16, new THREE.Vector3(hx * 0.3, -hy * 0.15, hz), new THREE.Vector3(0, 0, 1), 2), null),
  ]);
}

/** depth-only material for the debris' shadow batch (never drawn by the camera) */
const SHADOW_MAT = new THREE.MeshBasicNodeMaterial();

export class Debris {
  readonly root = new THREE.Group();
  sim: DebrisSim | null = null;
  /** one BatchedMesh per material across kinds (+ labels, + one shadow-only batch): ~4 + 1 draws instead of ~9 + 2 */
  private batches: THREE.BatchedMesh[] = [];
  /** prop index → its instance in each batch it appears in (body, overlay, shadow) */
  private slot: { mesh: THREE.BatchedMesh; id: number }[][] = [];
  private building: Promise<void> | null = null;
  private gen = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  /** weathered in object space (they tumble): instance colour tints, instance hash varies wear */
  private mats = {
    // Shared with the gameplay props (same moving variants, same vertex layout via part()): no debris-only pipelines.
    // Per-prop look comes from the instance colour (tint) and the instance hash (wear).
    shiny: movingVariant(mats().galv),
    cardboard: movingVariant(mats().matte),
    wood: movingVariant(mats().wood),
    plastic: movingVariant(mats().paint),
  };

  constructor() { this.root.name = 'debris'; }

  /** Lay out and simulate a map's debris (async: Rapier init; frames before it resolves just show nothing). */
  build(def: MapDef, quality: Quality): Promise<void> {
    this.clear();
    const gen = ++this.gen;
    const t0 = performance.now();
    if (DENSITY[quality] === 0) { console.info('[debris] off at this preset'); return Promise.resolve(); }
    const spawns = placeDebris(def, DENSITY[quality]);
    this.building = DebrisSim.create(def, spawns, { cap: CAP[quality] }).then((sim) => {
      if (gen !== this.gen) { sim.dispose(); return; }
      this.sim = sim;
      const byKind = new Map<DebrisKind, number[]>();
      sim.props.forEach((p, i) => { let a = byKind.get(p.spawn.kind); if (!a) byKind.set(p.spawn.kind, a = []); a.push(i); });
      const col = new THREE.Color();
      const matOf = (kind: DebrisKind) => kind === 'bottle' || kind === 'can' ? this.mats.shiny : kind === 'box' ? this.mats.cardboard : kind === 'plank' ? this.mats.wood : this.mats.plastic;
      const label = movingVariant(labelMaterial());
      const geos = new Map<DebrisKind, { body: THREE.BufferGeometry; overlay: THREE.BufferGeometry | null; ids: number[] }>();
      for (const kind of DEBRIS_KINDS) {
        const ids = byKind.get(kind);
        if (ids) geos.set(kind, { body: part(geometryFor(kind), null), overlay: overlayFor(kind), ids });
      }
      sim.props.forEach((_, pi) => { this.slot[pi] = []; });
      const batch = (name: string, material: THREE.Material, entries: { geo: THREE.BufferGeometry; ids: number[]; tint: boolean }[], shadow = false) => {
        if (!entries.length) return;
        const m = new THREE.BatchedMesh(entries.reduce((n, e) => n + e.ids.length, 0), entries.reduce((n, e) => n + e.geo.getAttribute('position').count, 0), 0, material);
        installBatchCull(m);
        m.name = name;
        m.castShadow = shadow;
        m.receiveShadow = !shadow;
        m.layers.set(shadow ? SHADOW_ONLY_FIRST_LAYER : 0); // shadow batch: first cascade only, never drawn by the camera
        m.frustumCulled = false; // spans the map; perObjectFrustumCulled culls each instance
        m.sortObjects = false; // per-pass depth sort of every instance cost more than the overdraw it saves
        for (const e of entries) {
          const gid = m.addGeometry(e.geo);
          for (const pi of e.ids) {
            const id = m.addInstance(gid);
            if (e.tint) m.setColorAt(id, col.setHex(sim.props[pi].spawn.tint));
            this.slot[pi].push({ mesh: m, id });
          }
        }
        this.batches.push(m);
        this.root.add(m);
      };
      const byMat = new Map<THREE.Material, { geo: THREE.BufferGeometry; ids: number[]; tint: boolean }[]>();
      for (const [kind, g] of geos) {
        const e = byMat.get(matOf(kind)) ?? [];
        e.push({ geo: g.body, ids: g.ids, tint: true });
        byMat.set(matOf(kind), e);
      }
      for (const [mat, entries] of byMat) batch(`debris:${mat.name}`, mat, entries);
      batch('debris:labels', label, [...geos.values()].filter((g) => g.overlay).map((g) => ({ geo: g.overlay!, ids: g.ids, tint: false })));
      // only boxes and cones cast (the rest are too small to matter)
      batch('debris:shadow', SHADOW_MAT, [...geos].filter(([k]) => k === 'box' || k === 'cone').map(([, g]) => ({ geo: g.body, ids: g.ids, tint: false })), true);
      this.writeMatrices(true);
      console.info(`[debris] ${sim.props.length} props in ${geos.size} kinds (${this.batches.length} batches), cap ${sim.cap} bodies (${Math.round(performance.now() - t0)} ms)`);
    }, (err) => console.error('[debris] physics world failed; debris disabled', err));
    return this.building;
  }

  private writeMatrices(all: boolean) {
    const sim = this.sim;
    if (!sim) return;
    sim.props.forEach((p, pi) => {
      if (!all && !p.dirty) return;
      p.dirty = false;
      const o = p.pose;
      this.m4.compose(this.p.set(o.x, o.y, o.z), this.q.set(o.qx, o.qy, o.qz, o.qw), this.one);
      for (const sl of this.slot[pi]) { sl.mesh.setMatrixAt(sl.id, this.m4); sl.mesh.setVisibleAt(sl.id, !p.sunk); }
    });
  }

  /** Per frame: step the cosmetic world, push moved poses to the GPU. */
  update(dt: number, focus: Vec3, feet: Vec3[], waterY: number) {
    if (!this.sim) return;
    this.sim.step(dt, focus, feet, waterY);
    this.writeMatrices(false);
  }

  onEvent(e: MatchEvent, focus: Vec3) {
    if (!this.sim) return;
    if (e.type === 'explosion' && e.data.pos) this.sim.explosion(e.data.pos as Vec3, String(e.data.kind), focus);
    else if (e.type === 'shot' && e.data.from && e.data.to && e.data.weapon !== 'fists') this.sim.shot(e.data.from as Vec3, e.data.to as Vec3, focus);
  }

  syncPieces(pieces: PieceState[]) { this.sim?.setPieces(pieces); }

  /** Debug/harness: the closest resting prop's position. */
  nearestProp(at: Vec3) {
    const p = this.sim?.nearest(at.x, at.z);
    return p ? { x: p.pose.x, y: p.pose.y, z: p.pose.z, kind: p.spawn.kind } : null;
  }

  stats() {
    const s = this.sim;
    return s ? { props: s.props.length, active: s.activeCount, awake: s.awakeCount, ...s.stats } : null;
  }

  clear() {
    this.gen++;
    this.sim?.dispose();
    this.sim = null;
    for (const m of this.batches) { m.removeFromParent(); m.dispose(); }
    this.batches = [];
    this.slot = [];
  }
}

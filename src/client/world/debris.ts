import * as THREE from 'three/webgpu';
import type { MapDef } from '../../sim/map';
import type { MatchEvent, PieceState, Vec3 } from '../../sim/types';
import { DEBRIS_KINDS, DEBRIS_SPEC, type DebrisKind, placeDebris } from './debrisPlace';
import { DebrisSim } from './debrisSim';
import { merge, part } from './geo';
import { boxTape, faceLabel, labelMaterial } from './labels';
import { mats } from './materials';
import type { Quality } from './sky';
import { movingVariant, weather } from './weathering';

/**
 * Tier-B cosmetic debris (bottles, cans, small boxes, cones, planks, small buoys): instanced meshes driven by the
 * client-only DebrisSim. Purely visual: nothing here reaches the sim, blocks players or bullets.
 */
const DENSITY: Record<Quality, number> = { low: 0.35, high: 0.75, ultra: 1 };
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

function material(name: string, o: ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0]) {
  const m = new THREE.MeshStandardNodeMaterial(o);
  m.name = name;
  return m;
}

export class Debris {
  readonly root = new THREE.Group();
  sim: DebrisSim | null = null;
  private meshes = new Map<DebrisKind, { mesh: THREE.InstancedMesh; ids: number[]; overlay: THREE.InstancedMesh | null }>();
  /** prop index → (kind mesh + overlay, instance slot) */
  private slot: { mesh: THREE.InstancedMesh; overlay: THREE.InstancedMesh | null; i: number }[] = [];
  private building: Promise<void> | null = null;
  private gen = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private zero = new THREE.Vector3(0, 0, 0);
  /** weathered in object space (they tumble): instance colour tints, instance hash varies wear */
  private mats = {
    shiny: weather(material('debrisShiny', { roughness: 0.15, metalness: 0.3 }), { objectSpace: true, grime: 0.35, grimeHeight: 0.3, edge: 0.5, chip: 'light', vary: 0.2 }),
    cardboard: movingVariant(mats().matte),
    wood: movingVariant(mats().wood),
    plastic: weather(material('debrisPlastic', { roughness: 0.45 }), { objectSpace: true, grime: 0.55, grimeHeight: 0.4, streaks: 0.3, edge: 0.4, chip: 'light', vary: 0.18 }),
  };

  constructor() { this.root.name = 'debris'; }

  /** Lay out and simulate a map's debris (async: Rapier init; frames before it resolves just show nothing). */
  build(def: MapDef, quality: Quality): Promise<void> {
    this.clear();
    const gen = ++this.gen;
    const t0 = performance.now();
    const spawns = placeDebris(def, DENSITY[quality]);
    this.building = DebrisSim.create(def, spawns, { cap: CAP[quality] }).then((sim) => {
      if (gen !== this.gen) { sim.dispose(); return; }
      this.sim = sim;
      const byKind = new Map<DebrisKind, number[]>();
      sim.props.forEach((p, i) => { let a = byKind.get(p.spawn.kind); if (!a) byKind.set(p.spawn.kind, a = []); a.push(i); });
      const col = new THREE.Color();
      for (const kind of DEBRIS_KINDS) {
        const ids = byKind.get(kind);
        if (!ids) continue;
        const mat = kind === 'bottle' || kind === 'can' ? this.mats.shiny : kind === 'box' ? this.mats.cardboard : kind === 'plank' ? this.mats.wood : this.mats.plastic;
        const mesh = new THREE.InstancedMesh(geometryFor(kind), mat, ids.length);
        mesh.name = `debris:${kind}`;
        mesh.castShadow = kind !== 'bottle' && kind !== 'can';
        mesh.receiveShadow = true;
        mesh.frustumCulled = false; // spans the map
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const og = overlayFor(kind);
        let overlay: THREE.InstancedMesh | null = null;
        if (og) {
          overlay = new THREE.InstancedMesh(og, movingVariant(labelMaterial()), ids.length);
          overlay.name = `debris:${kind}:labels`;
          overlay.frustumCulled = false;
          overlay.receiveShadow = true;
          overlay.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          this.root.add(overlay);
        }
        ids.forEach((pi, i) => {
          this.slot[pi] = { mesh, overlay, i };
          mesh.setColorAt(i, col.setHex(sim.props[pi].spawn.tint));
        });
        this.meshes.set(kind, { mesh, ids, overlay });
        this.root.add(mesh);
      }
      this.writeMatrices(true);
      console.info(`[debris] ${sim.props.length} props in ${this.meshes.size} kinds, cap ${sim.cap} bodies (${Math.round(performance.now() - t0)} ms)`);
    }, (err) => console.error('[debris] physics world failed; debris disabled', err));
    return this.building;
  }

  private writeMatrices(all: boolean) {
    const sim = this.sim;
    if (!sim) return;
    const touched = new Set<THREE.InstancedMesh>();
    sim.props.forEach((p, pi) => {
      if (!all && !p.dirty) return;
      p.dirty = false;
      const s = this.slot[pi], o = p.pose;
      this.m4.compose(this.p.set(o.x, o.y, o.z), this.q.set(o.qx, o.qy, o.qz, o.qw), p.sunk ? this.zero : this.one);
      s.mesh.setMatrixAt(s.i, this.m4);
      touched.add(s.mesh);
      if (s.overlay) { s.overlay.setMatrixAt(s.i, this.m4); touched.add(s.overlay); }
    });
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
    if (all) for (const { mesh } of this.meshes.values()) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
    for (const { mesh, overlay } of this.meshes.values()) for (const m of overlay ? [mesh, overlay] : [mesh]) { m.geometry.dispose(); m.removeFromParent(); m.dispose(); }
    this.meshes.clear();
    this.slot = [];
  }
}

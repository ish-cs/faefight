import * as THREE from 'three/webgpu';
import { predictThrow, type Thrower, type ThrowWorld } from '../../sim/combat';
import { FLASH, GRENADE, SMOKE, THROW, TICK_HZ } from '../../sim/constants';
import type { UtilityKind } from '../../sim/types';

/**
 * Throw preview (grenade / smoke / flash being charged): a dotted arc along the path the sim will fly
 * (combat.predictThrow: the same launch and stepThrown against the predictor's world), a marker where it goes off and
 * a ring of its reach there (frag blast radius, smoke cloud radius, flash full-strength range).
 * Three draws while shown (instanced dots, ring, marker), none otherwise; everything is allocated up front.
 */
const MAX_PTS = Math.round(THROW.fuseSec * TICK_HZ) + 2;
const MAX_DOTS = 72;
/** Spacing of the dots along the arc (m). */
const DOT_STEP = 0.6;
const COLOR: Record<'grenade' | UtilityKind, number> = { grenade: 0xff7a3d, smoke: 0xdfe5ea, flash: 0xfff1a0 };
const REACH: Record<'grenade' | UtilityKind, number> = { grenade: GRENADE.radius, smoke: SMOKE.radius, flash: FLASH.fullRange };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class ThrowArc {
  readonly root = new THREE.Group();
  private pts = new Float32Array(MAX_PTS * 3);
  private dots: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private marker: THREE.Mesh;
  // Dots and ring draw over everything: the arc behind your own avatar, or a landing spot in grass / behind a wall, stays readable.
  private dotMat = new THREE.MeshBasicNodeMaterial({ color: COLOR.grenade, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false });
  private ringMat = new THREE.MeshBasicNodeMaterial({ color: COLOR.grenade, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  private kind: 'grenade' | UtilityKind = 'grenade';
  /** Landing point of the last update (tests / e2e read it). */
  readonly end = { x: 0, y: 0, z: 0, hit: false, count: 0 };
  shown = false;
  get dotCount() { return this.dots.count; }

  constructor() {
    this.root.name = 'throwArc';
    this.dotMat.name = 'throwArc:dots';
    this.ringMat.name = 'throwArc:ring';
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), this.dotMat, MAX_DOTS);
    this.dots.count = 0;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 56).rotateX(-Math.PI / 2), this.ringMat);
    this.marker = new THREE.Mesh(new THREE.CircleGeometry(0.35, 20).rotateX(-Math.PI / 2), this.ringMat);
    for (const o of [this.dots, this.ring, this.marker]) {
      o.frustumCulled = false;
      o.renderOrder = 9;
      o.castShadow = false;
      o.receiveShadow = false;
      this.root.add(o);
    }
    this.root.visible = false;
  }

  /** Recompute and show the arc for a throw by `who` charged to `power` (0..1). No allocations of its own. */
  update(world: ThrowWorld, who: Thrower, kind: 'grenade' | UtilityKind, power: number) {
    if (kind !== this.kind) {
      this.kind = kind;
      this.dotMat.color.setHex(COLOR[kind]).multiplyScalar(1.6);
      this.ringMat.color.setHex(COLOR[kind]).multiplyScalar(1.6);
    }
    const r = predictThrow(world, who, kind, power, this.pts);
    const e = this.end;
    e.x = r.end.x; e.y = r.end.y; e.z = r.end.z; e.hit = r.hit; e.count = r.count;
    // Dots every DOT_STEP metres along the polyline, a bit bigger further out so they read at range.
    const pts = this.pts;
    let n = 0, carry = 0.35; // first dot a little ahead of the hand
    for (let i = 1; i < r.count && n < MAX_DOTS; i++) {
      const ax = pts[i * 3 - 3], ay = pts[i * 3 - 2], az = pts[i * 3 - 1];
      const dx = pts[i * 3] - ax, dy = pts[i * 3 + 1] - ay, dz = pts[i * 3 + 2] - az;
      const len = Math.hypot(dx, dy, dz);
      let t = carry;
      while (t <= len && n < MAX_DOTS) {
        const k = len > 0 ? t / len : 0;
        const size = 0.06 + Math.min(0.08, n * 0.002);
        _p.set(ax + dx * k, ay + dy * k, az + dz * k);
        _m.compose(_p, _q, _s.set(size, size, size));
        this.dots.setMatrixAt(n++, _m);
        t += DOT_STEP;
      }
      carry = t - len;
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    const reach = REACH[kind];
    this.ring.position.set(e.x, e.y + 0.04, e.z);
    this.ring.scale.set(reach, 1, reach);
    this.marker.position.set(e.x, e.y + 0.05, e.z);
    this.ring.visible = this.marker.visible = r.hit;
    this.root.visible = true;
    this.shown = true;
  }

  hide() {
    if (!this.shown) return;
    this.root.visible = false;
    this.shown = false;
  }

  /** Loading warm-up: one of each mesh, so showing the arc mid-match never compiles a shader. */
  warmObjects(): THREE.Object3D[] {
    const instanced = new THREE.InstancedMesh(this.dots.geometry, this.dotMat, 1);
    instanced.setMatrixAt(0, _m.identity());
    return [instanced, new THREE.Mesh(this.ring.geometry, this.ringMat)];
  }
}

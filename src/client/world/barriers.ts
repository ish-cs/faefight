import * as THREE from 'three/webgpu';
import { BARRIER, bunkerBarrierBoxes } from '../../sim/barriers';
import { MAP } from '../../sim/constants';
import type { Box, MapDef } from '../../sim/map';
import { playSfx } from '../audio/api';
import { mats } from './materials';
import { merge, part, mat } from './geo';
import type { Particles } from './particles';

/**
 * Sudden-death doorway barriers (sim/barriers.ts; snapshot `barrierAt`): a cast-concrete blast slab over every
 * doorway of every bunker, in the bunker walls' own weathered concrete. When they drop, each falls from above
 * the doorway a hand's width out from the wall, lands with a thud and a skirt of dust, then is shoved home into
 * the opening. ONE InstancedMesh for all of them (one draw, plus its shadow), matrices rewritten only while
 * they animate; hidden (count 0) until sudden death. A late joiner sees them at rest, no sound or dust.
 */

/** Drop height (m above rest), how far out from the wall it falls, and the timeline (s). */
const DROP_H = 2.6, OUT = 0.34;
const FALL_SEC = 0.32, SETTLE_SEC = 0.1, SHOVE_SEC = 0.14;
export const BARRIER_ANIM_SEC = FALL_SEC + SETTLE_SEC + SHOVE_SEC;
/** Past this long after the drop, a slab first seen is simply there (joined late / scrubbed a replay). */
const LATE_SEC = 1.5;

/** Offset of a slab from its rest pose `dt` s after the drop: [y above rest, distance out from the wall]. */
export function barrierOffset(dt: number): [number, number] {
  if (!(dt >= 0)) return [DROP_H, OUT];
  if (dt < FALL_SEC) { const k = dt / FALL_SEC; return [DROP_H * (1 - k * k), OUT]; } // free fall: y ∝ t²
  if (dt < FALL_SEC + SETTLE_SEC) { const k = (dt - FALL_SEC) / SETTLE_SEC; return [0.03 * Math.sin(Math.PI * k), OUT]; } // tiny bounce
  const k = Math.min(1, (dt - FALL_SEC - SETTLE_SEC) / SHOVE_SEC);
  return [0, OUT * (1 - k * k * (3 - 2 * k))];
}

/**
 * The slab, local frame: base at y 0, X along the doorway, -Z out of the bunker (the sim box's frame). A body with
 * chamfered vertical edges, a slightly wider foot, a form-joint groove, cast-in lifting-anchor recesses on top,
 * and drainage notches at the base; vertex tint darkens toward the ground (splash grime).
 */
function slabGeometry(): THREE.BufferGeometry {
  const W = BARRIER.width, H = BARRIER.height, D = MAP.bunker.wall - BARRIER.inset + BARRIER.proud; // the sim box's depth
  const ch = 0.035; // edge chamfer
  const parts: THREE.BufferGeometry[] = [];
  const uv3 = (g: THREE.BufferGeometry) => { // UVs in metres / 3 like the bunker walls (boxUV tile 3)
    const uv = g.getAttribute('uv') as THREE.BufferAttribute, p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) + p.getZ(i)) / 3, p.getY(i) / 3);
    return g;
  };
  // Body: an octagonal prism (chamfered vertical edges), built as a lathe-free extrusion of the footprint.
  const s = new THREE.Shape();
  const hw = W / 2, hd = D / 2;
  s.moveTo(-hw + ch, -hd); s.lineTo(hw - ch, -hd); s.lineTo(hw, -hd + ch); s.lineTo(hw, hd - ch);
  s.lineTo(hw - ch, hd); s.lineTo(-hw + ch, hd); s.lineTo(-hw, hd - ch); s.lineTo(-hw, -hd + ch); s.closePath();
  const body = new THREE.ExtrudeGeometry(s, { depth: H - 0.02, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 1, curveSegments: 1 });
  body.rotateX(-Math.PI / 2); // extrude along +Y (shape y → -z)
  body.translate(0, 0.02, 0);
  parts.push(part(uv3(body), null, 0xd2ccbe));
  // Foot: 4 cm wider all round, 12 cm tall (cast plinth), and two drainage notches (dark) through it.
  parts.push(part(uv3(new THREE.BoxGeometry(W + 0.06, 0.12, D + 0.06)), mat(0, 0.06, 0), 0xc4bdae));
  for (const sx of [-1, 1]) parts.push(part(new THREE.BoxGeometry(0.22, 0.07, D + 0.065), mat(sx * W * 0.28, 0.035, 0), 0x2a2724));
  // Form-joint groove two thirds up, both faces (a hairline step of darker concrete).
  for (const sz of [-1, 1]) parts.push(part(new THREE.BoxGeometry(W - 2 * ch, 0.018, 0.004), mat(0, H * 0.64, sz * (hd + 0.002)), 0x8f897d));
  // Lifting-anchor recesses on top (dark pockets) with a steel eye in each.
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.CylinderGeometry(0.06, 0.06, 0.006, 10), mat(sx * W * 0.3, H + 0.002, 0), 0x2c2a27));
    parts.push(part(new THREE.TorusGeometry(0.035, 0.009, 5, 10), mat(sx * W * 0.3, H + 0.02, 0, 0, Math.PI / 2, 0), 0x5b5750));
  }
  const g = merge(parts);
  // Splash grime: darker near the ground, fading out by ~0.6 m.
  const p = g.getAttribute('position') as THREE.BufferAttribute, c = g.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = 0.74 + 0.26 * Math.min(1, Math.max(0, p.getY(i) / 0.6));
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  g.computeBoundingSphere();
  return g;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);
const _y = new THREE.Vector3(0, 1, 0);

export class BarrierLayer {
  readonly root = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  /** Invisible exact-size boxes (camera / aim blockers), one per slab: handed out once the slabs are down. */
  readonly proxies: THREE.Mesh[] = [];
  private readonly boxes: Box[];
  /** Where each bunker's slam is heard: the middle of its slabs. */
  private readonly slams: { x: number; y: number; z: number }[];
  private dropAt: number | null = null;
  private animating = false;
  /** Slabs whose landing (thud + dust) has been played. */
  private landed = false;

  constructor(map: MapDef) {
    const per = map.islands.map((isl) => bunkerBarrierBoxes(isl.bunker));
    this.boxes = per.flat();
    this.slams = per.filter((bs) => bs.length).map((bs) => ({
      x: bs.reduce((a, b) => a + b.center.x, 0) / bs.length, y: bs[0].center.y - bs[0].half.y + 0.6, z: bs.reduce((a, b) => a + b.center.z, 0) / bs.length,
    }));
    this.mesh = new THREE.InstancedMesh(slabGeometry(), mats().concrete, Math.max(1, this.boxes.length));
    this.mesh.name = 'barriers';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // spread over the whole map
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.root.name = 'barriers';
    this.root.add(this.mesh);
    const hull = new THREE.MeshBasicNodeMaterial();
    for (const b of this.boxes) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.half.x * 2, b.half.y * 2, b.half.z * 2), hull);
      m.name = 'proxy:barrier';
      m.visible = false;
      m.position.set(b.center.x, b.center.y, b.center.z);
      m.rotation.y = b.rotY;
      m.updateMatrixWorld(true);
      this.proxies.push(m);
    }
  }

  /** The slabs' boxes (sim frame), e.g. for impact surfaces. */
  get list(): readonly Box[] { return this.boxes; }

  /** Snapshot `barrierAt` (absent before sudden death). True the once they first appear. */
  sync(barrierAt: number | undefined, simT: number): boolean {
    if (barrierAt === undefined || this.dropAt !== null) return false;
    this.dropAt = barrierAt;
    this.animating = true;
    // Joined (or scrubbed) long after the drop: no landing fx.
    this.landed = simT - barrierAt > LATE_SEC;
    this.mesh.count = this.boxes.length;
    console.info(`[barriers] ${this.boxes.length} doorway barriers dropped at ${barrierAt.toFixed(2)} s${this.landed ? ' (joined late: shown at rest)' : ''}`);
    return true;
  }

  /** Per frame, at the sim time the world is shown at. */
  frame(simT: number, particles: Particles): void {
    if (!this.animating || this.dropAt === null) return;
    const dt = simT - this.dropAt;
    const [y, out] = barrierOffset(dt);
    this.boxes.forEach((b, i) => {
      _q.setFromAxisAngle(_y, b.rotY);
      // Box local -Z is out through the doorway.
      _p.set(0, 0, out).applyQuaternion(_q).negate();
      _p.x += b.center.x; _p.z += b.center.z;
      _p.y = b.center.y - b.half.y + y;
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!this.landed && dt >= FALL_SEC) {
      this.landed = true;
      this.land(particles);
    }
    if (dt >= BARRIER_ANIM_SEC) this.animating = false;
  }

  /** Dust and concrete chips where each slab hit the ground, and one positional slam per bunker (its slabs land together). */
  private land(particles: Particles) {
    const dust = particles.dust;
    for (const b of this.boxes) {
      const c = Math.cos(b.rotY), s = Math.sin(b.rotY);
      // Where the slab landed (OUT along forward = (-sin, -cos) from rest), at the ground; along = right = (cos, -sin).
      const x0 = b.center.x - s * OUT, z0 = b.center.z - c * OUT, gy = b.center.y - b.half.y;
      for (let k = 0; k < 10; k++) {
        const along = (k / 9 - 0.5) * BARRIER.width, side = k % 2 ? 1 : -1, v = 0.8 + Math.random() * 1.4;
        // Squeezed out from under the foot on both faces: low, spreading, slowly rising and growing.
        dust.spawn(x0 + c * along, gy + 0.08, z0 - s * along, -s * side * v + (Math.random() - 0.5) * 0.4, 0.35 + Math.random() * 0.5, -c * side * v + (Math.random() - 0.5) * 0.4,
          1.1 + Math.random() * 0.9, 0.35, 1.3 + Math.random() * 0.6, 0.62, 0.58, 0.52, 0.55, -0.15, 2.2);
      }
      for (let k = 0; k < 3; k++) {
        const along = (Math.random() - 0.5) * BARRIER.width;
        particles.debris.spawn(x0 + c * along, gy + 0.1, z0 - s * along, (Math.random() - 0.5) * 2.5, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 2.5,
          0.03 + Math.random() * 0.04, 0.015, 0.03, 0x9a958b, 1.2 + Math.random(), gy - 0.02);
      }
    }
    for (const at of this.slams) playSfx('barrierSlam', at, { gain: 1.4 });
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    for (const p of this.proxies) p.geometry.dispose();
    (this.proxies[0]?.material as THREE.Material | undefined)?.dispose();
    this.root.removeFromParent();
  }
}

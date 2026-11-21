import * as THREE from 'three/webgpu';
import { attribute, float, mix, smoothstep, texture, uniform, uv, vec3 } from 'three/tsl';
import type { SurfaceMap, WorldSurface } from './surfaces';
import { wetness } from './wetness';

/** Prints kept at once (ring: the oldest is reused); 8 players × ~20 steps. */
export const FOOTPRINT_CAP = 160;
/** m between prints (one foot each; a walking/running stride is ~1.4 m) */
export const STEP_M = 0.72;
const FOOT_SIDE = 0.11; // m from the path centre line
const TELEPORT_M = 3; // a jump this big in one frame is a respawn / teleport, not a step
const ON_GROUND = 0.12; // feet within this of the island top (built floors, jumps: no prints)

export type Print = { x: number; z: number; yaw: number; side: 1 | -1 };

/** Per-walker step counter: emits a print every STEP_M travelled, alternating feet. Pure, no three.js. */
export class FootTrail {
  private s = new Map<number, { x: number; z: number; acc: number; side: 1 | -1 }>();

  step(id: number, x: number, z: number): Print | null {
    const t = this.s.get(id);
    if (!t) { this.s.set(id, { x, z, acc: 0, side: 1 }); return null; }
    const dx = x - t.x, dz = z - t.z, d = Math.hypot(dx, dz);
    t.x = x; t.z = z;
    if (d > TELEPORT_M) { t.acc = 0; return null; }
    if (d < 1e-4) return null;
    t.acc += d;
    if (t.acc < STEP_M) return null;
    t.acc %= STEP_M;
    t.side = t.side === 1 ? -1 : 1;
    const ux = dx / d, uz = dz / d;
    // side 1 = right of the direction of travel: (−uz, ux) in the xz plane
    return { x: x - uz * FOOT_SIDE * t.side, z: z + ux * FOOT_SIDE * t.side, yaw: Math.atan2(ux, uz), side: t.side };
  }

  forget(id: number) { this.s.delete(id); }
}

/** How a surface takes a print: strength 0..1 (0 = none) and how long it lasts (s), at ground wetness `wet`. */
export function printOn(surface: WorldSurface, wet: number): { strength: number; life: number } | null {
  switch (surface) {
    case 'sand': return { strength: Math.min(1, 0.5 * (1 + 0.6 * wet)), life: 45 }; // wet sand holds a sharper print
    case 'gravel': return { strength: 0.28 + 0.15 * wet, life: 20 };
    case 'concrete': case 'quay': case 'asphalt': case 'wood':
      return wet > 0.2 ? { strength: 0.42 * wet, life: 9 } : null; // wet boot soles on the docks, drying fast
    default: return null;
  }
}

let maskTex: THREE.CanvasTexture | null = null;
/** Boot sole alpha: toe pad + heel with tread bars (drawn once). Toe at uv v = 1. */
function printMask(): THREE.CanvasTexture {
  if (maskTex) return maskTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  if (!g) throw new Error('[world/footprints] 2D canvas context unavailable');
  g.fillStyle = '#fff';
  g.filter = 'blur(2px)';
  g.beginPath(); g.ellipse(32, 40, 24, 36, 0, 0, Math.PI * 2); g.fill(); // ball + toe
  g.beginPath(); g.ellipse(32, 100, 19, 22, 0, 0, Math.PI * 2); g.fill(); // heel
  g.filter = 'none';
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,0.45)';
  for (let y = 12; y < 124; y += 11) if (y < 74 || y > 82) g.fillRect(6, y, 52, 4); // tread
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  maskTex = t;
  return t;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);

/**
 * Footprints players leave on sand and gravel (and on the docks when they're wet): one InstancedMesh of quads (one
 * draw), a ring of FOOTPRINT_CAP. Each print stores when it was made, its life and strength; the shader fades it
 * from the clock uniform, so nothing is touched per frame except the one new print per step.
 */
export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private attr: THREE.InstancedBufferAttribute;
  private trail = new FootTrail();
  private next = 0;
  private high = 0;
  private readonly t0 = performance.now();
  private readonly clock = uniform(0);
  surfaces: SurfaceMap | null = null;

  constructor() {
    const geo = new THREE.PlaneGeometry(0.12, 0.29).rotateX(-Math.PI / 2).rotateY(Math.PI); // toe (v = 1) toward +z
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(FOOTPRINT_CAP * 3), 3); // born s, life s, strength
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('fp', this.attr);
    const mat = new THREE.MeshStandardNodeMaterial({
      transparent: true, depthWrite: false, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    mat.name = 'footprint';
    const fp = attribute('fp', 'vec3');
    const age = this.clock.sub(fp.x);
    const fade = float(1).sub(smoothstep(fp.y.mul(0.4), fp.y, age));
    const a = texture(printMask(), uv()).r;
    // the pressed-in sole is shadowed and damp: darker, and glossier the wetter the ground
    mat.colorNode = vec3(0.06, 0.05, 0.04);
    mat.roughnessNode = mix(float(0.95), float(0.25), wetness);
    mat.opacityNode = a.mul(fp.z).mul(fade);
    this.mesh = new THREE.InstancedMesh(geo, mat, FOOTPRINT_CAP);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'footprints';
  }

  /** A walker's feet this frame (alive, shown): lays a print each step on a surface that takes one. */
  step(id: number, feet: THREE.Vector3) {
    const p = this.trail.step(id, feet.x, feet.z);
    if (!p || !this.surfaces) return;
    const g = this.surfaces.groundAt(p.x, p.z);
    if (!g || Math.abs(feet.y - g.y) > ON_GROUND) return;
    const how = printOn(g.surface, wetness.value as number);
    if (!how) return;
    const i = this.next;
    this.next = (this.next + 1) % FOOTPRINT_CAP;
    this.high = Math.max(this.high, i + 1);
    _q.setFromAxisAngle(_y, p.yaw + (Math.random() - 0.5) * 0.12);
    _m.compose(_p.set(p.x, g.y + 0.004, p.z), _q, _s.set(p.side, 1, 1)); // mirrored for the left foot
    this.mesh.setMatrixAt(i, _m);
    this.attr.setXYZ(i, this.now(), how.life, how.strength);
    this.mesh.count = this.high;
    this.mesh.instanceMatrix.addUpdateRange(i * 16, 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.attr.addUpdateRange(i * 3, 3);
    this.attr.needsUpdate = true;
  }

  forget(id: number) { this.trail.forget(id); }

  /** Per frame: advance the fade clock. */
  update() { this.clock.value = this.now(); }

  /** Drop every print (new map). */
  clear() { this.mesh.count = this.high = this.next = 0; }

  private now() { return (performance.now() - this.t0) / 1000; }
}

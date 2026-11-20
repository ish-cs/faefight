import * as THREE from 'three/webgpu';
import { attribute, float, texture, uv, vec2 } from 'three/tsl';
import { decalAtlas } from './damageTex';

const GLOBAL_CAP = 400;
const PER_PIECE = 20;
const SIZE = [0.13, 0.11, 0.1, 0.16]; // metres, by atlas cell (wood, metal, steel, sand)

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1), _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Bullet holes / impact marks: one InstancedMesh of quads (1 draw call), each owned by a piece. Capped per piece
 * (oldest replaced) and globally (ring eviction); freed when the piece goes away.
 */
export class DecalLayer {
  readonly mesh: THREE.InstancedMesh;
  private cell: THREE.InstancedBufferAttribute;
  private owner = new Int32Array(GLOBAL_CAP).fill(-1);
  private byPiece = new Map<number, number[]>();
  private free: number[] = [];
  private ring = 0;
  private high = 0;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(GLOBAL_CAP), 1);
    this.cell.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('cell', this.cell);
    const mat = new THREE.MeshStandardNodeMaterial({
      transparent: true, depthWrite: false, roughness: 0.65, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    mat.name = 'decal';
    const c = attribute('cell', 'float');
    const off = vec2(c.mod(2), float(1).sub(c.div(2).floor()));
    const t = texture(decalAtlas(), uv().mul(0.5).add(off.mul(0.5)));
    mat.colorNode = t;
    mat.opacityNode = t.a;
    this.mesh = new THREE.InstancedMesh(geo, mat, GLOBAL_CAP);
    for (let i = 0; i < GLOBAL_CAP; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'pieceDecals';
  }

  /** Add a mark on piece `id` at world `point`, facing `normal` (unit). */
  add(id: number, point: THREE.Vector3, normal: THREE.Vector3, cell: number) {
    let list = this.byPiece.get(id);
    if (!list) { list = []; this.byPiece.set(id, list); }
    let slot: number;
    if (list.length >= PER_PIECE) slot = list.shift()!;
    else if (this.free.length) slot = this.free.pop()!;
    else if (this.high < GLOBAL_CAP) slot = this.high++;
    else {
      slot = this.ring;
      this.ring = (this.ring + 1) % GLOBAL_CAP;
      this.detach(slot);
    }
    this.owner[slot] = id;
    list.push(slot);
    _q.setFromUnitVectors(_z, normal);
    _q2.setFromAxisAngle(_z, Math.random() * Math.PI * 2);
    _q.multiply(_q2);
    const s = SIZE[cell] * (0.8 + Math.random() * 0.45);
    _m.compose(_p.copy(point).addScaledVector(normal, 0.006), _q, _s.set(s, s, 1));
    this.mesh.setMatrixAt(slot, _m);
    this.cell.setX(slot, cell);
    this.mesh.count = this.high;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cell.needsUpdate = true;
  }

  private detach(slot: number) {
    const id = this.owner[slot];
    if (id < 0) return;
    const list = this.byPiece.get(id);
    if (list) {
      const i = list.indexOf(slot);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.byPiece.delete(id);
    }
    this.owner[slot] = -1;
  }

  removePiece(id: number) {
    const list = this.byPiece.get(id);
    if (!list) return;
    for (const slot of list) {
      this.owner[slot] = -1;
      this.mesh.setMatrixAt(slot, _zero);
      this.free.push(slot);
    }
    this.byPiece.delete(id);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Drop marks of pieces no longer present. */
  retain(alive: (id: number) => boolean) {
    for (const id of [...this.byPiece.keys()]) if (!alive(id)) this.removePiece(id);
  }

  get active() { let n = 0; for (const l of this.byPiece.values()) n += l.length; return n; }
}

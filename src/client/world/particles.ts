import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, texture, uv, vec4 } from 'three/tsl';
import { puffTex } from './damageTex';

const G = 14; // m/s², a touch heavier than real for snappier debris

/**
 * Camera-facing billboards, CPU-simulated, drawn as ONE instanced Sprite. Live particles are kept packed at the
 * front of the buffers so the draw covers exactly `n` instances. Spawns beyond the cap are dropped.
 */
class SpritePool {
  readonly sprite: THREE.Sprite;
  private n = 0;
  private ps: Float32Array; // x y z size  (GPU)
  private cs: Float32Array; // r g b a     (GPU)
  private psA: THREE.InstancedBufferAttribute;
  private csA: THREE.InstancedBufferAttribute;
  // CPU-only state, 12 floats each: vx vy vz age life size0 size1 alpha0 grav drag r0 pad
  private st: Float32Array;

  constructor(readonly cap: number, additive: boolean, name: string) {
    this.ps = new Float32Array(cap * 4);
    this.cs = new Float32Array(cap * 4);
    this.st = new Float32Array(cap * 12);
    this.psA = new THREE.InstancedBufferAttribute(this.ps, 4).setUsage(THREE.DynamicDrawUsage);
    this.csA = new THREE.InstancedBufferAttribute(this.cs, 4).setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    mat.name = name;
    const p = instancedBufferAttribute(this.psA, 'vec4') as unknown as THREE.Node<'vec4'>;
    const c = instancedBufferAttribute(this.csA, 'vec4') as unknown as THREE.Node<'vec4'>;
    const t = texture(puffTex(), uv());
    mat.positionNode = p.xyz;
    mat.scaleNode = p.w;
    // additive sparks get a hot core (pre-boosted: the renderer tone-maps everything)
    mat.colorNode = additive ? vec4(c.rgb.mul(t.a.mul(2).add(1.2)), 1) : vec4(c.rgb, 1);
    mat.opacityNode = t.a.mul(c.a).mul(additive ? float(1.4) : float(1));
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 3;
    this.sprite.name = name;
    this.sprite.visible = false;
  }

  get live() { return this.n; }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number,
    r: number, g: number, b: number, a: number, grav: number, drag: number) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const o = i * 4, ps = this.ps, cs = this.cs; // (no temp arrays: hundreds of spawns per frame in a firefight)
    ps[o] = x; ps[o + 1] = y; ps[o + 2] = z; ps[o + 3] = size0;
    cs[o] = r; cs[o + 1] = g; cs[o + 2] = b; cs[o + 3] = a;
    const s = i * 12;
    this.st[s] = vx; this.st[s + 1] = vy; this.st[s + 2] = vz; this.st[s + 3] = 0; this.st[s + 4] = life;
    this.st[s + 5] = size0; this.st[s + 6] = size1; this.st[s + 7] = a; this.st[s + 8] = grav; this.st[s + 9] = drag;
  }

  update(dt: number) {
    const { ps, cs, st } = this;
    let i = 0;
    while (i < this.n) {
      const s = i * 12;
      const age = (st[s + 3] += dt);
      const life = st[s + 4];
      if (age >= life) { this.kill(i); continue; }
      const k = age / life;
      const drag = Math.max(0, 1 - st[s + 9] * dt);
      st[s] *= drag; st[s + 2] *= drag;
      st[s + 1] = st[s + 1] * drag - st[s + 8] * dt;
      ps[i * 4] += st[s] * dt; ps[i * 4 + 1] += st[s + 1] * dt; ps[i * 4 + 2] += st[s + 2] * dt;
      ps[i * 4 + 3] = st[s + 5] + (st[s + 6] - st[s + 5]) * Math.sqrt(k);
      cs[i * 4 + 3] = st[s + 7] * (1 - k) * (1 - k * 0.3);
      i++;
    }
    this.sprite.count = this.n;
    this.sprite.visible = this.n > 0;
    if (this.n > 0) {
      this.psA.clearUpdateRanges(); this.psA.addUpdateRange(0, this.n * 4); this.psA.needsUpdate = true;
      this.csA.clearUpdateRanges(); this.csA.addUpdateRange(0, this.n * 4); this.csA.needsUpdate = true;
    }
  }

  private kill(i: number) {
    const last = --this.n;
    if (i !== last) {
      this.ps.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.cs.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.st.copyWithin(i * 12, last * 12, last * 12 + 12);
    }
  }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3(), _c = new THREE.Color();

/** Tumbling solid chunks (planks, bags, panels, splinters): one InstancedMesh of unit boxes, packed like SpritePool. */
class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  // 20 floats: px py pz vx vy vz qx qy qz qw ax ay az spin sx sy sz age life floorY
  private st: Float32Array;
  private col: Float32Array;

  constructor(readonly cap: number) {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.1 });
    mat.name = 'debris';
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, cap);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'debris';
    this.mesh.visible = false;
    this.st = new Float32Array(cap * 20);
    this.col = new Float32Array(cap * 3);
  }

  get live() { return this.n; }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number,
    color: number, life: number, floorY: number, rotY = Math.random() * Math.PI * 2) {
    if (this.n >= this.cap) return;
    const i = this.n++, s = i * 20, st = this.st;
    st[s] = x; st[s + 1] = y; st[s + 2] = z; st[s + 3] = vx; st[s + 4] = vy; st[s + 5] = vz;
    _q.setFromAxisAngle(_ax.set(0, 1, 0), rotY);
    st[s + 6] = _q.x; st[s + 7] = _q.y; st[s + 8] = _q.z; st[s + 9] = _q.w;
    _ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    st[s + 10] = _ax.x; st[s + 11] = _ax.y; st[s + 12] = _ax.z; st[s + 13] = 4 + Math.random() * 10;
    st[s + 14] = sx; st[s + 15] = sy; st[s + 16] = sz; st[s + 17] = 0; st[s + 18] = life; st[s + 19] = floorY;
    _c.setHex(color);
    const tone = 0.85 + Math.random() * 0.25;
    this.col[i * 3] = _c.r * tone; this.col[i * 3 + 1] = _c.g * tone; this.col[i * 3 + 2] = _c.b * tone;
  }

  update(dt: number) {
    const st = this.st;
    let i = 0;
    while (i < this.n) {
      const s = i * 20;
      const age = (st[s + 17] += dt);
      const life = st[s + 18];
      if (age >= life) { this.kill(i); continue; }
      st[s + 4] -= G * dt;
      st[s] += st[s + 3] * dt; st[s + 1] += st[s + 4] * dt; st[s + 2] += st[s + 5] * dt;
      const floor = st[s + 19] + st[s + 15] * 0.5;
      if (st[s + 1] < floor) {
        st[s + 1] = floor;
        if (st[s + 4] < -1.5) st[s + 4] *= -0.28; else st[s + 4] = 0;
        st[s + 3] *= 0.55; st[s + 5] *= 0.55; st[s + 13] *= 0.5;
      }
      _q.set(st[s + 6], st[s + 7], st[s + 8], st[s + 9]);
      _q2.setFromAxisAngle(_ax.set(st[s + 10], st[s + 11], st[s + 12]), st[s + 13] * dt);
      _q.premultiply(_q2);
      st[s + 6] = _q.x; st[s + 7] = _q.y; st[s + 8] = _q.z; st[s + 9] = _q.w;
      const fade = Math.min(1, (life - age) / 0.6); // shrink away over the last 0.6 s
      _m.compose(_p.set(st[s], st[s + 1], st[s + 2]), _q, _s.set(st[s + 14] * fade, st[s + 15] * fade, st[s + 16] * fade));
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.setRGB(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]));
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      // Upload only the live instances, not the whole pool.
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, this.n * 16); im.needsUpdate = true;
      const ic = this.mesh.instanceColor;
      if (ic) { ic.clearUpdateRanges(); ic.addUpdateRange(0, this.n * 3); ic.needsUpdate = true; }
    }
  }

  private kill(i: number) {
    const last = --this.n;
    if (i !== last) {
      this.st.copyWithin(i * 20, last * 20, last * 20 + 20);
      this.col.copyWithin(i * 3, last * 3, last * 3 + 3);
    }
  }
}

/** Budgets: hard caps keep a multi-piece collapse from flooding the GPU or the frame. */
export const PARTICLE_CAPS = { dust: 1400, sparks: 800, debris: 420 };

/** Impact + destruction particles: 3 draw calls total (dust, sparks, debris). */
export class Particles {
  readonly root = new THREE.Group();
  readonly dust = new SpritePool(PARTICLE_CAPS.dust, false, 'fx:dust');
  readonly sparks = new SpritePool(PARTICLE_CAPS.sparks, true, 'fx:sparks');
  readonly debris = new DebrisPool(PARTICLE_CAPS.debris);

  constructor() {
    this.root.name = 'pieceParticles';
    this.root.add(this.dust.sprite, this.sparks.sprite, this.debris.mesh);
  }

  update(dt: number) {
    this.dust.update(dt);
    this.sparks.update(dt);
    this.debris.update(dt);
  }

  get live() { return this.dust.live + this.sparks.live + this.debris.live; }
}

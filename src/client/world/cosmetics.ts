import * as THREE from 'three/webgpu';
import { COSMETIC, type CosmeticDef, type CosmeticKind } from '../../sim/map';
import { brokenDiff } from './cosmeticDiff';
import { StaticBatch } from './geo';
import { barrelModel, bollardModel, crateModel, fenceModel, lampModel, palmModel } from './mapProps';
import type { Particles } from './particles';

const MODELS: Record<CosmeticKind, { build: (b: StaticBatch) => void; cast: boolean }> = {
  barrel: { build: barrelModel, cast: true },
  crate: { build: crateModel, cast: true },
  fence: { build: fenceModel, cast: false },
  palm: { build: palmModel, cast: true },
  lamp: { build: lampModel, cast: true },
  bollard: { build: bollardModel, cast: false },
};
const BARREL_COLORS = [0x1f5fa8, 0xb23a26, 0x46505a, 0x2f6b3a];
/** Per-instance tint so a row of drums / crates doesn't look cloned. */
const tint = (d: CosmeticDef, c: THREE.Color) => {
  if (d.kind === 'barrel') return c.setHex(BARREL_COLORS[d.id % BARREL_COLORS.length]);
  if (d.kind === 'crate') return c.setScalar(0.82 + ((d.id * 37) % 7) * 0.04);
  return c.setScalar(1);
};

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();

/**
 * Breakable decoration: one InstancedMesh per (kind, material) — ~10 draw calls for every cosmetic on the
 * map. A broken one is hidden by zero-scaling its instance. Never a camera/aim collidable.
 */
export class CosmeticLayer {
  readonly root = new THREE.Group();
  private byId = new Map<number, { def: CosmeticDef; meshes: THREE.InstancedMesh[]; index: number; matrix: THREE.Matrix4 }>();
  private hidden = new Set<number>();

  constructor(defs: CosmeticDef[]) {
    this.root.name = 'cosmetics';
    const kinds = new Map<CosmeticKind, CosmeticDef[]>();
    for (const d of defs) {
      if (!MODELS[d.kind]) { console.warn(`[world/cosmetics] unknown cosmetic kind ${String(d.kind)} (id ${d.id})`); continue; }
      let list = kinds.get(d.kind);
      if (!list) kinds.set(d.kind, (list = []));
      list.push(d);
    }
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    for (const [kind, list] of kinds) {
      const b = new StaticBatch();
      MODELS[kind].build(b);
      const meshes = b.take().map(({ material, geometry, receive }) => {
        const m = new THREE.InstancedMesh(geometry, material, list.length);
        m.name = `cosmetic:${kind}:${material.name}`;
        m.castShadow = MODELS[kind].cast; m.receiveShadow = receive;
        return m;
      });
      list.forEach((d, i) => {
        const matrix = new THREE.Matrix4().compose(p.set(d.pos.x, d.pos.y, d.pos.z), q.setFromAxisAngle(up, d.rotY), one);
        tint(d, c);
        for (const m of meshes) { m.setMatrixAt(i, matrix); m.setColorAt(i, c); }
        this.byId.set(d.id, { def: d, meshes, index: i, matrix });
      });
      for (const m of meshes) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
        this.root.add(m);
      }
    }
  }

  /** Snapshot state: hide every id in `broken`. Cheap when nothing changed (length compare). */
  sync(broken: readonly number[]) {
    const { hide, reset } = brokenDiff(this.hidden, broken);
    if (reset) {
      for (const id of this.hidden) this.setVisible(id, true);
      this.hidden.clear();
    }
    for (const id of hide) this.setVisible(id, false);
  }

  private setVisible(id: number, visible: boolean) {
    const s = this.byId.get(id);
    if (!s) return; // unknown id (e.g. a stale snapshot from another map): nothing to hide
    if (visible) this.hidden.delete(id); else this.hidden.add(id);
    for (const m of s.meshes) { m.setMatrixAt(s.index, visible ? s.matrix : ZERO); m.instanceMatrix.needsUpdate = true; }
  }

  /** `cosmeticBroken` event: hide it now (don't wait for the snapshot) and throw debris. */
  onBroken(data: Record<string, unknown>, particles: Particles) {
    const id = data.id as number;
    const s = this.byId.get(id);
    const d = s?.def;
    const kind = (d?.kind ?? data.kind) as CosmeticKind;
    const pos = d?.pos ?? (data.pos as CosmeticDef['pos'] | undefined);
    if (!pos || !COSMETIC[kind]) { console.warn('[world/cosmetics] cosmeticBroken without a known id/pos', data); return; }
    if (s && !this.hidden.has(id)) this.setVisible(id, false);
    const rotY = d?.rotY ?? (data.rotY as number) ?? 0;
    burst(kind, pos, rotY, d ? tint(d, new THREE.Color()).getHex() : 0x888888, particles);
  }

  dispose() {
    for (const s of new Set([...this.byId.values()].flatMap((v) => v.meshes))) { s.geometry.dispose(); s.dispose(); }
    this.root.removeFromParent();
  }
}

/** Debris chunk palette per kind: [sx, sy, sz, colour] (0 = the instance tint). */
const CHUNKS: Record<CosmeticKind, [number, number, number, number][]> = {
  barrel: [[0.32, 0.3, 0.02, 0], [0.22, 0.25, 0.02, 0], [0.3, 0.02, 0.3, 0x555555]],
  crate: [[0.7, 0.08, 0.03, 0xb08a5a], [0.45, 0.07, 0.03, 0x8f6e47], [0.15, 0.04, 0.03, 0xd9b27a]],
  fence: [[1.0, 0.035, 0.035, 0xa4abb0], [0.5, 0.4, 0.01, 0xc0c6ca], [0.22, 0.12, 0.25, 0x8d8a82]],
  palm: [[0.9, 0.02, 0.3, 0x5f8a2c], [0.6, 0.02, 0.25, 0x77a03a], [0.35, 0.3, 0.3, 0x7a6248], [0.16, 0.16, 0.16, 0x4b3a1f]],
  lamp: [[0.9, 0.1, 0.1, 0x3c4a52], [0.4, 0.08, 0.08, 0x3c4a52], [0.12, 0.02, 0.1, 0xfff0c8]],
  bollard: [[0.2, 0.15, 0.2, 0x2a2c2e], [0.12, 0.1, 0.12, 0x222426]],
};
const SPARKY: Partial<Record<CosmeticKind, true>> = { barrel: true, lamp: true, bollard: true, fence: true };

function burst(kind: CosmeticKind, pos: { x: number; y: number; z: number }, rotY: number, own: number, particles: Particles) {
  const { r, h } = COSMETIC[kind];
  const { debris, dust, sparks } = particles;
  const tall = kind === 'palm' || kind === 'lamp';
  const n = tall ? 22 : kind === 'bollard' ? 8 : 14;
  const pal = CHUNKS[kind];
  for (let i = 0; i < n; i++) {
    const [sx, sy, sz, col] = pal[i % pal.length];
    // tall props shed pieces along their height, with the canopy/head on top
    const y = pos.y + (tall ? (i % 3 === 0 ? h * rr(0.85, 1) : h * rr(0.05, 0.8)) : rr(0.1, h));
    const a = R() * Math.PI * 2, out = rr(1, 3.2);
    const lx = Math.cos(a) * r * 0.6, lz = Math.sin(a) * r * 0.6;
    debris.spawn(pos.x + lx, y, pos.z + lz, Math.cos(a) * out, rr(1.5, 4.5), Math.sin(a) * out, sx, sy, sz, col || own, rr(1.8, 2.8), pos.y, rotY + rr(-0.5, 0.5));
  }
  for (let i = 0; i < (tall ? 10 : 6); i++) {
    const a = R() * Math.PI * 2, s = rr(0.5, 1.8);
    dust.spawn(pos.x + rr(-0.3, 0.3), pos.y + rr(0.1, Math.min(h, 1.2)), pos.z + rr(-0.3, 0.3), Math.cos(a) * s, rr(0.3, 1.2), Math.sin(a) * s,
      rr(1.0, 1.8), rr(0.3, 0.5), rr(1.0, 1.6), 0.6, 0.56, 0.5, 0.55, -0.25, 1.4);
  }
  if (SPARKY[kind]) {
    for (let i = 0; i < 12; i++) {
      const a = R() * Math.PI * 2, s = rr(2, 6);
      sparks.spawn(pos.x, pos.y + rr(0.2, Math.min(h, 1)), pos.z, Math.cos(a) * s, rr(1, 4), Math.sin(a) * s, rr(0.25, 0.5), 0.05, 0.01, 1, rr(0.55, 0.8), 0.25, 1, 9, 1);
    }
  }
}

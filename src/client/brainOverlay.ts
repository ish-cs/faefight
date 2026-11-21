import * as THREE from 'three/webgpu';
import { PIECES, PLAYER } from '../sim/constants';
import type { BrainDigest } from '../sim/bots/introspect';

const MAX_PATH = 8, MAX_GHOSTS = 8;
const VIOLET = 0xb48cff, RED = 0xff4d6d, ORANGE = 0xff9a3c, TEAL = 0x5ee0d0;

const basic = (color: number, opacity = 1) => {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  return m;
};
const lineMat = (color: number, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });

/**
 * In-world view of the spectated bot's brain: its route (line), aim ray, target ring, ghosts where it last saw
 * enemies, and the piece it means to build. A handful of lines and meshes, only for that one bot.
 */
export class BrainOverlay {
  readonly group = new THREE.Group();
  private path: THREE.Line;
  private pathPos = new Float32Array(MAX_PATH * 3);
  private ray: THREE.Line;
  private rayPos = new Float32Array(6);
  private ring: THREE.Mesh;
  private ghosts: THREE.Mesh[] = [];
  private build: THREE.Mesh;
  private buildKind: string | null = null;

  constructor(scene: THREE.Scene) {
    this.group.name = 'brain-overlay';
    this.group.renderOrder = 999;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pathPos, 3));
    this.path = new THREE.Line(pg, lineMat(VIOLET, 0.95));
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rayPos, 3));
    this.ray = new THREE.Line(rg, lineMat(RED, 0.9));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 32).rotateX(-Math.PI / 2), basic(ORANGE, 0.9));
    const gg = new THREE.OctahedronGeometry(0.35);
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const g = new THREE.Mesh(gg, basic(RED, 0.5));
      this.ghosts.push(g);
      this.group.add(g);
    }
    this.build = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: TEAL, wireframe: true, transparent: true, opacity: 0.85, depthTest: false }));
    for (const o of [this.path, this.ray, this.ring, this.build]) { o.frustumCulled = false; o.renderOrder = 999; this.group.add(o); }
    for (const g of this.ghosts) { g.frustumCulled = false; g.renderOrder = 999; }
    this.group.visible = false;
    scene.add(this.group);
  }

  /** `feet`: the bot's rendered position; `posOf`: a live player's rendered position (targets in sight). */
  update(d: BrainDigest | null, feet: THREE.Vector3 | null, posOf: (id: number) => THREE.Vector3 | null, t: number) {
    this.group.visible = !!d && !!feet;
    if (!d || !feet) return;
    // Route: from where it stands now along its planned points.
    const pts = d.path.slice(0, MAX_PATH);
    pts[0] = [feet.x, feet.y, feet.z];
    for (let i = 0; i < pts.length; i++) this.pathPos.set([pts[i][0], pts[i][1] + 0.15, pts[i][2]], i * 3);
    this.path.geometry.setDrawRange(0, pts.length >= 2 ? pts.length : 0);
    this.path.geometry.attributes.position.needsUpdate = true;

    this.ray.visible = !!d.aim;
    if (d.aim) {
      this.rayPos.set([feet.x, feet.y + PLAYER.eyeHeight, feet.z, d.aim[0], d.aim[1], d.aim[2]]);
      this.ray.geometry.attributes.position.needsUpdate = true;
      (this.ray.material as THREE.LineBasicMaterial).opacity = d.fire ? 1 : 0.55;
    }

    const tp = d.target ? posOf(d.target.id) : null;
    this.ring.visible = !!tp;
    if (tp) { this.ring.position.set(tp.x, tp.y + 0.05, tp.z); this.ring.scale.setScalar(1 + 0.12 * Math.sin(t * 5)); }

    // Ghosts: where it last saw enemies it can't see now, fading with age.
    const old = d.seen.filter((s) => s[1] > 0);
    this.ghosts.forEach((g, i) => {
      const s = old[i];
      g.visible = !!s;
      if (!s) return;
      g.position.set(s[2], s[3] + 1.1 + 0.1 * Math.sin(t * 3 + i), s[4]);
      g.rotation.y = t;
      (g.material as THREE.MeshBasicMaterial).opacity = Math.max(0.15, 0.7 - s[1] / 30);
    });

    const b = d.build;
    this.build.visible = !!b;
    if (b) {
      const s = PIECES[b.kind];
      if (this.buildKind !== b.kind) { this.buildKind = b.kind; this.build.scale.set(s.w, s.h, s.d); }
      this.build.position.set(b.x, b.y + s.h / 2, b.z);
      this.build.rotation.y = b.rotY;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
  }
}

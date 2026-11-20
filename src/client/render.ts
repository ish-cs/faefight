import * as THREE from 'three/webgpu';
import { PLAYER } from '../sim/constants';
import type { IslandLayout } from '../sim/map';
import type { MatchEvent, PieceKind, PlayerState, Snapshot, Vec3 } from '../sim/types';
import { pieceGeometry, World } from './world';

export { pieceGeometry };
export const ISLAND_COLORS = [0xe0533d, 0x3d84e0, 0x3dbb6a, 0xe0b23d, 0xa65de0, 0x3dd0d0, 0xe07a3d, 0xd6d6d6];
export const ISLAND_NAMES = ['Red', 'Blue', 'Green', 'Gold', 'Purple', 'Teal', 'Orange', 'White'];

const TICK_MS = 1000 / 30;
/** WebGPURenderer tone-maps everything on output (per-material toneMapped is ignored), so unlit
 *  overlay-ish things (labels, ghost, tracers) get their colour pre-boosted to read at full brightness. */
const UNLIT_BOOST = 2.6;
const boosted = (hex: number) => new THREE.Color(hex).multiplyScalar(UNLIT_BOOST);

type PlayerView = { group: THREE.Group; body: THREE.Mesh };
type Fx = { mesh: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; born: number; life: number; grow?: number };

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 3000);
  /** Static + piece meshes the camera must not pass through and the aim ray can hit. */
  readonly collidables: THREE.Object3D[] = [];
  readonly gpu: THREE.WebGPURenderer;
  /** Sky/lighting/post, islands, ocean, building pieces (src/client/world). */
  world!: World;
  private waterY = 0;
  private map: IslandLayout[] = [];
  private humanId = 0;
  private prev: Snapshot | null = null;
  private curr: Snapshot | null = null;
  private currAt = 0;
  private interpMs = TICK_MS;
  private players = new Map<number, PlayerView>();
  private loot = new Map<number, THREE.Mesh>();
  private pieceGeo = new Map<PieceKind, THREE.BufferGeometry>();
  private fx: Fx[] = [];
  private ghost: THREE.Mesh | null = null;
  private ghostKind: PieceKind | null = null;
  private ghostMat = new THREE.MeshBasicNodeMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.6, depthWrite: false });
  private tracerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  private boomGeo = new THREE.SphereGeometry(1, 20, 12);
  private lootGeo = new THREE.SphereGeometry(0.28, 16, 10).scale(1, 0.8, 1);
  private lootMat = new THREE.MeshStandardNodeMaterial({ color: 0x8b5a2b, roughness: 0.9 });

  private constructor(canvas: HTMLCanvasElement) {
    this.gpu = new THREE.WebGPURenderer({ canvas, antialias: true });
  }

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    const r = new Renderer(canvas);
    await r.gpu.init();
    r.world = new World(r.gpu, r.scene, r.camera, r.collidables); // tone mapping, pixel ratio, shadows, sky
    r.resize();
    return r;
  }

  get backend(): string {
    return (this.gpu.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  resize() {
    const c = this.gpu.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.gpu.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setMap(map: IslandLayout[], humanId: number) {
    this.map = map;
    this.humanId = humanId;
    this.world.setMap(map, ISLAND_COLORS);
  }

  /**
   * Feed a new snapshot. Returns its events for the HUD. intervalMs = how long to interpolate from the
   * previous snapshot to this one (one tick locally; the snapshot spacing for remote clients).
   */
  pushSnapshot(snap: Snapshot, intervalMs = TICK_MS): MatchEvent[] {
    this.prev = this.curr ?? snap;
    this.curr = snap;
    this.currAt = performance.now();
    this.interpMs = Math.max(1, intervalMs);
    this.waterY = snap.waterY;
    this.world.syncPieces(snap.pieces);
    this.syncLoot(snap);
    for (const e of snap.events) this.onEvent(e);
    return snap.events;
  }

  private onEvent(e: MatchEvent) {
    if (e.type === 'shot') {
      const from = e.data.from as Vec3 | undefined, to = e.data.to as Vec3 | undefined;
      if (from && to) this.addTracer(from, to, e.data.by === this.humanId);
    } else if (e.type === 'explosion') {
      const pos = e.data.pos as Vec3 | undefined;
      if (pos) this.addBoom(pos, e.data.kind === 'charge' ? 2 : 4);
    }
  }

  private addTracer(from: Vec3, to: Vec3, mine: boolean) {
    const mat = new THREE.MeshBasicNodeMaterial({ color: boosted(mine ? 0xfff2a8 : 0xffb070), transparent: true, opacity: 0.9, depthWrite: false });
    const m = new THREE.Mesh(this.tracerGeo, mat);
    const a = new THREE.Vector3(from.x, from.y, from.z), b = new THREE.Vector3(to.x, to.y, to.z);
    // Start the visible tracer ahead of the eye (outside the shooter's own head) so it reads as leaving the gun.
    const total = a.distanceTo(b);
    const skip = Math.min(0.8, total * 0.5);
    a.lerp(b, skip / total || 0);
    m.position.copy(a);
    m.lookAt(b);
    m.scale.set(0.04, 0.04, Math.max(0.01, total - skip));
    this.scene.add(m);
    this.fx.push({ mesh: m, mat, born: performance.now(), life: 140 });
  }

  private addBoom(pos: Vec3, radius: number) {
    const mat = new THREE.MeshBasicNodeMaterial({ color: boosted(0xffa040), transparent: true, opacity: 0.85, depthWrite: false });
    const m = new THREE.Mesh(this.boomGeo, mat);
    m.position.set(pos.x, pos.y, pos.z);
    m.scale.setScalar(0.2);
    this.scene.add(m);
    this.fx.push({ mesh: m, mat, born: performance.now(), life: 450, grow: radius });
  }

  geometryFor(kind: PieceKind) {
    let g = this.pieceGeo.get(kind);
    if (!g) { g = pieceGeometry(kind); this.pieceGeo.set(kind, g); }
    return g;
  }

  private syncLoot(snap: Snapshot) {
    const seen = new Set<number>();
    for (const l of snap.loot) {
      seen.add(l.id);
      let m = this.loot.get(l.id);
      if (!m) {
        m = new THREE.Mesh(this.lootGeo, this.lootMat);
        m.castShadow = true;
        this.scene.add(m);
        this.loot.set(l.id, m);
      }
      m.position.set(l.pos.x, l.pos.y + 0.3, l.pos.z);
    }
    for (const [id, m] of this.loot) if (!seen.has(id)) { this.scene.remove(m); this.loot.delete(id); }
  }

  private playerView(p: PlayerState): PlayerView {
    let v = this.players.get(p.id);
    if (v) return v;
    const group = new THREE.Group();
    const r = PLAYER.radius;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(r, PLAYER.height - 2 * r, 8, 20),
      new THREE.MeshStandardNodeMaterial({ color: ISLAND_COLORS[p.island % 8], roughness: 0.55 }));
    body.position.y = PLAYER.height / 2;
    body.castShadow = true;
    group.add(body);
    // Facing indicator: dark visor toward local -Z (yaw 0 looks toward -Z) plus a gun stub on the right.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.12), new THREE.MeshStandardNodeMaterial({ color: 0x15181c, roughness: 0.2, metalness: 0.4 }));
    visor.position.set(0, PLAYER.eyeHeight, -r + 0.02);
    group.add(visor);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.45), new THREE.MeshStandardNodeMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.6 }));
    gun.position.set(r + 0.02, 1.2, -0.3);
    gun.castShadow = true;
    group.add(gun);
    this.scene.add(group);
    v = { group, body };
    this.players.set(p.id, v);
    return v;
  }

  /** Interpolated feet position for a player (between the last two snapshots). */
  playerPos(id: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    if (!this.curr || !this.prev) return null;
    const c = this.curr.players.find((p) => p.id === id);
    if (!c) return null;
    const a = this.prev.players.find((p) => p.id === id) ?? c;
    const t = this.alpha();
    const jump = Math.hypot(c.pos.x - a.pos.x, c.pos.y - a.pos.y, c.pos.z - a.pos.z) > 3; // teleport / respawn
    if (jump) return out.set(c.pos.x, c.pos.y, c.pos.z);
    return out.set(a.pos.x + (c.pos.x - a.pos.x) * t, a.pos.y + (c.pos.y - a.pos.y) * t, a.pos.z + (c.pos.z - a.pos.z) * t);
  }

  private alpha() {
    return Math.min(1, Math.max(0, (performance.now() - this.currAt) / this.interpMs));
  }

  setGhost(kind: PieceKind | null, pos?: Vec3, rotY = 0, ok = false) {
    if (!kind || !pos) { if (this.ghost) this.ghost.visible = false; return; }
    if (!this.ghost) {
      this.ghost = new THREE.Mesh(this.geometryFor(kind), this.ghostMat);
      this.ghost.renderOrder = 10;
      this.scene.add(this.ghost);
    }
    if (this.ghostKind !== kind) { this.ghost.geometry = this.geometryFor(kind); this.ghostKind = kind; }
    this.ghost.visible = true;
    this.ghost.position.set(pos.x, pos.y + 0.01, pos.z);
    this.ghost.rotation.y = rotY;
    this.ghostMat.color.copy(boosted(ok ? 0x3ddc84 : 0xff4d4d));
  }

  /** Meshes the aim ray may hit: world + pieces + other players. */
  aimTargets(): THREE.Object3D[] {
    const out = [...this.collidables];
    for (const [id, v] of this.players) if (id !== this.humanId && v.group.visible) out.push(v.body);
    return out;
  }

  render(localYaw: number) {
    const now = performance.now();
    const snap = this.curr;
    if (snap) {
      const t = this.alpha();
      const tmp = new THREE.Vector3();
      for (const p of snap.players) {
        const v = this.playerView(p);
        v.group.visible = p.alive;
        if (!p.alive) continue;
        this.playerPos(p.id, tmp);
        v.group.position.copy(tmp);
        if (p.id === this.humanId) v.group.rotation.y = localYaw;
        else {
          const a = this.prev?.players.find((q) => q.id === p.id) ?? p;
          let d = p.yaw - a.yaw;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          v.group.rotation.y = a.yaw + d * t;
        }
        // Blink while invulnerable after respawn.
        v.body.visible = !(snap.time < p.invulnUntil && Math.floor(now / 120) % 2 === 0);
      }
      for (const [id, v] of this.players) if (!snap.players.some((p) => p.id === id)) { this.scene.remove(v.group); this.players.delete(id); }
      for (const m of this.loot.values()) m.rotation.y += 0.02;
    }

    for (const f of [...this.fx]) {
      const k = (now - f.born) / f.life;
      if (k >= 1) { this.scene.remove(f.mesh); f.mat.dispose(); this.fx.splice(this.fx.indexOf(f), 1); continue; }
      f.mat.opacity = 0.9 * (1 - k);
      if (f.grow) f.mesh.scale.setScalar(0.2 + (f.grow - 0.2) * Math.sqrt(k));
    }

    this.world.render(this.waterY, this.camera.position); // tide, shadow focus, post chain, draw
  }

  info() {
    const r = this.gpu.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
    return { backend: this.backend, drawCalls: r.drawCalls ?? r.calls ?? 0, triangles: r.triangles };
  }
}

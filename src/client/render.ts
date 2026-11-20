import * as THREE from 'three/webgpu';
import { cos, float, mix, normalize, positionWorld, smoothstep, time, transformNormalToView, uniform, vec3, color, min } from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { PIECES, PLAYER } from '../sim/constants';
import { bunkerWallBoxes, type IslandLayout } from '../sim/map';
import { PROP_HALF } from '../sim/physics';
import type { MatchEvent, PieceKind, PieceState, PlayerState, Snapshot, Vec3 } from '../sim/types';

export const ISLAND_COLORS = [0xe0533d, 0x3d84e0, 0x3dbb6a, 0xe0b23d, 0xa65de0, 0x3dd0d0, 0xe07a3d, 0xd6d6d6];
export const ISLAND_NAMES = ['Red', 'Blue', 'Green', 'Gold', 'Purple', 'Teal', 'Orange', 'White'];

const PIECE_LOOK: Record<PieceKind, { color: number; rough: number; metal: number }> = {
  sandbags: { color: 0xc8b07a, rough: 0.95, metal: 0 },
  wood: { color: 0x9a6a3c, rough: 0.85, metal: 0 },
  metal: { color: 0x9aa3aa, rough: 0.45, metal: 0.7 },
  steel: { color: 0x59626b, rough: 0.35, metal: 0.9 },
  scaffold: { color: 0xd9a531, rough: 0.6, metal: 0.5 },
  ramp: { color: 0xa98352, rough: 0.85, metal: 0 },
  container: { color: 0xc0452d, rough: 0.55, metal: 0.4 },
};

const TICK_MS = 1000 / 30;
/** WebGPURenderer tone-maps everything on output (per-material toneMapped is ignored), so unlit
 *  overlay-ish things (labels, ghost, tracers) get their colour pre-boosted to read at full brightness. */
const UNLIT_BOOST = 2.6;
const boosted = (hex: number) => new THREE.Color(hex).multiplyScalar(UNLIT_BOOST);
const SUN_DIR = new THREE.Vector3(0.45, 0.62, 0.35).normalize();

/** Ramp: 2 wide, rises along local +Z from y=0 at z=-d/2 to y=h at z=+d/2 (matches the physics hull). */
function rampGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const x = w / 2, z = d / 2;
  const P = {
    a: [-x, 0, -z], b: [x, 0, -z], c: [-x, 0, z], e: [x, 0, z], f: [-x, h, z], g: [x, h, z],
  };
  const tris: number[][] = [
    [P.a, P.f, P.g], [P.a, P.g, P.b], // slope
    [P.c, P.e, P.g], [P.c, P.g, P.f], // back wall (+Z)
    [P.a, P.b, P.e], [P.a, P.e, P.c], // bottom
    [P.a, P.c, P.f], // left side
    [P.b, P.g, P.e], // right side
  ].map((t) => t.flat());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

export function pieceGeometry(kind: PieceKind): THREE.BufferGeometry {
  const s = PIECES[kind];
  if (kind === 'ramp') return rampGeometry(s.w, s.h, s.d);
  const g = new THREE.BoxGeometry(s.w, s.h, s.d);
  g.translate(0, s.h / 2, 0); // origin at the piece's base, like PieceState.pos
  return g;
}

function labelSprite(text: string, bg: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(8, 8, 240, 48, 24); g.fill();
  g.fillStyle = '#fff';
  g.font = '600 28px "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
  mat.color.setScalar(UNLIT_BOOST);
  const s = new THREE.Sprite(mat);
  s.scale.set(1.5, 0.375, 1);
  return s;
}

type PlayerView = { group: THREE.Group; body: THREE.Mesh };
type Fx = { mesh: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; born: number; life: number; grow?: number };

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 3000);
  /** Static + piece meshes the camera must not pass through and the aim ray can hit. */
  readonly collidables: THREE.Object3D[] = [];
  readonly gpu: THREE.WebGPURenderer;
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  private water: THREE.Mesh | null = null;
  private waterY = 0;
  private map: IslandLayout[] = [];
  private humanId = 0;
  private prev: Snapshot | null = null;
  private curr: Snapshot | null = null;
  private currAt = 0;
  private interpMs = TICK_MS;
  private players = new Map<number, PlayerView>();
  private pieces = new Map<number, THREE.Mesh>();
  private loot = new Map<number, THREE.Mesh>();
  private pieceGeo = new Map<PieceKind, THREE.BufferGeometry>();
  private pieceMat = new Map<PieceKind, THREE.Material>();
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
    this.gpu.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.gpu.toneMapping = THREE.ACESFilmicToneMapping;
    this.gpu.toneMappingExposure = 0.5;
    this.gpu.shadowMap.enabled = true;
    this.gpu.shadowMap.type = THREE.PCFShadowMap;
  }

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    const r = new Renderer(canvas);
    await r.gpu.init();
    r.buildEnvironment();
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

  private buildEnvironment() {
    const sky = new SkyMesh();
    sky.scale.setScalar(2000);
    sky.turbidity.value = 3;
    sky.rayleigh.value = 1.2;
    sky.mieCoefficient.value = 0.004;
    sky.mieDirectionalG.value = 0.85;
    sky.cloudCoverage.value = 0.35;
    sky.sunPosition.value.copy(SUN_DIR);
    this.scene.add(sky);

    try {
      const envScene = new THREE.Scene();
      const envSky = new SkyMesh();
      envSky.scale.setScalar(2000);
      envSky.sunPosition.value.copy(SUN_DIR);
      envSky.showSunDisc.value = 0;
      envSky.cloudCoverage.value = 0;
      envScene.add(envSky);
      const pmrem = new THREE.PMREMGenerator(this.gpu);
      this.scene.environment = pmrem.fromScene(envScene).texture;
      this.scene.environmentIntensity = 0.35;
    } catch (err) {
      console.warn('[render] sky environment map unavailable, using hemisphere light only', err);
    }

    this.scene.add(new THREE.HemisphereLight(0xd9e9f7, 0xd8c39a, 0.55));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 200;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xcfe6f2, 180, 900);
  }

  setMap(map: IslandLayout[], humanId: number) {
    this.map = map;
    this.humanId = humanId;
    const sand = new THREE.MeshStandardNodeMaterial({ color: 0xf0d8a0, roughness: 0.95 });
    const grass = new THREE.MeshStandardNodeMaterial({ color: 0x7fae4e, roughness: 0.9 });
    const concrete = new THREE.MeshStandardNodeMaterial({ color: 0xb9b6ae, roughness: 0.85 });
    const islandDepth = 14;
    for (const isl of map) {
      const top = new THREE.Mesh(new THREE.CylinderGeometry(isl.radius, isl.radius, islandDepth, 96), sand);
      top.position.set(isl.center.x, isl.groundY - islandDepth / 2, isl.center.z);
      top.receiveShadow = true;
      this.scene.add(top);
      this.collidables.push(top);
      const lawn = new THREE.Mesh(new THREE.CircleGeometry(isl.radius - 5, 64).rotateX(-Math.PI / 2), grass);
      lawn.position.set(isl.center.x, isl.groundY + 0.01, isl.center.z);
      lawn.receiveShadow = true;
      this.scene.add(lawn);

      const b = isl.bunker;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(9, 0.04, 9), concrete);
      pad.position.set(b.center.x, isl.groundY + 0.02, b.center.z);
      pad.rotation.y = b.facingYaw;
      pad.receiveShadow = true;
      this.scene.add(pad);
      const wallMat = new THREE.MeshStandardNodeMaterial({ color: 0xa8a59d, roughness: 0.9 });
      for (const box of bunkerWallBoxes(b)) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(box.half.x * 2, box.half.y * 2, box.half.z * 2), wallMat);
        m.position.set(box.center.x, box.center.y, box.center.z);
        m.rotation.y = box.rotY;
        m.castShadow = m.receiveShadow = true;
        this.scene.add(m);
        this.collidables.push(m);
      }
      const team = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 0.05),
        new THREE.MeshStandardNodeMaterial({ color: ISLAND_COLORS[isl.index % 8], roughness: 0.5 }));
      const fwd = new THREE.Vector3(-Math.sin(b.facingYaw), 0, -Math.cos(b.facingYaw));
      team.position.set(b.center.x, isl.groundY + 2.4, b.center.z).addScaledVector(fwd, 2.33);
      team.rotation.y = b.facingYaw;
      this.scene.add(team);

      this.addProp(isl, 'generator', 0xf2c230, 0.4, 0.3, 'GENERATOR', '#b07d00');
      this.addProp(isl, 'vault', 0x3b4450, 0.3, 0.8, 'VAULT', '#2a3440');
      this.addProp(isl, 'shop', 0x2bb3a3, 0.6, 0, 'SHOP', '#0f8478');
      this.addPalms(isl);
    }

    // Water: shallow turquoise near islands fading to deep blue, cheap animated normals.
    // Opaque on purpose: a transparent water pass blends against the sky behind it and washes out.
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.0 });
    const p = positionWorld.xz;
    // Distance to the nearest island rim (folded into one node over all islands).
    const rimDist = map.map((isl) => p.sub(uniform(new THREE.Vector2(isl.center.x, isl.center.z))).length().sub(isl.radius));
    const near = rimDist.slice(1).reduce((a, b) => min(a, b), rimDist[0]);
    mat.colorNode = mix(color(0x10b8b0), color(0x06427a), smoothstep(float(0), float(14), near));
    const t = time;
    const dx = cos(p.x.mul(0.31).add(t.mul(1.3))).mul(0.10)
      .add(cos(p.x.mul(0.83).add(p.y.mul(0.52)).add(t.mul(2.1))).mul(0.05))
      .add(cos(p.x.mul(2.1).sub(p.y.mul(1.7)).add(t.mul(3.3))).mul(0.025));
    const dz = cos(p.y.mul(0.37).add(t.mul(1.1))).mul(0.10)
      .add(cos(p.y.mul(0.91).sub(p.x.mul(0.44)).add(t.mul(1.8))).mul(0.05))
      .add(cos(p.y.mul(2.3).add(p.x.mul(1.4)).add(t.mul(2.9))).mul(0.025));
    mat.normalNode = transformNormalToView(normalize(vec3(dx, float(1), dz)));
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), mat);
    this.scene.add(this.water);
  }

  private addProp(isl: IslandLayout, key: 'generator' | 'vault' | 'shop', col: number, rough: number, metal: number, label: string, bg: string) {
    const h = PROP_HALF[key];
    const p = isl[key];
    const mat = new THREE.MeshStandardNodeMaterial({ color: col, roughness: rough, metalness: metal });
    const geo = key === 'shop' ? new THREE.CapsuleGeometry(h.x, h.y * 2 - h.x * 2, 8, 16) : new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.x, p.y + h.y, p.z);
    m.rotation.y = isl.bunker.facingYaw;
    m.castShadow = m.receiveShadow = true;
    this.scene.add(m);
    this.collidables.push(m);
    if (key === 'generator') {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(h.x * 2 + 0.02, 0.12, h.z * 2 + 0.02), new THREE.MeshStandardNodeMaterial({ color: 0x222222 }));
      stripe.position.y = 0.25;
      m.add(stripe);
    }
    if (key === 'vault') {
      const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 20).rotateX(Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0xc9a227, metalness: 1, roughness: 0.3 }));
      dial.position.set(0, 0.1, -h.z - 0.02);
      m.add(dial);
    }
    const s = labelSprite(label, bg);
    s.position.set(p.x, p.y + h.y * 2 + 0.55, p.z);
    this.scene.add(s);
  }

  private addPalms(isl: IslandLayout) {
    const trunkMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a6a45, roughness: 0.9 });
    const leafMat = new THREE.MeshStandardNodeMaterial({ color: 0x2f8a3a, roughness: 0.8, side: THREE.DoubleSide });
    const back = isl.bunker.facingYaw + Math.PI;
    for (let i = 0; i < 7; i++) {
      const a = back + 0.9 + i * ((2 * Math.PI - 1.8) / 6);
      const dir = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
      const base = new THREE.Vector3(isl.center.x, isl.groundY, isl.center.z).addScaledVector(dir, isl.radius - 2.2);
      const palm = new THREE.Group();
      const hgt = 5 + (i % 3);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, hgt, 8), trunkMat);
      trunk.position.y = hgt / 2;
      trunk.castShadow = true;
      palm.add(trunk);
      for (let k = 0; k < 6; k++) {
        const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 2.6), leafMat);
        leaf.position.y = hgt;
        leaf.rotation.set(-1.0, (k / 6) * Math.PI * 2, 0, 'YXZ');
        leaf.translateY(1.2);
        leaf.castShadow = true;
        palm.add(leaf);
      }
      palm.position.copy(base);
      palm.rotation.z = 0.12 * (i % 2 ? 1 : -1);
      this.scene.add(palm);
    }
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
    this.syncPieces(snap.pieces);
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

  private materialFor(kind: PieceKind) {
    let m = this.pieceMat.get(kind);
    if (!m) {
      const l = PIECE_LOOK[kind];
      m = new THREE.MeshStandardNodeMaterial({ color: l.color, roughness: l.rough, metalness: l.metal });
      this.pieceMat.set(kind, m);
    }
    return m;
  }

  geometryFor(kind: PieceKind) {
    let g = this.pieceGeo.get(kind);
    if (!g) { g = pieceGeometry(kind); this.pieceGeo.set(kind, g); }
    return g;
  }

  private syncPieces(pieces: PieceState[]) {
    const seen = new Set<number>();
    for (const p of pieces) {
      seen.add(p.id);
      let m = this.pieces.get(p.id);
      if (!m) {
        m = new THREE.Mesh(this.geometryFor(p.kind), this.materialFor(p.kind));
        m.castShadow = m.receiveShadow = true;
        m.userData.pieceId = p.id;
        this.scene.add(m);
        this.pieces.set(p.id, m);
        this.collidables.push(m);
      }
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      m.rotation.y = p.rotY;
    }
    for (const [id, m] of this.pieces) {
      if (seen.has(id)) continue;
      this.scene.remove(m);
      this.pieces.delete(id);
      const i = this.collidables.indexOf(m);
      if (i >= 0) this.collidables.splice(i, 1);
    }
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
    if (this.water) this.water.position.y = this.waterY;

    for (const f of [...this.fx]) {
      const k = (now - f.born) / f.life;
      if (k >= 1) { this.scene.remove(f.mesh); f.mat.dispose(); this.fx.splice(this.fx.indexOf(f), 1); continue; }
      f.mat.opacity = 0.9 * (1 - k);
      if (f.grow) f.mesh.scale.setScalar(0.2 + (f.grow - 0.2) * Math.sqrt(k));
    }

    // Keep the shadow frustum centred on the camera's surroundings.
    const focus = this.camera.position;
    this.sun.target.position.set(focus.x, 0, focus.z);
    this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 100);
    this.gpu.render(this.scene, this.camera);
  }

  info() {
    const r = this.gpu.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
    return { backend: this.backend, drawCalls: r.drawCalls ?? r.calls ?? 0, triangles: r.triangles };
  }
}

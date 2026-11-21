import { CASING_CAP } from './world/casings';
import * as THREE from 'three/webgpu';
import { GENERATOR_MAX_LEVEL, LIFECYCLE, PLAYER, WEAPONS } from '../sim/constants';
import { PROP_HALF } from '../sim/physics';
import type { IslandLayout, MapDef } from '../sim/map';
import type { MatchEvent, PieceKind, PieceState, Snapshot, TrapRequest, Vec3, WeaponKind } from '../sim/types';
import { buildMuzzleFlash, buildWeapon } from './characters/weapons';
import { CharacterSystem, type Motion } from './characters/avatar';
import { NpcSystem } from './characters/npcs';
import { GunFx } from './gunFx';
import { PlayerTrack, RenderClock } from './interp';
import { pieceGeometry, World } from './world';
import { preloadPbr } from './world/pbr';
import { PotionSellers, stall } from './world/potionSeller';
import { loadQuality } from './world/sky';
import { DayNight } from './world/dayNight';
import { StormFx } from './world/storm';
import { TrapLayer } from './world/traps';
import type { WorldSurface } from './world/surfaces';
import { wetness } from './world/wetness';
import { playSfx } from './audio/api';
import type { Surface } from './audio/events';
import { LootView, lootWarmObjects } from './lootView';
export { lods } from './world/lod';
export { pbrStats } from './world/pbr';

export { pieceGeometry };
import { islandColor, setIslandPalette } from './colors';
export { ISLAND_COLORS, ISLAND_NAMES } from './colors';

/** WebGPURenderer tone-maps everything on output (per-material toneMapped is ignored), so unlit
 *  overlay-ish things (labels, ghost, tracers) get their colour pre-boosted to read at full brightness. */
const UNLIT_BOOST = 2.6;
const boosted = (hex: number) => new THREE.Color(hex).multiplyScalar(UNLIT_BOOST);

/** Thud sound per ground surface (audio/events.ts Surface). */
const THUD_SURFACE: Record<WorldSurface, Surface> = {
  concrete: 'concrete', quay: 'concrete', asphalt: 'concrete', metal: 'metal', container: 'metal', wood: 'wood', bark: 'wood',
  sand: 'sand', gravel: 'gravel', grass: 'grass', water: 'water',
};

const GPU_TIMING = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gputime') === '1';

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
  private curr: Snapshot | null = null;
  /** Display-rate playback of other players: adaptive clock + per-player Hermite tracks (interp.ts). */
  private clock = new RenderClock();
  private tracks = new Map<number, PlayerTrack>();
  /** Interpolation clock source (s). Replays swap in their own (paused / 0.25–8×); default wall time. */
  clockNow: () => number = () => performance.now() / 1000;
  private playT: number | null = null;
  /** The local player's predicted render state (predict.ts), when prediction is running. */
  private local: { pos: Vec3; vel: Vec3 } | null = null;
  private motion: Motion = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0 };
  private lastFrame = performance.now();
  /** Animated player avatars (src/client/characters). */
  readonly characters = new CharacterSystem(this.scene, (island) => islandColor(island));
  /** Loot on the ground drawn as its items, with labels nearby (lootView.ts). */
  readonly lootView = new LootView(this.scene);
  private potionSellers = new PotionSellers(this.scene);
  /** Spike traps (world/traps.ts) and their placement ghost. */
  readonly traps = new TrapLayer();
  /** Animated shop keepers (characters/npcs.ts). */
  readonly npcs = new NpcSystem(this.scene);
  private pieceGeo = new Map<PieceKind, THREE.BufferGeometry>();
  private fx: Fx[] = [];
  private ghost: THREE.Mesh | null = null;
  private ghostKind: PieceKind | null = null;
  private ghostMat = new THREE.MeshBasicNodeMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.6, depthWrite: false });
  private ghostLink: THREE.Mesh | null = null;
  private ghostLinkGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  private ghostT = performance.now();
  private ghostPulse = 0;
  private ghostTmp = new THREE.Vector3();
  private ghostTmp2 = new THREE.Vector3();
  private ghostWhite = new THREE.Color(0xffffff);
  /** Own unconfirmed placements (drawn with the real pieces) and refused ones fading out. */
  private predicted: PieceState[] = [];
  private fadeMeshes: THREE.Mesh[] = [];
  private boomGeo = new THREE.SphereGeometry(1, 20, 12);
  /** Level pips above each island's generator (lit = reached), by island. */
  private genPips: THREE.Mesh[][] = [];
  private pipGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);
  private pipOn = new THREE.MeshBasicNodeMaterial({ color: boosted(0xffd23d) });
  private pipOff = new THREE.MeshBasicNodeMaterial({ color: 0x4a525c });

  /** Sudden-death weather: storm wall, rain, telegraph markers, lightning (world/storm.ts). */
  storm!: StormFx;
  /** Day → night over the match, night at sudden death (world/dayNight.ts). */
  dayNight!: DayNight;
  /** Tracers, muzzle light/smoke, shell casings, hit sparks, projectiles, explosion flashes. */
  gunFx!: GunFx;
  private snapArrived = performance.now();
  /** First-person gun points for the local player (set by main); others use their avatar's gun. */
  localGunPoint: ((which: 'muzzle' | 'eject', out: THREE.Vector3) => THREE.Vector3 | null) | null = null;

  private constructor(canvas: HTMLCanvasElement) {
    this.gpu = new THREE.WebGPURenderer({ canvas, antialias: true, trackTimestamp: GPU_TIMING });
  }

  /** ?gputime=1: per-frame GPU render time (ms) from timestamp queries, newest last (debug/perf only). */
  readonly gpuMs: number[] = [];
  gpuStats() {
    const xs = [...this.gpuMs].sort((a, b) => a - b);
    const q = (k: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * k))] ?? 0;
    return { n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / (xs.length || 1), p95: q(0.95) };
  }
  private resolveGpuTime() {
    this.gpu.resolveTimestampsAsync('render').then((ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
      this.gpuMs.push(ms);
      if (this.gpuMs.length > 600) this.gpuMs.shift();
    }, (err) => console.warn('[render] GPU timestamp resolve failed', err));
  }

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    const r = new Renderer(canvas);
    await r.gpu.init();
    await preloadPbr(r.gpu, loadQuality()); // compressed PBR maps in place before any material samples them
    r.characters.camera = r.camera;
    r.world = new World(r.gpu, r.scene, r.camera, r.collidables); // tone mapping, pixel ratio, shadows, sky
    r.gunFx = new GunFx(r.world.pieceFx.particles, (id, which, out) =>
      (id === r.humanId ? r.localGunPoint?.(which, out) ?? null : null) ?? r.characters.gunPoint(id, which, out));
    r.scene.add(r.gunFx.root);
    r.scene.add(r.traps.root);
    r.dayNight = new DayNight(r.world.sky, r.gpu, r.scene);
    r.storm = new StormFx(r.world.sky, r.gpu, r.scene, r.dayNight.base);
    // a body killed in the air ragdolls down onto the island under it, or the sea
    r.characters.floorAt = (x, z) => r.world.impacts.surf?.groundAt(x, z)?.y ?? r.waterY;
    r.characters.onThud = (pos, speed) => {
      const g = r.world.impacts.surf?.groundAt(pos.x, pos.z);
      const ground = !g || pos.y < r.waterY + 0.2 ? 'water' : THUD_SURFACE[g.surface];
      const kind = ground !== 'water' && ground !== 'sand' && ground !== 'grass' && (wetness.value as number) > 0.35 ? 'wet' : ground;
      playSfx('ragdollThud', pos, { kind, gain: Math.min(1, 0.4 + (speed - 1.2) * 0.35) });
    };
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

  /** The local player changed (0 = none: the host handed its player to a bot and spectates). */
  setLocalPlayer(id: number) {
    this.humanId = id;
    this.local = null;
  }

  setMap(def: MapDef, humanId: number) {
    this.map = def.islands;
    this.humanId = humanId;
    setIslandPalette(def.colors);
    this.world.setMap(def, def.islands.map((isl) => islandColor(isl.index)));
    this.npcs.sync(); // keepers registered by the map art (before the loading warm-up compiles the scene)
    const map = def.islands;
    this.storm.setMap(map, def.center);
    this.dayNight.setCycle(def.settings?.suddenDeathSec ?? LIFECYCLE.suddenDeathAt);
    this.gunFx.warmUp([this.boomMat]);
    for (const pips of this.genPips) for (const m of pips) this.scene.remove(m);
    const h = PROP_HALF.generator;
    this.genPips = map.map((isl) => {
      // A row across the line from the island centre, so it faces whoever walks up from home.
      const g = isl.generator, dx = g.x - isl.center.x, dz = g.z - isl.center.z, d = Math.hypot(dx, dz) || 1;
      const ax = -dz / d, az = dx / d;
      return Array.from({ length: GENERATOR_MAX_LEVEL }, (_, i) => {
        const m = new THREE.Mesh(this.pipGeo, i === 0 ? this.pipOn : this.pipOff);
        const off = (i - (GENERATOR_MAX_LEVEL - 1) / 2) * 0.36;
        m.position.set(g.x + ax * off, g.y + h.y * 2 + 0.2, g.z + az * off);
        m.rotation.y = Math.atan2(ax, az);
        m.name = `genPip:${isl.index}:${i + 1}`;
        this.scene.add(m);
        return m;
      });
    });
  }

  /** Every snapshot as soon as it arrives (before any event delay): drives player interpolation. */
  ingest(snap: Snapshot) {
    this.clock.push(snap.time, this.clockNow());
    if (snap.time > this.newestSim) this.newestSim = snap.time;
    for (const p of snap.players) {
      let tr = this.tracks.get(p.id);
      if (!tr) { tr = new PlayerTrack(); this.tracks.set(p.id, tr); }
      tr.push({ t: snap.time, pos: p.pos, yaw: p.yaw, pitch: p.pitch });
    }
  }

  /** Local player's predicted feet/velocity for this frame (null = use the interpolated snapshots). */
  setLocal(state: { pos: Vec3; vel: Vec3 } | null) {
    this.local = state;
  }

  /** Advance the interpolation clock; call once per frame before reading positions. */
  beginFrame() {
    this.playT = this.clock.advance(this.clockNow());
  }

  /** Forget interpolation history (replay seek: sim time jumps, possibly backwards). */
  resetInterp() {
    this.clock = new RenderClock();
    this.tracks.clear();
  }

  /**
   * Sim time of the other players shown this frame (sent with shots: lag compensation). Never past the
   * newest snapshot: beyond it tracks only extrapolate/hold, so the host has nothing truer to rewind to.
   */
  get renderTime(): number | null { return this.playT === null ? null : Math.min(this.playT, this.newestSim); }
  private newestSim = -Infinity;

  /** Debug: current interpolation delay (s) behind the newest snapshot. */
  get interpDelay() { return this.clock.delay; }

  /**
   * Killcam replay: while set, the scene shows `snap` (a past snapshot: its players, pieces and
   * projectiles) with players placed by `motion`, and live snapshots only update the HUD-side state
   * (their pieces/projectiles/effects are applied again when the replay ends).
   */
  private replay: { snap: Snapshot; motion: (id: number, out: Motion) => Motion | null } | null = null;
  private replaySnap: Snapshot | null = null;

  setReplay(r: { snap: Snapshot; motion: (id: number, out: Motion) => Motion | null } | null) {
    if (r) {
      if (r.snap !== this.replaySnap) {
        this.replaySnap = r.snap;
        this.world.syncPieces(r.snap.pieces, r.snap.fires);
        this.gunFx.syncProjectiles(r.snap.projectiles ?? []);
        this.traps.sync(r.snap.traps);
        this.snapArrived = performance.now();
      }
      this.replay = r;
      return;
    }
    if (!this.replay) return;
    this.replay = null;
    this.replaySnap = null;
    const c = this.curr;
    if (c) { this.world.syncPieces(this.predicted.length ? c.pieces.concat(this.predicted) : c.pieces, c.fires); this.gunFx.syncProjectiles(c.projectiles ?? []); this.traps.sync(c.traps); }
  }

  get replaying() { return this.replay !== null; }

  /** Effects of past events during a replay (tracers, muzzle flashes, hit sparks, explosions). */
  replayEvents(events: readonly MatchEvent[]) {
    for (const e of events) if (e.type === 'shot' || e.type === 'hit' || e.type === 'explosion') this.onEvent(e);
  }

  /** Feed a snapshot's discrete state (pieces, loot, events). Returns its events for the HUD. */
  pushSnapshot(snap: Snapshot): MatchEvent[] {
    this.curr = snap;
    this.waterY = snap.waterY;
    if (this.replay) {
      // The replay owns pieces, projectiles and effects until it ends.
      this.syncLoot(snap);
      return snap.events;
    }
    this.world.syncPieces(this.predicted.length ? snap.pieces.concat(this.predicted) : snap.pieces, snap.fires);
    this.world.syncCosmetics(snap.broken ?? []);
    this.world.syncHazards(snap.hz);
    this.traps.sync(snap.traps);
    this.world.syncDocks(snap.docks, snap.dockHurt);
    this.syncLoot(snap);
    this.gunFx.syncProjectiles(snap.projectiles ?? []);
    this.snapArrived = performance.now();
    this.genPips.forEach((pips, island) => {
      const level = snap.genLevels?.[island] ?? 1;
      pips.forEach((m, i) => { m.material = i < level ? this.pipOn : this.pipOff; });
    });
    this.potionSellers.sync(snap.potionShops);
    this.storm.sync(snap.storm, snap.suddenDeath);
    for (const e of snap.events) this.onEvent(e);
    return snap.events;
  }

  /** An event made up on this client (predicted shot): same effects as one from a snapshot. */
  localEvent(e: MatchEvent) {
    this.onEvent(e);
  }

  private onEvent(e: MatchEvent) {
    if (e.type === 'shot' || e.type === 'hit' || e.type === 'explosion') this.characters.onEvent(e);
    if (e.type === 'shot' || e.type === 'hit' || e.type === 'explosion') this.gunFx.onEvent(e, this.humanId);
    if (e.type === 'shot' || e.type === 'explosion') this.world.critterEvent(e);
    if ((e.type === 'shot' || e.type === 'explosion') && this.curr)
      this.world.impactEvent(e, { pieces: this.curr.pieces, players: this.curr.players, waterY: this.waterY, broken: this.curr.broken ?? [] });
    if (e.type === 'pieceHit' || e.type === 'destroyed') {
      this.world.pieceEvent(e, this.curr?.players ?? []);
    } else if (e.type === 'cosmeticBroken') {
      this.world.cosmeticEvent(e);
    } else if (e.type === 'hazard') {
      this.world.hazardEvent(e);
    } else if (e.type === 'trap') {
      this.traps.onEvent(e, this.world.pieceFx.particles);
    } else if (e.type === 'dockBroken') {
      this.world.dockEvent(e, this.waterY);
    } else if (e.type === 'explosion') {
      const pos = e.data.pos as Vec3 | undefined;
      const k = e.data.kind;
      if (pos) this.addBoom(pos, k === 'charge' ? 2 : k === 'rocket' ? 3.6 : k === 'barrel' ? 5 : k === 'propane' ? 4.6 : 4);
      if (typeof e.data.hazard === 'number') this.world.hazardEvent(e);
    } else if (e.type === 'lightning') {
      const pos = e.data.pos as Vec3 | undefined;
      if (pos) this.storm.strike(pos, this.camera);
    }
  }

  /** Template for explosion fireballs (each boom clones it: same shader, its own opacity). */
  private boomMat = new THREE.MeshBasicNodeMaterial({ color: boosted(0xffa040), transparent: true, opacity: 0.85, depthWrite: false });

  private addBoom(pos: Vec3, radius: number) {
    const mat = this.boomMat.clone();
    const m = new THREE.Mesh(this.boomGeo, mat);
    m.position.set(pos.x, pos.y, pos.z);
    m.scale.setScalar(0.2);
    this.scene.add(m);
    this.fx.push({ mesh: m, mat, born: performance.now(), life: 450, grow: radius });
  }

  /**
   * Loading warm-up (warmup.ts): one of each thing that only appears mid-match — every gun model and the muzzle
   * flash (third person), an explosion fireball, a loot bag, the build ghost material, a potion stall — in a row.
   */
  warmProps(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'warmProps';
    const add = (o: THREE.Object3D) => { o.position.x = g.children.length * 0.8; g.add(o); };
    for (const kind of Object.keys(WEAPONS) as WeaponKind[]) {
      const w = buildWeapon(kind);
      if (w) add(w);
    }
    const flash = buildMuzzleFlash();
    flash.visible = true;
    add(flash);
    add(new THREE.Mesh(this.boomGeo, this.boomMat));
    for (const o of lootWarmObjects()) add(o);
    add(new THREE.Mesh(this.ghostLinkGeo, this.ghostMat));
    add(stall());
    g.traverse((o) => { o.frustumCulled = false; });
    return g;
  }

  geometryFor(kind: PieceKind) {
    let g = this.pieceGeo.get(kind);
    if (!g) { g = pieceGeometry(kind); this.pieceGeo.set(kind, g); }
    return g;
  }

  private syncLoot(snap: Snapshot) {
    this.lootView.sync(snap.loot);
  }

  /** Display-rate motion of a player: predicted for the local player, else interpolated at the render clock. */
  playerMotion(id: number, out: Motion): Motion | null {
    if (id === this.humanId && this.local) {
      const l = this.local;
      out.pos.set(l.pos.x, l.pos.y, l.pos.z);
      out.vel.set(l.vel.x, l.vel.y, l.vel.z);
      return out;
    }
    const tr = this.tracks.get(id);
    if (!tr || this.playT === null || !tr.sample(this.playT, this.sampleTmp)) return null;
    const s = this.sampleTmp;
    out.pos.set(s.pos.x, s.pos.y, s.pos.z);
    out.vel.set(s.vel.x, s.vel.y, s.vel.z);
    out.yaw = s.yaw;
    out.pitch = s.pitch;
    return out;
  }
  /** scratch feet positions handed to the world each frame (grass bending) */
  private feet = Array.from({ length: 8 }, () => new THREE.Vector3());
  private sampleTmp = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };

  /** Display-rate feet position for a player. */
  playerPos(id: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const m = this.playerMotion(id, this.motion);
    return m ? out.copy(m.pos) : null;
  }

  /**
   * Build ghost. It glides toward a new spot (~50 ms) instead of popping, except across big jumps or a
   * kind change. `link` draws a thin line from the ghost to what it snaps onto.
   */
  setGhost(kind: PieceKind | null, pos?: Vec3, rotY = 0, ok = false, link: Vec3 | null = null) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.ghostT) / 1000);
    this.ghostT = now;
    if (!kind || !pos) {
      if (this.ghost) this.ghost.visible = false;
      if (this.ghostLink) this.ghostLink.visible = false;
      return;
    }
    if (!this.ghost) {
      this.ghost = new THREE.Mesh(this.geometryFor(kind), this.ghostMat);
      this.ghost.renderOrder = 10;
      this.scene.add(this.ghost);
    }
    const g = this.ghost;
    const jump = this.ghostKind !== kind || !g.visible || g.position.distanceTo(this.ghostTmp.set(pos.x, pos.y + 0.01, pos.z)) > 4;
    if (this.ghostKind !== kind) { g.geometry = this.geometryFor(kind); this.ghostKind = kind; }
    g.visible = true;
    if (jump) { g.position.set(pos.x, pos.y + 0.01, pos.z); g.rotation.y = rotY; }
    else {
      const k = 1 - Math.exp(-dt / 0.045);
      g.position.lerp(this.ghostTmp.set(pos.x, pos.y + 0.01, pos.z), k);
      g.rotation.y += Math.atan2(Math.sin(rotY - g.rotation.y), Math.cos(rotY - g.rotation.y)) * k;
    }
    this.ghostPulse = Math.max(0, this.ghostPulse - dt * 5);
    g.scale.setScalar(1 + 0.12 * this.ghostPulse);
    this.ghostMat.color.copy(boosted(ok ? 0x3ddc84 : 0xff4d4d)).lerp(this.ghostWhite, 0.6 * this.ghostPulse);

    if (!link) { if (this.ghostLink) this.ghostLink.visible = false; return; }
    if (!this.ghostLink) {
      this.ghostLink = new THREE.Mesh(this.ghostLinkGeo, new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }));
      this.ghostLink.renderOrder = 11;
      this.scene.add(this.ghostLink);
    }
    const from = this.ghostTmp.copy(g.position);
    from.y += 0.15;
    const len = from.distanceTo(this.ghostTmp2.set(link.x, link.y, link.z));
    this.ghostLink.visible = len > 0.05;
    this.ghostLink.position.copy(from);
    this.ghostLink.lookAt(this.ghostTmp2);
    this.ghostLink.scale.set(0.035, 0.035, len);
  }

  /** Spike trap placement ghost: where the request would put it (null hides it). */
  setTrapGhost(req: TrapRequest | null, ok = false) {
    this.traps.setGhost(req?.pos ?? null, req?.rotY ?? 0, req?.wall ?? false, ok);
  }

  /** Brief flash/pop on the ghost when a piece is placed from it. */
  pulseGhost() {
    this.ghostPulse = 1;
  }

  /**
   * Own placements the host hasn't confirmed yet (buildPredict.ts): drawn as real pieces, merged with the
   * current snapshot's pieces. Call before pushSnapshot when a confirmation and its snapshot arrive together.
   */
  setPredictedPieces(pieces: PieceState[]) {
    if (pieces.length === 0 && this.predicted.length === 0) return;
    this.predicted = pieces;
    if (this.curr) this.world.syncPieces(this.curr.pieces.concat(pieces));
  }

  /** Refused predicted pieces fading out (opacity 1 → 0); pass the full current list every frame. */
  setPieceFades(fades: { piece: PieceState; opacity: number }[]) {
    while (this.fadeMeshes.length < fades.length) {
      const m = new THREE.Mesh(undefined, new THREE.MeshBasicNodeMaterial({ color: boosted(0xff4d4d), transparent: true, depthWrite: false }));
      m.renderOrder = 10;
      this.scene.add(m);
      this.fadeMeshes.push(m);
    }
    this.fadeMeshes.forEach((m, i) => {
      const f = fades[i];
      m.visible = !!f;
      if (!f) return;
      m.geometry = this.geometryFor(f.piece.kind);
      m.position.set(f.piece.pos.x, f.piece.pos.y, f.piece.pos.z);
      m.rotation.set(0, f.piece.rotY, 0);
      (m.material as THREE.MeshBasicNodeMaterial).opacity = 0.7 * f.opacity;
    });
  }

  /** Meshes the aim ray may hit: world + pieces + other players. Reused array: valid until the next call. */
  aimTargets(): THREE.Object3D[] {
    const out = this.aimList;
    out.length = 0;
    for (const o of this.collidables) out.push(o);
    this.characters.aimTargets(this.humanId, out);
    return out;
  }
  private aimList: THREE.Object3D[] = [];
  private motionOf = (id: number, out: Motion) => this.playerMotion(id, out);

  /** Debug/screenshots only (?debug=1 harness): pin the camera at `pos` looking at `look`, overriding the game camera. */
  debugView: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;

  render(localYaw: number) {
    this.potionSellers.frame(performance.now());
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const snap = this.replay?.snap ?? this.curr;
    const motion = this.replay?.motion ?? this.motionOf;
    if (snap) {
      // Replay: nobody is "local" (everyone's yaw comes from the recording).
      this.characters.sync(snap.players, this.replay ? -1 : this.humanId, localYaw, snap.time, motion, snap.hidden);
      // Labels within reach of the player (predicted feet when playing, else the camera).
      this.lootView.frame(dt, now / 1000, this.local?.pos ?? this.camera.position, this.camera);
    }

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      const k = (now - f.born) / f.life;
      if (k >= 1) { this.scene.remove(f.mesh); f.mat.dispose(); this.fx.splice(i, 1); continue; }
      f.mat.opacity = 0.9 * (1 - k);
      if (f.grow) f.mesh.scale.setScalar(0.2 + (f.grow - 0.2) * Math.sqrt(k));
    }

    this.gunFx.update((now - this.snapArrived) / 1000);
    let nf = 0;
    if (snap) for (const p of snap.players) {
      if (!p.alive || nf >= this.feet.length || snap.hidden?.includes(p.id)) continue;
      const m = motion(p.id, this.motion);
      if (m) { this.feet[nf].copy(m.pos); nf++; if (!this.replay) this.world.footprints.step(p.id, m.pos); }
    }
    if (this.debugView) { this.camera.position.copy(this.debugView.pos); this.camera.lookAt(this.debugView.look); this.camera.updateMatrixWorld(); }
    this.gunFx.casings.limit = CASING_CAP[this.world.sky.quality];
    const simT = this.playT ?? snap?.time ?? 0;
    this.dayNight.frame(simT, !!snap?.suddenDeath);
    this.storm.frame(dt, this.camera, this.world.sky.quality, simT);
    this.traps.frame(simT);
    const feet = this.feet.slice(0, nf);
    this.npcs.frame(dt, this.camera, feet);
    this.world.render(this.waterY, this.camera.position, feet); // tide, grass, post chain, draw
    if (GPU_TIMING) this.resolveGpuTime();
  }

  /** This frame's totals (world + post + viewmodel); call after the frame's last render. */
  captureInfo() {
    const r = this.gpu.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
    this.lastInfo.drawCalls = r.drawCalls ?? r.calls ?? 0;
    this.lastInfo.triangles = r.triangles;
  }
  private lastInfo = { drawCalls: 0, triangles: 0 };

  /**
   * Draw calls / triangles of the last complete frame. three resets renderer.info at the start of its own
   * animation frame (before the game's), so reading it live mid-frame gives 0: main captures it after rendering.
   */
  info() {
    return { backend: this.backend, drawCalls: this.lastInfo.drawCalls, triangles: this.lastInfo.triangles };
  }
}
export { BrainOverlay } from './brainOverlay';

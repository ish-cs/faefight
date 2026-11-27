import * as THREE from 'three/webgpu';
import type { MapDef } from '../../sim/map';
import type { FirePatch, HazardNet, MatchEvent, PieceState, PlayerState, Snapshot } from '../../sim/types';
import { FireFx } from './fireFx';
import { Footprints } from './footprints';
import { ImpactMarks } from './impacts';
import { clearNpcSpots } from '../characters/npcSpots';
import { CosmeticLayer } from './cosmetics';
import { Debris } from './debris';
import { HazardLayer } from './hazards';
import { DockLayer } from './docks';
import { Critters } from './critters';
import type { CritterSound, V3 } from './critterSim';
import { Boats, gullPerches, Gulls } from './dressing';
import { LampPools } from './dayNight';
import { defineDetailKinds, lampSpots } from './detail';
import { GameProps } from './gameProps';
import { PROP_KINDS } from '../../sim/props';
import { Grass } from './grass';
import { buildGroundAO } from './groundAO';
import { perfOff } from './perfFlags';
import { Scatter } from './scatter';
import { backdropFrame, buildIslandsSteps, islandMask } from './islands';
import { runSteps, runStepsAsync } from './steps';
import { PieceFx } from './pieceFx';
import { PieceLayer } from './pieces';
import { PropLayer, TIER_LIMIT } from './propLayer';
import { setBuiltInPotionStalls } from './potionSeller';
import { installQualityToggle, SkyLighting, SUN_DIR } from './sky';
import { impostors, SUN_FOR_BAKE } from './impostor';
import { lods, releaseLods } from './lod';
import { STRESS, stressOffsets } from './stress';
import { buildWater, type Ocean } from './water';

export { pieceGeometry } from './pieces';
export type { Quality } from './sky';

/**
 * Everything that isn't a player: sky/lighting/post, islands + backdrop, ocean, building pieces.
 * Renderer owns one of these and forwards a handful of calls.
 */
export class World {
  readonly sky: SkyLighting;
  readonly pieces = new PieceLayer();
  /** Bullet holes, impact particles, shake and destruction debris for pieces. */
  readonly pieceFx = new PieceFx(this.pieces);
  /** Bullet/blast marks and impact bursts on the world itself (ground, quay walls, cover, props). */
  readonly impacts = new ImpactMarks(this.pieceFx.particles);
  /** Flames, smoke, embers, charring and the fire light for burning pieces and ground fires. */
  readonly fire = new FireFx(this.pieceFx.particles, this.pieces);
  /** Boot prints on sand / gravel / wet docks (render.ts feeds each walker's feet). */
  readonly footprints = new Footprints();
  private water: Ocean | null = null;
  private islands: THREE.Group | null = null;
  private islandHulls: THREE.Object3D[] = [];
  private cosmetics: CosmeticLayer | null = null;
  /** Tier A gameplay props (sim-owned rigid bodies), posed from snapshots. */
  private gameProps: GameProps | null = null;
  /** Night light pools under the lamps (day/night cycle). */
  private lampPools: LampPools | null = null;
  /** Explosive barrels / propane tanks / supply crates. */
  private hazards: HazardLayer | null = null;
  /** Wooden piers: whole / scorched / broken sections (docks.ts). */
  private docks: DockLayer | null = null;
  /** instanced grass beds (high/ultra) */
  readonly grass = new Grass();
  /** instanced small detail (litter, rubble, shells, seaweed…) */
  readonly scatter = new Scatter();
  /** client-only physics debris (bottles, cans, cones, boxes…): tumbles, never touches gameplay */
  readonly debris = new Debris();
  /** dense dock clusters + quay gear (clusters.ts / propLayer.ts) */
  readonly props = new PropLayer();
  private boats: Boats | null = null;
  private lastFrame = performance.now();
  /** soft baked-AO footprints under containers, walls and stations (groundAO.ts) */
  private groundAO: THREE.Mesh | null = null;
  private waterEnv: THREE.MeshStandardNodeMaterial | null = null;
  private gulls: Gulls | null = null;
  /** wildlife (rats, birds, crabs, insects, fish …): cosmetic, client-only */
  critters: Critters | null = null;
  /** positional critter sounds (main wires this to the audio system) */
  onCritterSound: ((s: CritterSound) => void) | null = null;

  /** `collidables` is the Renderer's camera/aim blocker list; World adds its static + piece hulls to it. */
  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene, camera: THREE.PerspectiveCamera, private collidables: THREE.Object3D[]) {
    this.sky = new SkyLighting(gpu, scene, camera);
    SUN_FOR_BAKE.dir.copy(SUN_DIR);
    installQualityToggle(this.sky);
    scene.add(this.pieces.root, this.pieceFx.root, this.impacts.mesh, this.fire.light, this.footprints.mesh);
    collidables.push(...this.pieces.proxies);
    this.pieces.onProxiesChanged = () => {
      for (let i = collidables.length - 1; i >= 0; i--) if (collidables[i].name.startsWith('pieceHull:')) collidables.splice(i, 1);
      collidables.push(...this.pieces.proxies);
    };
  }

  /** Build the map in one go (labs). The game uses setMapAsync. */
  setMap(def: MapDef, teamColors: number[]) {
    runSteps(this.setMapSteps(def, teamColors));
  }

  /** setMap spread over tasks (~30 ms each), so a 1.5 s build (6 s on a throttled CPU) doesn't freeze the page. */
  setMapAsync(def: MapDef, teamColors: number[], onStep?: () => void): Promise<void> {
    return runStepsAsync(this.setMapSteps(def, teamColors), 30, onStep);
  }

  private *setMapSteps(def: MapDef, teamColors: number[]): Generator<void, void> {
    this.clearMap();
    const t0 = performance.now();
    if (!this.scatter.has('pebble')) defineDetailKinds(this.scatter);
    clearNpcSpots(); // the shop/potion props below register their keepers
    this.props.buildTier = TIER_LIMIT[this.sky.quality];
    // ?noprops (perf A/B): no dock clusters, no physics debris, no gameplay-prop meshes (the sim still has them)
    const q = typeof location !== 'undefined' ? location.search : '';
    const noProps = q.includes('noprops');
    // finer A/B switches: ?noclusters / ?nogameprops / ?nodebris drop one layer each
    const noClusters = noProps || q.includes('noclusters'), noGameProps = noProps || q.includes('nogameprops'), noDebris = noProps || q.includes('nodebris');
    lampSpots.length = 0; // the harbor street lamps below register their light pools
    yield;
    // islands, props and scatter join the scene together once all three are built (nothing half-built is drawn)
    const { root, collidables } = yield* buildIslandsSteps(def, teamColors, this.scatter, noClusters ? undefined : this.props);
    this.props.build();
    yield;
    this.scatter.build();
    yield;
    this.scene.add(this.props.root);
    this.scene.add(this.scatter.root);
    this.scene.add(root);
    this.islands = root;
    this.islandHulls = collidables;
    this.collidables.push(...collidables);
    const map = def.islands;
    this.impacts.setMap(def);
    this.footprints.clear();
    this.footprints.surfaces = this.impacts.surf;
    this.water = buildWater(def);
    this.scene.add(this.water.mesh);
    // The ambient env map is deliberately hazy/desaturated (for shading); at grazing angles it turned the far sea
    // milky. Water samples the same map, a bit dimmer.
    const wm = this.water.mesh.material as THREE.MeshStandardNodeMaterial;
    wm.envMap = this.scene.environment;
    wm.envMapIntensity = 0.62;
    // same map, tinted for the time of day like every other surface (envMap stays set: it picks envMapIntensity)
    if (this.sky.lighting.envNode) wm.envNode = this.sky.lighting.envNode;
    this.waterEnv = wm;
    this.groundAO = perfOff('nogroundao') ? null : buildGroundAO(def);
    if (this.groundAO) this.scene.add(this.groundAO);
    yield;
    this.sky.setInteriors(map);
    // grass follows the harbor surface mask (sand/grass beds); the Container Yard is bare asphalt
    if (def.template === 'harbor') this.grass.build(map, (isl) => backdropFrame(isl, map.length), islandMask);
    this.scene.add(this.grass.root);
    yield;
    this.boats = new Boats(map);
    this.gulls = new Gulls(map, gullPerches(map, (isl) => backdropFrame(isl, map.length)));
    this.scene.add(this.boats.root, this.gulls.mesh);
    const perches = gullPerches(map, (isl) => backdropFrame(isl, map.length)).filter((p) => !p.roof).map((p) => ({ x: p.p.x, y: p.p.y, z: p.p.z, yaw: p.yaw }));
    this.critters = new Critters(def, perches);
    this.critters.onSound = (s) => this.onCritterSound?.(s);
    this.scene.add(this.critters.root);
    yield;
    setBuiltInPotionStalls([def.center.potionShop]); // center.ts draws this seller; PotionSellers must not double it
    // debug stress scene: visual-only shifted copies with ids the sim never uses
    const cos = STRESS > 1 ? stressOffsets().flatMap(([ox, oz], k) => def.cosmetics.map((c) => k === 0 ? c : { ...c, id: 1e6 * k + c.id, pos: { ...c.pos, x: c.pos.x + ox, z: c.pos.z + oz } })) : def.cosmetics;
    this.cosmetics = new CosmeticLayer(cos);
    this.scene.add(this.cosmetics.root);
    yield;
    this.scene.add(this.debris.root);
    const gameProps = this.gameProps = new GameProps(noGameProps ? [] : def.props ?? []);
    this.scene.add(gameProps.root);
    // bullet marks on a prop ride along with it; debris collides with the props (kinematic, following their snapshot poses)
    let debrisPose: ((id: number, p: THREE.Vector3, q: THREE.Quaternion) => void) | null = null;
    gameProps.onPose = (id, p, q) => { this.impacts.followProp(id, p, q); debrisPose?.(id, p, q); };
    if (!noDebris) void this.debris.build(def, this.sky.quality).then(() => {
      const sim = this.debris.sim;
      if (!sim || this.gameProps !== gameProps) return;
      for (const s of def.props ?? []) sim.addObstacle(s.id, PROP_KINDS[s.kind].shape, s.pos, s.rot);
      const cam = this.sky.camera.position;
      debrisPose = (id, p, q) => sim.moveObstacle(id, p, [q.x, q.y, q.z, q.w], cam);
    });
    this.lampPools = new LampPools(lampSpots, cos);
    this.scene.add(this.lampPools.mesh);
    const hazards = this.hazards = new HazardLayer(def.hazards ?? []);
    this.scene.add(this.hazards.root);
    // shots ending on a gameplay prop or hazard mark it (owned: the mark follows / goes with it)
    this.impacts.solid = (p) => gameProps.hitAt(p) ?? hazards.hitAt(p);
    this.docks = new DockLayer(def.docks ?? [], def.waterY);
    this.scene.add(this.docks.root);
    impostors.flush(this.gpu, this.scene.environment); // before the shader warm-up sees their materials
    // Static subtrees never move: compute their world matrices once and stop three re-deriving them every frame
    // (updateMatrixWorld was ~0.5 ms/frame of main-thread time). LOD only toggles .visible, which is unaffected.
    for (const r of [this.islands, this.scatter.root, this.cosmetics.root, this.grass.root]) {
      if (!r) continue;
      r.updateMatrixWorld(true);
      r.traverse((o) => { o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false; });
    }
    console.info(`[world] built ${def.name}: ${map.length} islands + center, ${def.statics.length} cover, ${def.cosmetics.length} cosmetics, ${(def.hazards ?? []).length} hazards in ${Math.round(performance.now() - t0)} ms`);
  }

  /** Drop a previous map (setMap twice in one session). Shared materials/textures stay cached. */
  private clearMap() {
    if (this.islands) {
      const hulls = new Set(this.islandHulls);
      for (let i = this.collidables.length - 1; i >= 0; i--) if (hulls.has(this.collidables[i])) this.collidables.splice(i, 1);
      releaseLods(this.islands);
      this.islands.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
      this.islands.removeFromParent();
      this.islands = null;
      this.islandHulls = [];
    }
    if (this.water) { this.water.mesh.geometry.dispose(); this.water.mesh.removeFromParent(); this.water = null; this.waterEnv = null; }
    if (this.groundAO) { this.groundAO.geometry.dispose(); this.groundAO.removeFromParent(); this.groundAO = null; }
    // grass beds are additive per build: drop the previous map's
    for (const c of [...this.grass.root.children]) { if (c instanceof THREE.Mesh) c.geometry.dispose(); c.removeFromParent(); }
    this.boats?.root.removeFromParent();
    this.boats = null;
    this.gulls?.mesh.removeFromParent();
    this.gulls = null;
    this.critters?.root.removeFromParent();
    this.critters = null;
    this.cosmetics?.dispose();
    this.cosmetics = null;
    this.debris.clear();
    this.gameProps?.dispose();
    this.gameProps = null;
    this.props.clear();
    this.lampPools?.dispose();
    this.lampPools = null;
    this.hazards?.dispose();
    this.hazards = null;
    this.impacts.solid = null;
    this.docks?.dispose();
    this.docks = null;
  }

  /** Pier sections: snapshot state (broken, scorched). */
  syncDocks(broken: number[] | undefined, hurt: number[] | undefined) { this.docks?.sync(broken ?? [], hurt ?? []); }

  /** Snapshot breakables (cosmetics, pier sections, hazards): marks on whatever is gone go with it. */
  syncBroken(cosmetics: readonly number[], docks: readonly number[], hz: HazardNet[] | undefined) { this.impacts.syncBroken(cosmetics, docks, hz); }

  /** A pier section just broke: stubs, flying planks, spray. */
  dockEvent(e: MatchEvent, waterY: number) { if (e.type === 'dockBroken') this.docks?.onBroken(e.data, this.pieceFx.particles, waterY); }

  /** Hide every cosmetic prop whose id is in `broken` (snapshot state; late joiners see them broken too). */
  syncCosmetics(broken: number[]) { this.cosmetics?.sync(broken); this.lampPools?.sync(broken); }

  /** A cosmetic prop just broke: debris burst at its position. */
  cosmeticEvent(e: MatchEvent) {
    if (e.type !== 'cosmeticBroken') return;
    this.cosmetics?.onBroken(e.data, this.pieceFx.particles);
  }

  /** Snapshot `props` (displaced gameplay props; the rest are at spawn). */
  syncProps(poses: Snapshot['props']) { this.gameProps?.sync(poses); }

  /** Barrels / tanks / crates: snapshot state (gone, fusing). */
  syncHazards(hz: HazardNet[] | undefined) { this.hazards?.sync(hz); }

  /** `hazard` events and hazard explosions → fuse fx, fireball debris, scorch, crate splinters. */
  hazardEvent(e: MatchEvent) { this.hazards?.onEvent(e, this.pieceFx.particles); }

  syncPieces(pieces: PieceState[], fires?: FirePatch[]) {
    this.pieces.sync(pieces);
    this.pieceFx.sync(pieces);
    this.debris.syncPieces(pieces);
    this.fire.sync(pieces, fires);
    this.water?.syncPieces(pieces, this.sky.camera.position);
    const ids = new Set<number>();
    for (const p of pieces) ids.add(p.id);
    this.impacts.syncPieces(pieces, ids);
  }

  /** `shot` / `explosion` events → world surface marks and impact bursts. */
  impactEvent(e: MatchEvent, view: Parameters<ImpactMarks['onEvent']>[1]) { this.impacts.onEvent(e, view); }

  /** Shots / explosions scare the wildlife. */
  critterEvent(e: MatchEvent) { this.critters?.onEvent(e); }

  /** `pieceHit` / `destroyed` events → decals, particles, shake, debris. */
  pieceEvent(e: MatchEvent, players: PlayerState[]) { this.pieceFx.onEvent(e, players); }

  /** `feet`: live player feet positions (grass bends away from them). */
  render(waterY: number, focus?: THREE.Vector3, feet: THREE.Vector3[] = []) {
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.water) this.water.update(focus ?? this.sky.camera.position, waterY, dt);
    // water reflections follow the weather (its own envMapIntensity ignores scene.environmentIntensity)
    if (this.waterEnv) this.waterEnv.envMapIntensity = 0.62 * (1 - 0.65 * this.sky.lighting.weather);
    const t = now / 1000;
    this.debris.update(dt, focus ?? this.sky.camera.position, feet, waterY);
    if (this.critters) {
      this.critters.setQuality(this.sky.quality);
      this.critters.update(dt, this.sky.camera as THREE.PerspectiveCamera, feet as V3[], waterY);
    }
    this.boats?.update(t, waterY);
    this.gulls?.update(t);
    this.grass.setQuality(this.sky.quality);
    this.scatter.setQuality(this.sky.quality);
    this.props.setQuality(this.sky.quality);
    if (focus) this.grass.update(focus, feet);
    impostors.step(this.gpu, this.scene.environment); // one queued impostor bake per frame (load/reveal frames)
    lods.setQuality(this.sky.quality);
    lods.update(this.sky.camera.position);
    this.pieceFx.update(now);
    this.gameProps?.update(dt);
    this.impacts.setQuality(this.sky.quality);
    this.impacts.update();
    this.footprints.update();
    this.fire.setQuality(this.sky.quality);
    this.fire.update(Math.min(0.05, dt), this.sky.camera);
    this.hazards?.update(now, this.pieceFx.particles);
    this.sky.render(); // cascaded shadows follow the camera themselves
  }
}

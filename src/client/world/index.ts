import * as THREE from 'three/webgpu';
import type { MapDef } from '../../sim/map';
import type { FirePatch, HazardNet, MatchEvent, PieceState, PlayerState } from '../../sim/types';
import { FireFx } from './fireFx';
import { ImpactMarks } from './impacts';
import { clearNpcSpots } from '../characters/npcSpots';
import { CosmeticLayer } from './cosmetics';
import { HazardLayer } from './hazards';
import { DockLayer } from './docks';
import { Critters } from './critters';
import type { CritterSound, V3 } from './critterSim';
import { Boats, gullPerches, Gulls } from './dressing';
import { LampPools } from './dayNight';
import { defineDetailKinds, lampSpots } from './detail';
import { Grass } from './grass';
import { Scatter } from './scatter';
import { backdropFrame, buildIslands, islandMask } from './islands';
import { PieceFx } from './pieceFx';
import { PieceLayer } from './pieces';
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
  private water: Ocean | null = null;
  private islands: THREE.Group | null = null;
  private islandHulls: THREE.Object3D[] = [];
  private cosmetics: CosmeticLayer | null = null;
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
  private boats: Boats | null = null;
  private lastFrame = performance.now();
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
    scene.add(this.pieces.root, this.pieceFx.root, this.impacts.mesh, this.fire.light);
    collidables.push(...this.pieces.proxies);
    this.pieces.onProxiesChanged = () => {
      for (let i = collidables.length - 1; i >= 0; i--) if (collidables[i].name.startsWith('pieceHull:')) collidables.splice(i, 1);
      collidables.push(...this.pieces.proxies);
    };
  }

  setMap(def: MapDef, teamColors: number[]) {
    this.clearMap();
    const t0 = performance.now();
    if (!this.scatter.has('pebble')) defineDetailKinds(this.scatter);
    clearNpcSpots(); // the shop/potion props below register their keepers
    lampSpots.length = 0; // the harbor street lamps below register their light pools
    const { root, collidables } = buildIslands(def, teamColors, this.scatter);
    this.scatter.build();
    this.scene.add(this.scatter.root);
    this.scene.add(root);
    this.islands = root;
    this.islandHulls = collidables;
    this.collidables.push(...collidables);
    const map = def.islands;
    this.impacts.setMap(def);
    this.water = buildWater(def);
    this.scene.add(this.water.mesh);
    // The ambient env map is deliberately hazy/desaturated (for shading); at grazing angles it turned the far sea
    // milky. Water samples the same map, a bit dimmer.
    const wm = this.water.mesh.material as THREE.MeshStandardNodeMaterial;
    wm.envMap = this.scene.environment;
    wm.envMapIntensity = 0.62;
    this.sky.setInteriors(map);
    // grass follows the harbor surface mask (sand/grass beds); the Container Yard is bare asphalt
    if (def.template === 'harbor') this.grass.build(map, (isl) => backdropFrame(isl, map.length), islandMask);
    this.scene.add(this.grass.root);
    this.boats = new Boats(map);
    this.gulls = new Gulls(map, gullPerches(map, (isl) => backdropFrame(isl, map.length)));
    this.scene.add(this.boats.root, this.gulls.mesh);
    const perches = gullPerches(map, (isl) => backdropFrame(isl, map.length)).filter((p) => !p.roof).map((p) => ({ x: p.p.x, y: p.p.y, z: p.p.z, yaw: p.yaw }));
    this.critters = new Critters(def, perches);
    this.critters.onSound = (s) => this.onCritterSound?.(s);
    this.scene.add(this.critters.root);
    setBuiltInPotionStalls([def.center.potionShop]); // center.ts draws this seller; PotionSellers must not double it
    // debug stress scene: visual-only shifted copies with ids the sim never uses
    const cos = STRESS > 1 ? stressOffsets().flatMap(([ox, oz], k) => def.cosmetics.map((c) => k === 0 ? c : { ...c, id: 1e6 * k + c.id, pos: { ...c.pos, x: c.pos.x + ox, z: c.pos.z + oz } })) : def.cosmetics;
    this.cosmetics = new CosmeticLayer(cos);
    this.scene.add(this.cosmetics.root);
    this.lampPools = new LampPools(lampSpots, cos);
    this.scene.add(this.lampPools.mesh);
    this.hazards = new HazardLayer(def.hazards ?? []);
    this.scene.add(this.hazards.root);
    this.docks = new DockLayer(def.docks ?? [], def.waterY);
    this.scene.add(this.docks.root);
    impostors.flush(this.gpu, this.scene.environment); // before the shader warm-up sees their materials
    // Static subtrees never move: compute their world matrices once and stop three re-deriving them every frame
    // (updateMatrixWorld was ~0.5 ms/frame of main-thread time). LOD only toggles .visible, which is unaffected.
    for (const r of [this.islands, this.scatter.root, this.cosmetics.root]) {
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
    if (this.water) { this.water.mesh.geometry.dispose(); this.water.mesh.removeFromParent(); this.water = null; }
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
    this.lampPools?.dispose();
    this.lampPools = null;
    this.hazards?.dispose();
    this.hazards = null;
    this.docks?.dispose();
    this.docks = null;
  }

  /** Pier sections: snapshot state (broken, scorched). */
  syncDocks(broken: number[] | undefined, hurt: number[] | undefined) { this.docks?.sync(broken ?? [], hurt ?? []); }

  /** A pier section just broke: stubs, flying planks, spray. */
  dockEvent(e: MatchEvent, waterY: number) { if (e.type === 'dockBroken') this.docks?.onBroken(e.data, this.pieceFx.particles, waterY); }

  /** Hide every cosmetic prop whose id is in `broken` (snapshot state; late joiners see them broken too). */
  syncCosmetics(broken: number[]) { this.cosmetics?.sync(broken); this.lampPools?.sync(broken); }

  /** A cosmetic prop just broke: debris burst at its position. */
  cosmeticEvent(e: MatchEvent) {
    if (e.type !== 'cosmeticBroken') return;
    this.cosmetics?.onBroken(e.data, this.pieceFx.particles);
  }

  /** Barrels / tanks / crates: snapshot state (gone, fusing). */
  syncHazards(hz: HazardNet[] | undefined) { this.hazards?.sync(hz); }

  /** `hazard` events and hazard explosions → fuse fx, fireball debris, scorch, crate splinters. */
  hazardEvent(e: MatchEvent) { this.hazards?.onEvent(e, this.pieceFx.particles); }

  syncPieces(pieces: PieceState[], fires?: FirePatch[]) {
    this.pieces.sync(pieces);
    this.pieceFx.sync(pieces);
    this.fire.sync(pieces, fires);
    this.water?.syncPieces(pieces, this.sky.camera.position);
    if (this.impacts.active) { const ids = new Set(pieces.map((p) => p.id)); this.impacts.retainPieces((id) => ids.has(id)); }
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
    if (this.critters) {
      this.critters.setQuality(this.sky.quality);
      this.critters.update(dt, this.sky.camera as THREE.PerspectiveCamera, feet as V3[], waterY);
    }
    const t = performance.now() / 1000;
    this.boats?.update(t, waterY);
    this.gulls?.update(t);
    this.grass.setQuality(this.sky.quality);
    this.scatter.setQuality(this.sky.quality);
    if (focus) this.grass.update(focus, feet);
    impostors.step(this.gpu, this.scene.environment); // one queued impostor bake per frame (load/reveal frames)
    lods.setQuality(this.sky.quality);
    lods.update(this.sky.camera.position);
    this.pieceFx.update(now);
    this.impacts.setQuality(this.sky.quality);
    this.impacts.update();
    this.fire.setQuality(this.sky.quality);
    this.fire.update(Math.min(0.05, dt), this.sky.camera);
    this.hazards?.update(now, this.pieceFx.particles);
    this.sky.render(); // cascaded shadows follow the camera themselves
  }
}

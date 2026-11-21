import * as THREE from 'three/webgpu';
import type { MapDef } from '../../sim/map';
import type { MatchEvent, PieceState, PlayerState } from '../../sim/types';
import { CosmeticLayer } from './cosmetics';
import { Critters } from './critters';
import type { CritterSound, V3 } from './critterSim';
import { Boats, gullPerches, Gulls } from './dressing';
import { defineDetailKinds } from './detail';
import { Grass } from './grass';
import { Scatter } from './scatter';
import { backdropFrame, buildIslands, islandMask } from './islands';
import { PieceFx } from './pieceFx';
import { PieceLayer } from './pieces';
import { setBuiltInPotionStalls } from './potionSeller';
import { installQualityToggle, SkyLighting } from './sky';
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
  private water: Ocean | null = null;
  private islands: THREE.Group | null = null;
  private islandHulls: THREE.Object3D[] = [];
  private cosmetics: CosmeticLayer | null = null;
  /** instanced grass beds (high/ultra) */
  readonly grass = new Grass();
  /** instanced small detail (litter, rubble, shells, seaweed…) */
  readonly scatter = new Scatter();
  private boats: Boats | null = null;
  private gulls: Gulls | null = null;
  /** wildlife (rats, birds, crabs, insects, fish …): cosmetic, client-only */
  critters: Critters | null = null;
  /** positional critter sounds (main wires this to the audio system) */
  onCritterSound: ((s: CritterSound) => void) | null = null;
  private lastFrame = performance.now();

  /** `collidables` is the Renderer's camera/aim blocker list; World adds its static + piece hulls to it. */
  constructor(gpu: THREE.WebGPURenderer, private scene: THREE.Scene, camera: THREE.PerspectiveCamera, private collidables: THREE.Object3D[]) {
    this.sky = new SkyLighting(gpu, scene, camera);
    installQualityToggle(this.sky);
    scene.add(this.pieces.root, this.pieceFx.root);
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
    const { root, collidables } = buildIslands(def, teamColors, this.scatter);
    this.scatter.build();
    this.scene.add(this.scatter.root);
    this.scene.add(root);
    this.islands = root;
    this.islandHulls = collidables;
    this.collidables.push(...collidables);
    const map = def.islands;
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
    this.cosmetics = new CosmeticLayer(def.cosmetics);
    this.scene.add(this.cosmetics.root);
    console.info(`[world] built ${def.name}: ${map.length} islands + center, ${def.statics.length} cover, ${def.cosmetics.length} cosmetics in ${Math.round(performance.now() - t0)} ms`);
  }

  /** Drop a previous map (setMap twice in one session). Shared materials/textures stay cached. */
  private clearMap() {
    if (this.islands) {
      const hulls = new Set(this.islandHulls);
      for (let i = this.collidables.length - 1; i >= 0; i--) if (hulls.has(this.collidables[i])) this.collidables.splice(i, 1);
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
  }

  /** Hide every cosmetic prop whose id is in `broken` (snapshot state; late joiners see them broken too). */
  syncCosmetics(broken: number[]) { this.cosmetics?.sync(broken); }

  /** A cosmetic prop just broke: debris burst at its position. */
  cosmeticEvent(e: MatchEvent) {
    if (e.type !== 'cosmeticBroken') return;
    this.cosmetics?.onBroken(e.data, this.pieceFx.particles);
  }

  syncPieces(pieces: PieceState[]) { this.pieces.sync(pieces); this.pieceFx.sync(pieces); }

  /** Shots / explosions scare the wildlife. */
  critterEvent(e: MatchEvent) { this.critters?.onEvent(e); }

  /** `pieceHit` / `destroyed` events → decals, particles, shake, debris. */
  pieceEvent(e: MatchEvent, players: PlayerState[]) { this.pieceFx.onEvent(e, players); }

  /** `feet`: live player feet positions (grass bends away from them). */
  render(waterY: number, focus?: THREE.Vector3, feet: THREE.Vector3[] = []) {
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.water) this.water.update(focus ?? this.sky.camera.position, waterY);
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
    this.pieceFx.update(performance.now());
    this.sky.render(); // cascaded shadows follow the camera themselves
  }
}

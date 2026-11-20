import * as THREE from 'three/webgpu';
import type { MapDef } from '../../sim/map';
import type { MatchEvent, PieceState, PlayerState } from '../../sim/types';
import { CosmeticLayer } from './cosmetics';
import { buildIslands } from './islands';
import { PieceFx } from './pieceFx';
import { PieceLayer } from './pieces';
import { installQualityToggle, SkyLighting } from './sky';
import { buildWater } from './water';

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
  private water: THREE.Mesh | null = null;
  private islands: THREE.Group | null = null;
  private islandHulls: THREE.Object3D[] = [];
  private cosmetics: CosmeticLayer | null = null;

  /** `collidables` is the Renderer's camera/aim blocker list; World adds its static + piece hulls to it. */
  constructor(gpu: THREE.WebGPURenderer, private scene: THREE.Scene, camera: THREE.Camera, private collidables: THREE.Object3D[]) {
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
    const { root, collidables } = buildIslands(def, teamColors);
    this.scene.add(root);
    this.islands = root;
    this.islandHulls = collidables;
    this.collidables.push(...collidables);
    this.water = buildWater(def);
    this.scene.add(this.water);
    this.cosmetics = new CosmeticLayer(def.cosmetics);
    this.scene.add(this.cosmetics.root);
    console.info(`[world] built ${def.name}: ${def.islands.length} islands + center, ${def.statics.length} cover, ${def.cosmetics.length} cosmetics in ${Math.round(performance.now() - t0)} ms`);
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
    if (this.water) { this.water.geometry.dispose(); this.water.removeFromParent(); this.water = null; }
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

  /** `pieceHit` / `destroyed` events → decals, particles, shake, debris. */
  pieceEvent(e: MatchEvent, players: PlayerState[]) { this.pieceFx.onEvent(e, players); }

  render(waterY: number, focus: THREE.Vector3) {
    if (this.water) this.water.position.y = waterY;
    this.pieceFx.update(performance.now());
    this.sky.render(focus);
  }
}

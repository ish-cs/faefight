import * as THREE from 'three/webgpu';
import type { IslandLayout } from '../../sim/map';
import type { PieceState } from '../../sim/types';
import { buildIslands } from './islands';
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
  private water: THREE.Mesh | null = null;

  /** `collidables` is the Renderer's camera/aim blocker list; World adds its static + piece hulls to it. */
  constructor(gpu: THREE.WebGPURenderer, private scene: THREE.Scene, camera: THREE.PerspectiveCamera, private collidables: THREE.Object3D[]) {
    this.sky = new SkyLighting(gpu, scene, camera);
    installQualityToggle(this.sky);
    scene.add(this.pieces.root);
    collidables.push(...this.pieces.proxies);
    this.pieces.onProxiesChanged = () => {
      for (let i = collidables.length - 1; i >= 0; i--) if (collidables[i].name.startsWith('pieceHull:')) collidables.splice(i, 1);
      collidables.push(...this.pieces.proxies);
    };
  }

  setMap(map: IslandLayout[], teamColors: number[]) {
    const t0 = performance.now();
    const { root, collidables } = buildIslands(map, teamColors);
    this.scene.add(root);
    this.collidables.push(...collidables);
    this.water = buildWater(map);
    this.scene.add(this.water);
    this.sky.setInteriors(map);
    console.info(`[world] built ${map.length} islands in ${Math.round(performance.now() - t0)} ms`);
  }

  syncPieces(pieces: PieceState[]) { this.pieces.sync(pieces); }

  render(waterY: number, _focus?: THREE.Vector3) {
    if (this.water) this.water.position.y = waterY;
    this.sky.render(); // cascaded shadows follow the camera themselves
  }
}

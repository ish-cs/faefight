import * as THREE from 'three/webgpu';
import type { IslandLayout } from '../../sim/map';
import type { MatchEvent, PieceState, PlayerState } from '../../sim/types';
import { Boats, gullPerches, Gulls } from './dressing';
import { defineDetailKinds } from './detail';
import { Grass } from './grass';
import { Scatter } from './scatter';
import { backdropFrame, buildIslands, islandMask } from './islands';
import { PieceFx } from './pieceFx';
import { PieceLayer } from './pieces';
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
  /** instanced grass beds (high/ultra) */
  readonly grass = new Grass();
  /** instanced small detail (litter, rubble, shells, seaweed…) */
  readonly scatter = new Scatter();
  private boats: Boats | null = null;
  private gulls: Gulls | null = null;

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

  setMap(map: IslandLayout[], teamColors: number[]) {
    const t0 = performance.now();
    if (!this.scatter.has('pebble')) defineDetailKinds(this.scatter);
    const { root, collidables } = buildIslands(map, teamColors, this.scatter);
    this.scatter.build();
    this.scene.add(this.scatter.root);
    this.scene.add(root);
    this.collidables.push(...collidables);
    this.water = buildWater(map);
    this.scene.add(this.water.mesh);
    // The ambient env map is deliberately hazy/desaturated (for shading); at grazing angles it turned the far sea
    // milky. Water samples the same map, a bit dimmer.
    const wm = this.water.mesh.material as THREE.MeshStandardNodeMaterial;
    wm.envMap = this.scene.environment;
    wm.envMapIntensity = 0.62;
    this.sky.setInteriors(map);
    this.grass.build(map, (isl) => backdropFrame(isl, map.length), islandMask);
    this.scene.add(this.grass.root);
    this.boats = new Boats(map);
    this.gulls = new Gulls(map, gullPerches(map, (isl) => backdropFrame(isl, map.length)));
    this.scene.add(this.boats.root, this.gulls.mesh);
    console.info(`[world] built ${map.length} islands in ${Math.round(performance.now() - t0)} ms`);
  }

  syncPieces(pieces: PieceState[]) { this.pieces.sync(pieces); this.pieceFx.sync(pieces); }

  /** `pieceHit` / `destroyed` events → decals, particles, shake, debris. */
  pieceEvent(e: MatchEvent, players: PlayerState[]) { this.pieceFx.onEvent(e, players); }

  /** `feet`: live player feet positions (grass bends away from them). */
  render(waterY: number, focus?: THREE.Vector3, feet: THREE.Vector3[] = []) {
    if (this.water) this.water.update(focus ?? this.sky.camera.position, waterY);
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

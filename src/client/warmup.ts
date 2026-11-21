import * as THREE from 'three/webgpu';
import { PIECES } from '../sim/constants';
import type { PieceKind, PieceState } from '../sim/types';
import type { Renderer } from './render';

const KINDS = Object.keys(PIECES) as PieceKind[];

/**
 * Shader warm-up, run behind the loading screen once the map, avatars and first snapshot are in:
 * 1. compileAsync the whole scene (pipelines built off the main thread where the backend can);
 * 2. one hidden frame with a damaged piece of every kind plus the build ghost in front of the
 *    camera, so piece/ghost pipelines exist for the real (post-processed) render path and the
 *    first wall someone places doesn't hitch.
 * `pieces()` returns the real pieces to restore afterwards.
 */
export async function warmUp(r: Renderer, pieces: () => PieceState[], yaw: number, onStep: (frac: number, label: string) => void) {
  const t0 = performance.now();
  onStep(0, 'Compiling shaders');
  try {
    // N/M from the renderer's own count of pipelines it queued for this compile.
    await r.gpu.compileAsync(r.scene, r.camera, null, (e) => {
      if (e.total > 0) onStep(0.6 * (e.loaded / e.total), `Compiling shaders ${e.loaded}/${e.total}`);
    });
  } catch (err) {
    console.warn('[warmup] compileAsync failed; shaders will compile on first use', err);
  }
  onStep(0.6, 'Warming up materials');

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const base = r.camera.position.clone().addScaledVector(fwd, 9);
  const fakes: PieceState[] = KINDS.map((kind, i) => {
    const p = base.clone().addScaledVector(side, (i - (KINDS.length - 1) / 2) * 3);
    return { id: -1000 - i, kind, owner: -1, pos: { x: p.x, y: r.camera.position.y - 2, z: p.z }, rotY: 0, hp: PIECES[kind].hp * 0.4 };
  });
  try {
    r.world.syncPieces([...pieces(), ...fakes]);
    r.setGhost(KINDS[0], fakes[0].pos, 0, true);
    r.render(yaw);
  } finally {
    r.setGhost(null);
    r.world.syncPieces(pieces());
  }
  onStep(1, 'Warming up materials');
  console.info(`[warmup] shaders + ${KINDS.length} piece kinds warmed in ${Math.round(performance.now() - t0)} ms`);
}

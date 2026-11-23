import * as THREE from 'three/webgpu';
import type { Renderer } from './render';

/** What the warm-up needs from the game's frame loop (main.ts). */
export type WarmLoop = {
  /** Stop drawing the scene (the loading screen covers the canvas) while the renderer state is borrowed. */
  setPaused(on: boolean): void;
  /** Resolves after `n` more drawn frames; `before` runs right before each is drawn. */
  frames(n: number, before?: () => void): Promise<void>;
};
type Viewmodel = { warmUp(frames: number): void };

/** Raycast-only stand-ins: never drawn, so never compiled. */
const NEVER_DRAWN = /^(pieceHull|proxy):/;
const WARM_FRAMES = 3;
const GPU_IDLE_WAIT_MS = 3000;

/**
 * Shader/pipeline warm-up behind the loading screen, once the map, avatars and first snapshot are in.
 *
 * WebGPU pipelines are built the first time a material is drawn, and with Dawn/Metal that build stalls
 * the frame (~5-20 ms each, more on a busy GPU). Before this, the warm-up compiled only what the spawn
 * camera could see, against the wrong render target, and its "hidden frame" never drew the scene (the
 * post chain's scene pass renders once per animation frame), so turning around or the first shot,
 * placed piece or first-person switch compiled 15-20 pipelines in one frame (a 120+ ms hitch).
 * Now, with every object un-culled and every hidden pool shown, plus one of each mid-match prop:
 * 1. compileAsync the whole scene for the scene pass's own target/MRT/context (parallel, N/M progress);
 * 2. a few real frames in that state (shadow-pass pipelines, texture uploads, post chain, viewmodel rigs);
 * 3. restore, and wait for the GPU to finish everything submitted so the reveal starts on an idle queue.
 */
export async function warmUp(r: Renderer, loop: WarmLoop, fpv: Viewmodel, onStep: (frac: number, label: string) => void) {
  const t0 = performance.now();
  const gpu = r.gpu;
  onStep(0, 'Preparing materials');

  // One of every mid-match prop, just in front of the camera (inside the near shadow cascade).
  const props = r.warmProps();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion);
  props.position.copy(r.camera.position).addScaledVector(fwd, 4);
  props.quaternion.copy(r.camera.quaternion);
  r.scene.add(props);

  // Show everything: hidden pools (tracers, particles, flashes), culled/empty instanced meshes, far islands.
  const forced: THREE.Object3D[] = [], culled: THREE.Object3D[] = [];
  // empty instanced meshes (critter species before they spawn, thinned scatter, impostor chunks) draw nothing, so
  // nothing would compile their pipelines until mid-match: give each one instance for the warm-up
  const empty: { o: THREE.InstancedMesh | THREE.Mesh; count: number }[] = [];
  r.scene.traverse((o) => {
    if (NEVER_DRAWN.test(o.name)) return;
    if (!o.visible) forced.push(o);
    if (o.frustumCulled) culled.push(o);
    if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count === 0) empty.push({ o: o as THREE.InstancedMesh, count: 0 });
    const g = (o as THREE.Mesh).geometry as THREE.InstancedBufferGeometry | undefined;
    if (g?.isInstancedBufferGeometry && g.instanceCount === 0) empty.push({ o: o as THREE.Mesh, count: -1 });
  });
  const force = () => {
    for (const o of forced) o.visible = true;
    for (const o of culled) o.frustumCulled = false;
    for (const e of empty) {
      if (e.count === 0) (e.o as THREE.InstancedMesh).count = 1;
      else ((e.o as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).instanceCount = 1;
    }
  };
  force();

  let compiled = 0;
  try {
    const pass = r.world.sky.scenePass;
    if (!pass) throw new Error('no scene pass');
    // Borrow the renderer state the scene pass renders with (see PassNode.updateBefore), so the pipelines
    // are exactly the ones the real frames use; the frame loop doesn't draw meanwhile.
    type Ctx = { contextNode: unknown };
    type PassCtx = { _getContextNode(g: THREE.WebGPURenderer): unknown; contextNode: unknown };
    const size = gpu.getDrawingBufferSize(new THREE.Vector2());
    pass.setSize(size.x, size.y);
    const keep = { rt: gpu.getRenderTarget(), mrt: gpu.getMRT(), ctx: (gpu as unknown as Ctx).contextNode };
    loop.setPaused(true);
    try {
      gpu.setRenderTarget(pass.renderTarget);
      gpu.setMRT(pass.getMRT());
      if ((pass as unknown as PassCtx).contextNode) (gpu as unknown as Ctx).contextNode = (pass as unknown as PassCtx)._getContextNode(gpu);
      await gpu.compileAsync(r.scene, r.camera, null, (e) => {
        compiled = e.total;
        if (e.total > 0) onStep(0.05 + 0.6 * (e.loaded / e.total), `Compiling shaders ${e.loaded}/${e.total}`);
      });
    } finally {
      gpu.setRenderTarget(keep.rt);
      gpu.setMRT(keep.mrt);
      (gpu as unknown as Ctx).contextNode = keep.ctx;
      loop.setPaused(false);
    }
  } catch (err) {
    console.warn('[warmup] compileAsync failed; the warm frames below still build every pipeline', err);
  }

  onStep(0.7, 'Warming up the GPU');
  try {
    fpv.warmUp(WARM_FRAMES);
    await loop.frames(WARM_FRAMES, force);
  } finally {
    r.scene.remove(props);
    for (const o of forced) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
    for (const e of empty) { // only where the owner didn't set a real count meanwhile (critters spawn during warm frames)
      const g = (e.o as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
      if (e.count === 0) { if ((e.o as THREE.InstancedMesh).count === 1) (e.o as THREE.InstancedMesh).count = 0; }
      else if (g.instanceCount === 1) g.instanceCount = 0;
    }
    // A body LOD the game switched to during the warm frames was in `forced` (hidden at the start) and was just
    // hidden again, but the LOD cache says it's shown: re-apply (else the own avatar starts invisible).
    r.characters.relod();
    r.npcs.relod();
  }
  await loop.frames(1);
  onStep(0.9, 'Warming up the GPU');
  // Sync pipeline builds and texture uploads run in the GPU process: let them finish before the reveal.
  const device = (gpu.backend as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
  // Bounded: a GPU shared with other busy apps can take long, and the bar shouldn't sit still for it.
  if (device) {
    const t = performance.now();
    const idle = await Promise.race([device.queue.onSubmittedWorkDone().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), GPU_IDLE_WAIT_MS))]);
    console.info(`[warmup] GPU queue ${idle ? 'drained' : `still busy after ${GPU_IDLE_WAIT_MS} ms; revealing anyway`} (${Math.round(performance.now() - t)} ms)`);
  }
  onStep(1, 'Warming up the GPU');
  console.info(`[warmup] ${compiled} render objects compiled, ${forced.length} hidden + ${culled.length} culled objects warmed in ${Math.round(performance.now() - t0)} ms`);
}

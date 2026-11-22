import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * `world.step()` without its soft-body bookkeeping. This Rapier build's World.step ends with mapNewSoftBodies(),
 * which walks every collider handle through a wasm→JS callback each step to wrap colliders the engine created on
 * its own (soft-body tears). The sim's worlds have no soft bodies, so that walk only costs time: O(colliders) per
 * step, and the query and props worlds hold every static collider of the map (~13% of a bot match's CPU).
 * The physics step itself is the same pipeline call with the same arguments, so results are bit-identical
 * (tests/sim/rapierStep.test.ts pins that against world.step, so a Rapier bump that changes it fails loudly).
 */
export function stepWorld(w: RAPIER.World): void {
  const p = w.physicsPipeline;
  if (typeof p?.step !== 'function') throw new Error('stepWorld: this Rapier build has no world.physicsPipeline.step; use world.step()');
  p.step(w.gravity, w.integrationParameters, w.islands, w.broadPhase, w.narrowPhase, w.bodies,
    w.colliders, w.softBodies, w.impulseJoints, w.multibodyJoints, w.ccdSolver);
}

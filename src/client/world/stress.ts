import * as THREE from 'three/webgpu';

/**
 * Perf stress scene (debug only): `?debug=1&stress=3` multiplies every decorative prop (static dressing, scatter
 * detail, breakable cosmetics) by 3, each extra copy shifted a few metres, to prove headroom for incoming content.
 * Purely visual: collision, sim and gameplay are untouched.
 */
function readFactor(): number {
  if (typeof location === 'undefined') return 1;
  const q = new URLSearchParams(location.search);
  if (q.get('debug') !== '1') return 1;
  const f = Math.floor(Number(q.get('stress')));
  return Number.isFinite(f) && f > 1 ? Math.min(f, 6) : 1;
}

export const STRESS = readFactor();

/** Offsets (x, z, metres) of the extra copies; copy 0 is the original. */
const OFFSETS: [number, number][] = [[0, 0], [5.5, 3.5], [-4, -6.5], [7, -5], [-6.5, 5], [2.5, 8]];

export function stressOffsets(): [number, number][] {
  return OFFSETS.slice(0, STRESS);
}

/** Translation matrices for the extra copies (empty when not stressing). */
export function stressMatrices(): THREE.Matrix4[] {
  return stressOffsets().slice(1).map(([x, z]) => new THREE.Matrix4().makeTranslation(x, 0, z));
}

if (STRESS > 1) console.info(`[world/stress] decorative props ×${STRESS}`);

import { forkRng, isRng } from '../rng';

/**
 * Deep copy of an object graph for Match.fork: keeps prototypes (class instances stay instances), shared
 * references stay shared and cycles are fine (`memo` maps original → copy; pre-seed it with objects that
 * need a special copy, e.g. the physics world). Seeded generators (rng.ts) are forked so the copy continues
 * the same sequence independently. Any other function is shared as-is: it must not capture per-match state.
 */
export function deepClone<T>(v: T, memo: Map<unknown, unknown> = new Map()): T {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function' && isRng(v)) {
      const seen = memo.get(v);
      if (seen) return seen as T;
      const r = forkRng(v);
      memo.set(v, r);
      return r as T;
    }
    return v;
  }
  const seen = memo.get(v);
  if (seen !== undefined) return seen as T;
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length);
    memo.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = deepClone(v[i], memo);
    return out as T;
  }
  if (v instanceof Map) {
    const out = new Map();
    memo.set(v, out);
    for (const [k, x] of v) out.set(deepClone(k, memo), deepClone(x, memo));
    return out as T;
  }
  if (v instanceof Set) {
    const out = new Set();
    memo.set(v, out);
    for (const x of v) out.add(deepClone(x, memo));
    return out as T;
  }
  if (ArrayBuffer.isView(v)) {
    const out = (v as unknown as { slice(): unknown }).slice();
    memo.set(v, out);
    return out as T;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null && !isPlainClass(v)) {
    throw new Error(`deepClone: can't copy a ${proto?.constructor?.name ?? 'native'} object (add a special case or pre-seed the memo)`);
  }
  const out = Object.create(proto);
  memo.set(v, out);
  for (const k of Object.keys(v)) out[k] = deepClone((v as Record<string, unknown>)[k], memo);
  return out;
}

/** A user-defined class instance (its own enumerable fields are all its state), not a native/WASM wrapper. */
function isPlainClass(v: object): boolean {
  if ('__wbg_ptr' in v) return false; // a wasm-bindgen handle (Rapier): copying it would alias native memory
  return !(v instanceof Date || v instanceof RegExp || v instanceof Promise || v instanceof WeakMap || v instanceof WeakSet || v instanceof ArrayBuffer);
}

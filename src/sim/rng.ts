/**
 * Seeded PRNG (mulberry32). The state lives on the returned function (`rng.state`) so a match can be
 * copied mid-game (replay seeking: see Match.fork) and the copy draws the same numbers from there on.
 */
export type Rng = (() => number) & { readonly state: { a: number } };

export function mulberry32(seed: number): Rng {
  return rngFromState({ a: seed >>> 0 });
}

function rngFromState(state: { a: number }): Rng {
  const f = () => {
    state.a = (state.a + 0x6d2b79f5) >>> 0;
    let t = state.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(f, { state });
}

/** An independent generator continuing from `rng`'s current state. */
export function forkRng(rng: Rng): Rng {
  return rngFromState({ a: rng.state.a });
}

export function isRng(f: unknown): f is Rng {
  return typeof f === 'function' && typeof (f as Partial<Rng>).state?.a === 'number';
}

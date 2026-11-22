/**
 * Load-time feature switches for perf bisects (URL tokens, any page): `?nogroundao&noblob&nohemi&nohotbloom`.
 * Each turns one visual feature off for A/B runs (tests/visual/perfMatch.mjs --query=…). Never used by players.
 */
const Q = typeof location !== 'undefined' ? location.search : '';

export function perfOff(token: string): boolean {
  return new RegExp(`[?&]${token}(?:[=&]|$)`).test(Q);
}

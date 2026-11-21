import type { Snapshot } from '../types';

/** FNV-1a (32-bit) of a string. */
export function fnv1a(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fingerprint of everything a snapshot says about the match (exact floats, events included). Two runs
 * that agree on this every second agree on the match: replays store it to detect divergence.
 */
export function stateHash(snap: Snapshot): number {
  return fnv1a(JSON.stringify(snap));
}

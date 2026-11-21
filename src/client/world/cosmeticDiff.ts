/**
 * Which cosmetic instances to hide for a snapshot's `broken` list (ids broken so far, append-only within a
 * match). `hidden` is what is hidden right now. Fast path: same length ⇒ nothing new. If the list shrank
 * (a new match on the same map), `reset` asks the caller to show everything again before hiding `hide`.
 */
export function brokenDiff(hidden: ReadonlySet<number>, broken: readonly number[]): { hide: number[]; reset: boolean } {
  if (broken.length === hidden.size) return { hide: [], reset: false };
  if (broken.length < hidden.size) return { hide: [...broken], reset: true };
  const hide: number[] = [];
  for (const id of broken) if (!hidden.has(id)) hide.push(id);
  return { hide, reset: false };
}

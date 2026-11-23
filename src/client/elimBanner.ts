import type { MatchEvent } from '../sim/types';

/** What the HUD shows for an 'elimination' event (sim/elimination.ts): the banner (null = none) and the feed line. */
export type ElimView = { banner: { title: string; sub: string; mine: boolean } | null; feed: string; mine: boolean };

/**
 * Glory text (pure, unit-tested). `viewer`: the viewed player (you, or whoever you spectate); `name(id)` gives
 * 'You' for yourself. No banner for an uncredited elimination, nor for the viewer's own (the end screen says it).
 */
export function elimView(e: MatchEvent, viewer: number, name: (id: unknown) => string | null): ElimView | null {
  const d = e.data;
  if (typeof d.by !== 'number') return null;
  const by = name(d.by) ?? 'Someone', victim = name(d.victim) ?? 'Someone';
  const spoils = Number(d.spoils) || 0;
  const assistIds = (d.assists as number[] | undefined) ?? [];
  const assists = assistIds.map((id) => name(id)).filter(Boolean);
  const mine = d.by === viewer, assisted = assistIds.includes(viewer);
  const verb = d.how === 'trapped' ? 'sealed in' : 'eliminated';
  const feed = `${by} ${verb} ${victim}${spoils ? ` · +$${spoils}` : ''}${assists.length ? ` (assist: ${assists.join(', ')})` : ''}`;
  if (d.victim === viewer) return { banner: null, feed, mine };
  const cut = (d.shares as [number, number][] | undefined)?.find(([id]) => id === viewer)?.[1] ?? 0;
  const sub = mine ? `+$${spoils} spoils · victory surge` : assisted ? `Assist · +$${cut}` : `by ${by}${spoils ? ` · $${spoils} spoils` : ''}`;
  return { banner: { title: `${victim.toUpperCase()} ELIMINATED`, sub, mine }, feed, mine };
}

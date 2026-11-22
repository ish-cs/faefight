/**
 * Teams mode (GameSettings.teamMode). Free-for-all leaves PlayerState.team unset: everyone is their own side.
 *
 * Rules (docs in README "Teams"):
 * - Each player keeps their own island and bunker; teammates' islands sit next to each other on the ring
 *   (islandOrder), so a team holds one arc of the map.
 * - No friendly fire: an ally's bullets, explosions, fire, set-off barrels and traps never hurt you (your own
 *   rockets and grenades still do, as in free-for-all). Knockback from an ally's blast is dropped too.
 * - An ally's pieces never count toward sealing your bunker (sealBlocker), so teammates can't seal each other in.
 * - A team is out when all its players are eliminated; the last team with anyone left wins (match winner = one of
 *   its players). Storm and sudden death still finish matches.
 */

export type TeamMode = { id: number; name: string; size: number; teams: number };

/** Index = GameSettings.teamMode. size × teams = the seats the lobby fills (bots take open ones). */
export const TEAM_MODES: readonly TeamMode[] = Object.freeze([
  { id: 0, name: 'Free-for-all', size: 1, teams: 0 },
  { id: 1, name: '2v2v2v2', size: 2, teams: 4 },
  { id: 2, name: '3v3', size: 3, teams: 2 },
  { id: 3, name: '4v4', size: 4, teams: 2 },
]);

export const isTeamMode = (mode: number | undefined): boolean => !!mode && !!TEAM_MODES[mode];

/** Seats a team mode plays with (8, 6, 8); null for free-for-all. */
export const modeSeats = (mode: number | undefined): number | null => (isTeamMode(mode) ? TEAM_MODES[mode!].size * TEAM_MODES[mode!].teams : null);

/** Palette index (client ISLAND_COLORS) per team: Red, Blue, Green, Gold. */
export const TEAM_COLORS: readonly number[] = [0, 1, 2, 3];

/**
 * Same side? True for the same player too, so "isAlly(owner, victim)" also spares a trap's own owner. Free-for-all
 * players have no team: only the player themself is an ally. The single helper every friendly-fire rule uses.
 */
export function isAlly(a: { id: number; team?: number }, b: { id: number; team?: number }): boolean {
  return a.id === b.id || (a.team !== undefined && a.team === b.team);
}

/**
 * Team per player for a team mode (free-for-all: undefined each). A valid pick (0 ≤ pick < teams) is kept while that
 * team has room (the mode's size, or more when there are more players than seats); everyone else, in order, joins
 * the smallest team (lowest index on ties). Pure and deterministic: the lobby shows exactly what the sim plays.
 */
export function resolveTeams(picks: (number | null | undefined)[], mode: number | undefined): (number | undefined)[] {
  if (!isTeamMode(mode)) return picks.map(() => undefined);
  const m = TEAM_MODES[mode!];
  const k = Math.min(m.teams, Math.max(1, picks.length));
  const cap = Math.max(m.size, Math.ceil(picks.length / k));
  const count = new Array<number>(k).fill(0);
  const out: (number | undefined)[] = picks.map(() => undefined);
  picks.forEach((t, i) => {
    if (Number.isInteger(t) && (t as number) >= 0 && (t as number) < k && count[t as number] < cap) { out[i] = t as number; count[t as number]++; }
  });
  return out.map((t) => {
    if (t !== undefined) return t;
    let best = 0;
    for (let j = 1; j < k; j++) if (count[j] < count[best]) best = j;
    count[best]++;
    return best;
  });
}

/**
 * Island per player: players sorted by team (stable), so teammates get neighbouring islands on the ring. Free-for-all
 * (no teams) is the identity, island = player index.
 */
export function islandOrder(teams: (number | undefined)[]): number[] {
  const order = teams.map((t, i) => [t ?? i, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Array<number>(teams.length);
  order.forEach(([, i], island) => { out[i] = island; });
  return out;
}

/**
 * Sides still in the match (players not eliminated, grouped by team; a teamless player is a side of their own).
 * ≤ 1 side left ends the match.
 */
export function sidesLeft(players: Iterable<{ id: number; team?: number; eliminated: boolean }>): number {
  const sides = new Set<string>();
  for (const p of players) if (!p.eliminated) sides.add(p.team === undefined ? `p${p.id}` : `t${p.team}`);
  return sides.size;
}

/**
 * Does a piece count toward sealing the bunker of `owner`? Everyone's does, except a teammate's (your own still
 * does, as in free-for-all). `pieceOwner` undefined (a left player, the map) counts.
 */
export function sealBlocker(owner: { id: number; team?: number } | undefined, pieceOwner: { id: number; team?: number } | undefined): boolean {
  return !owner || !pieceOwner || pieceOwner.id === owner.id || !isAlly(owner, pieceOwner);
}

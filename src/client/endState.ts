export type EndState = { state: 'won' | 'lost' | 'draw'; title: string; sub: string };

/**
 * What the end-of-match screen shows, or null while you're still in it. winner -1 = draw; humanId 0 = spectator (no player).
 * Teams match: the winner is one player of the winning team; everyone on that team won ("Team 2 wins").
 */
export function endState(
  winner: number | null, humanId: number, eliminated: boolean, players: { id: number; name: string; team?: number }[],
): EndState | null {
  const w = winner !== null && winner > 0 ? players.find((p) => p.id === winner) : undefined;
  const who = w?.team !== undefined ? `Team ${w.team + 1}` : w?.name ?? 'Someone';
  if (humanId === 0) {
    if (winner === null || winner === -1) return winner === -1 ? { state: 'draw', title: 'DRAW', sub: 'The storm took everyone.' } : null;
    return { state: 'draw', title: 'MATCH OVER', sub: `${who} wins.` };
  }
  const me = players.find((p) => p.id === humanId);
  if (winner === humanId || (w && me && w.team !== undefined && w.team === me.team))
    return { state: 'won', title: 'VICTORY', sub: w?.team !== undefined ? 'Your team is the last one standing.' : 'Last one standing.' };
  if (winner === -1) return { state: 'draw', title: 'DRAW', sub: 'The storm took everyone.' };
  if (winner !== null)
    return { state: 'lost', title: eliminated ? 'ELIMINATED' : 'DEFEAT', sub: `${who} wins.` };
  if (eliminated) return { state: 'lost', title: 'ELIMINATED', sub: 'Your bunker was sealed when you died.' };
  return null;
}

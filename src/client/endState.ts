export type EndState = { state: 'won' | 'lost' | 'draw'; title: string; sub: string };

/** What the end-of-match screen shows, or null while you're still in it. winner -1 = draw; humanId 0 = spectator (no player). */
export function endState(
  winner: number | null, humanId: number, eliminated: boolean, players: { id: number; name: string }[],
): EndState | null {
  if (humanId === 0) {
    if (winner === null || winner === -1) return winner === -1 ? { state: 'draw', title: 'DRAW', sub: 'The tide took everyone.' } : null;
    return { state: 'draw', title: 'MATCH OVER', sub: `${players.find((p) => p.id === winner)?.name ?? 'Someone'} wins.` };
  }
  if (winner === humanId) return { state: 'won', title: 'VICTORY', sub: 'Last one standing.' };
  if (winner === -1) return { state: 'draw', title: 'DRAW', sub: 'The tide took everyone.' };
  if (winner !== null)
    return { state: 'lost', title: eliminated ? 'ELIMINATED' : 'DEFEAT', sub: `${players.find((p) => p.id === winner)?.name ?? 'Someone'} wins.` };
  if (eliminated) return { state: 'lost', title: 'ELIMINATED', sub: 'Your bunker was sealed when you died.' };
  return null;
}

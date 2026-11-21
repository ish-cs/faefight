import type { EmoteId } from '../emotes';
import type { MatchEvent, PlayerState } from '../types';

/**
 * Bots' flavour emote: pure flavour, never a rule. Bots never chat (no quick-chat lines); the only thing
 * they do is that the winner of a match, if a bot, sometimes waves or dances once the match is decided.
 * Its own random stream, so bots' combat choices don't shift when banter rolls dice.
 */
export const BANTER = {
  winnerEmoteChance: 0.4,
} as const;

type Pending = { at: number; id: number; what: EmoteId };

export class Banter {
  private pending: Pending[] = [];
  private ended = false;

  constructor(private readonly rng: () => number) {}

  /** This tick's events in; emotes due now out (the caller applies them, cooldown permitting). */
  onTick(events: readonly MatchEvent[], players: ReadonlyMap<number, PlayerState>, now: number): { id: number; what: EmoteId }[] {
    for (const e of events) {
      if (e.type !== 'win' || this.ended) continue;
      this.ended = true;
      const w = e.data.winner;
      const winner = typeof w === 'number' ? players.get(w) : undefined;
      if (winner?.isBot && this.rng() < BANTER.winnerEmoteChance) {
        this.pending.push({ at: now + 4.5 + this.rng() * 1.5, id: winner.id, what: this.rng() < 0.5 ? 'wave' : 'dance' });
      }
    }
    if (!this.pending.length) return [];
    const due = this.pending.filter((x) => x.at <= now);
    if (due.length) this.pending = this.pending.filter((x) => x.at > now);
    return due.map(({ id, what }) => ({ id, what }));
  }
}

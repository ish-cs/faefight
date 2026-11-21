import type { WheelId } from '../emotes';
import type { MatchEvent, PlayerState } from '../types';

/**
 * Bots' occasional quick chat and emotes: pure flavour, never a rule. Rare by design:
 * - match end: about half the bots say "GG" (staggered a few seconds), the winner sometimes waves or dances;
 * - after an even fight (the killer came out of it hurt): the bot that lost sometimes says "Nice shot!",
 *   a bot that won sometimes waves;
 * - at most one mid-match line across all bots per QUIET_SEC.
 * Its own random stream, so bots' combat choices don't shift when banter rolls dice.
 */
export const BANTER = {
  ggChance: 0.55,
  winnerEmoteChance: 0.4,
  niceShotChance: 0.12,
  waveChance: 0.05,
  /** Killer at or under this hp+shield = the fight was close. */
  evenFightHp: 50,
  quietSec: 20,
} as const;

type Pending = { at: number; id: number; what: WheelId };

export class Banter {
  private pending: Pending[] = [];
  private quietUntil = 0;
  private ended = false;

  constructor(private readonly rng: () => number) {}

  /** This tick's events in; wheel actions due now out (the caller applies them, cooldown permitting). */
  onTick(events: readonly MatchEvent[], players: ReadonlyMap<number, PlayerState>, now: number): { id: number; what: WheelId }[] {
    const bot = (id: unknown) => (typeof id === 'number' ? players.get(id) : undefined)?.isBot === true;
    for (const e of events) {
      if (e.type === 'win' && !this.ended) {
        this.ended = true;
        this.pending = []; // the match is over: only end-of-match lines now
        for (const p of players.values()) {
          if (p.isBot && this.rng() < BANTER.ggChance) this.pending.push({ at: now + 0.8 + this.rng() * 3.2, id: p.id, what: 'gg' });
        }
        const w = e.data.winner;
        if (bot(w) && this.rng() < BANTER.winnerEmoteChance) {
          this.pending.push({ at: now + 4.5 + this.rng() * 1.5, id: w as number, what: this.rng() < 0.5 ? 'wave' : 'dance' });
        }
      } else if (e.type === 'kill' && !this.ended && now >= this.quietUntil) {
        const killer = typeof e.data.killer === 'number' ? players.get(e.data.killer) : undefined;
        if (!killer || killer.id === e.data.victim || !killer.alive || killer.hp + killer.shield > BANTER.evenFightHp) continue;
        if (bot(e.data.victim) && this.rng() < BANTER.niceShotChance) {
          this.pending.push({ at: now + 0.6 + this.rng() * 0.8, id: e.data.victim as number, what: 'niceShot' });
          this.quietUntil = now + BANTER.quietSec;
        } else if (killer.isBot && this.rng() < BANTER.waveChance) {
          this.pending.push({ at: now + 1 + this.rng(), id: killer.id, what: 'wave' });
          this.quietUntil = now + BANTER.quietSec;
        }
      }
    }
    if (!this.pending.length) return [];
    const due = this.pending.filter((x) => x.at <= now);
    if (due.length) this.pending = this.pending.filter((x) => x.at > now);
    return due.map(({ id, what }) => ({ id, what }));
  }
}

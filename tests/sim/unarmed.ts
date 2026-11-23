import type { Match } from '../../src/sim/match';
import type { PlayerState } from '../../src/sim/types';
import { emptyHotbar } from '../../src/sim/hotbar';

/**
 * Takes the match-start pistol away from every player: for tests written around an empty starting
 * hotbar (slot indices, drops, cash math) whose subject is not the starting kit.
 */
export function unarmed(m: Match): void {
  for (const p of (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.values()) {
    delete p.inv.weapons.pistol;
    p.hotbar = emptyHotbar();
    p.selected = 0;
    p.equipped = 'fists';
  }
}

import { ECONOMY, PLAYER } from './constants';
import { emptyInventory } from './economy';
import type { PlayerState, Vec3 } from './types';
import { newMoveState } from './movement';
import { clone, v3 } from './vec';

export function newPlayer(id: number, name: string, isBot: boolean, island: number, pos: Vec3): PlayerState {
  const inv = emptyInventory();
  inv.cash = ECONOMY.startCash;
  return {
    id, name, isBot, island,
    pos: clone(pos), vel: v3(), yaw: 0, pitch: 0,
    hp: PLAYER.hp, alive: true, eliminated: false, respawnAt: null, breakoutUntil: null, invulnUntil: 0, lastDamagedAt: 0,
    inv, vault: emptyInventory(), equipped: 'fists',
    reloadUntil: 0, nextFireAt: 0, busyUntil: 0, mv: newMoveState(),
  };
}

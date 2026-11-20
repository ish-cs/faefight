import { ECONOMY, PLAYER } from './constants';
import { emptyInventory } from './economy';
import { emptyHotbar } from './hotbar';
import type { PlayerState, Vec3 } from './types';
import { newMoveState } from './movement';
import { clone, v3 } from './vec';

export function newPlayer(id: number, name: string, isBot: boolean, island: number, pos: Vec3): PlayerState {
  const inv = emptyInventory();
  inv.cash = ECONOMY.startCash;
  return {
    id, name, isBot, island,
    pos: clone(pos), vel: v3(), yaw: 0, pitch: 0,
    hp: PLAYER.hp, shield: 0, alive: true, eliminated: false, kills: 0, deaths: 0, respawnAt: null, breakoutUntil: null, invulnUntil: 0, lastDamagedAt: 0,
    inv, vault: emptyInventory(), hotbar: emptyHotbar(), selected: 0, equipped: 'fists', healAt: null, drinking: null, healLeft: 0, speedUntil: 0,
    reloadUntil: 0, nextFireAt: 0, busyUntil: 0, mv: newMoveState(),
  };
}

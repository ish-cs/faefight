import { ECONOMY, PLAYER, WEAPONS } from './constants';
import { emptyInventory } from './economy';
import { addKind, emptyHotbar } from './hotbar';
import type { PlayerState, Vec3 } from './types';
import { newMoveState } from './movement';
import { clone, v3 } from './vec';

export function newPlayer(id: number, name: string, isBot: boolean, island: number, pos: Vec3, startCash: number = ECONOMY.startCash): PlayerState {
  const inv = emptyInventory();
  inv.cash = startCash;
  // Everyone starts with a pistol + one spare mag in slot 1, in hand (same kit as a respawn).
  inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: WEAPONS.pistol.mag };
  const hotbar = emptyHotbar();
  addKind(hotbar, 'pistol');
  return {
    id, name, isBot, island,
    pos: clone(pos), vel: v3(), yaw: 0, pitch: 0,
    hp: PLAYER.hp, shield: 0, alive: true, eliminated: false, kills: 0, deaths: 0, respawnAt: null, breakoutUntil: null, invulnUntil: 0, lastDamagedAt: 0,
    inv, vault: emptyInventory(), locked: [], hotbar, selected: 0, equipped: 'pistol', healAt: null, drinking: null, healLeft: 0, speedUntil: 0,
    reloadUntil: 0, reloadSec: 0, reloadMag: 0, nextFireAt: 0, busyUntil: 0, mv: newMoveState(), stamina: 100, ads: false, bloom: 0, lastShotAt: -1e9, burst: 0,
  };
}

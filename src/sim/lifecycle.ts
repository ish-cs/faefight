import { LIFECYCLE, MAP, PLAYER } from './constants';
import { emptyInventory, mergeInventory } from './economy';
import type { IslandLayout } from './map';
import type { Physics } from './physics';
import { isSealed } from './seal';
import type { Inventory, LootBag, MatchEvent, PieceState, PlayerState } from './types';
import { clone, dist, v3 } from './vec';

export type MatchStateCore = {
  time: number;
  players: Map<number, PlayerState>;
  pieces: Map<number, PieceState>;
  loot: Map<number, LootBag>;
  generators: { island: number; stored: number }[];
  waterY: number;
  suddenDeath: boolean;
  forcedSeal: boolean;
  /** Winning player id, -1 for a draw, null while the match is running. */
  winner: number | null;
  nextId: number;
};

export function newMatchState(map: IslandLayout[]): MatchStateCore {
  return {
    time: 0,
    players: new Map(),
    pieces: new Map(),
    loot: new Map(),
    generators: map.map((i) => ({ island: i.index, stored: 0 })),
    waterY: MAP.waterY,
    suddenDeath: false,
    forcedSeal: false,
    winner: null,
    nextId: 1,
  };
}

const ev = (t: number, type: MatchEvent['type'], data: Record<string, unknown>): MatchEvent => ({ t, type, data });
const PARKED = v3(0, -1000, 0);

const isEmpty = (inv: Inventory) =>
  inv.cash === 0 && inv.grenades === 0 && inv.charges === 0 &&
  Object.keys(inv.weapons).length === 0 && Object.values(inv.pieces).every((n) => !n);

export function killPlayer(
  s: MatchStateCore, physics: Physics, victimId: number, now: number, inWater: boolean, killer: number | null = null,
): MatchEvent[] {
  const p = s.players.get(victimId);
  if (!p) throw new Error(`killPlayer: no player ${victimId}`);
  if (!p.alive) return [];
  if (!inWater && !isEmpty(p.inv)) {
    const id = s.nextId++;
    s.loot.set(id, { id, pos: clone(p.pos), inv: p.inv });
  }
  p.inv = emptyInventory();
  p.equipped = 'fists';
  p.reloadUntil = 0;
  p.hp = 0;
  p.alive = false;
  p.vel = v3();
  p.respawnAt = now + LIFECYCLE.respawnSec;
  physics.setPlayerPos(victimId, PARKED);
  return [ev(now, 'kill', { victim: victimId, killer, inWater })];
}

export function islandSealed(s: MatchStateCore, map: IslandLayout[], island: number): boolean {
  return s.forcedSeal || isSealed(map[island].bunker, [...s.pieces.values()]);
}

export function tickLifecycle(s: MatchStateCore, physics: Physics, map: IslandLayout[], now: number, dt: number): MatchEvent[] {
  const out: MatchEvent[] = [];

  if (!s.suddenDeath && now >= LIFECYCLE.suddenDeathAt) {
    s.suddenDeath = true;
    s.forcedSeal = true;
    out.push(ev(now, 'suddenDeath', {}));
  }
  if (s.suddenDeath) s.waterY += LIFECYCLE.tideRate * dt;

  for (const p of s.players.values())
    if (p.alive && p.pos.y < s.waterY) out.push(...killPlayer(s, physics, p.id, now, true));

  for (const bag of [...s.loot.values()]) {
    if (bag.pos.y < s.waterY) { s.loot.delete(bag.id); continue; }
    for (const p of s.players.values()) {
      if (!p.alive || dist(p.pos, bag.pos) > LIFECYCLE.lootPickupRadius) continue;
      mergeInventory(p.inv, bag.inv);
      s.loot.delete(bag.id);
      break;
    }
  }

  for (const p of s.players.values()) {
    if (p.alive || p.eliminated || p.respawnAt === null || now < p.respawnAt) continue;
    p.respawnAt = null;
    if (islandSealed(s, map, p.island)) {
      p.eliminated = true;
      out.push(ev(now, 'eliminated', { player: p.id }));
      continue;
    }
    const spawn = map[p.island].spawn;
    p.pos = clone(spawn);
    p.hp = PLAYER.hp;
    p.alive = true;
    p.invulnUntil = now + LIFECYCLE.invulnSec;
    physics.setPlayerPos(p.id, spawn);
  }

  if (s.winner === null && s.players.size >= 2) {
    const left = [...s.players.values()].filter((p) => !p.eliminated);
    if (left.length <= 1) {
      s.winner = left[0]?.id ?? -1;
      out.push(ev(now, 'win', { winner: s.winner }));
    }
  }
  return out;
}

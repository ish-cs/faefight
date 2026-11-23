import { GRAPPLE, LIFECYCLE, MAP, PLAYER, SEAL, WEAPONS } from './constants';
import { emptyInventory, grantLockedGuns, mergeInventory } from './economy';
import { addKind, countOf, emptyHotbar, heldKinds, isGunItem, takeOut } from './hotbar';
import { spawnYaw, type IslandLayout } from './map';
import type { Physics } from './physics';
import { refillStamina, STAMINA } from './movement';
import { isSealed } from './seal';
import { sealBlocker, sidesLeft } from './teams';
import { restockFromVault } from './vault';
import { newStorm, type StormCenter, type StormState } from './storm';
import type { Inventory, LootBag, MatchEvent, PieceState, PlayerState, Vec3 } from './types';
import { clone, dist, dist2D, rotateY, v3 } from './vec';

export type MatchStateCore = {
  time: number;
  players: Map<number, PlayerState>;
  pieces: Map<number, PieceState>;
  loot: Map<number, LootBag>;
  generators: { island: number; stored: number }[];
  /** Generator level (1-4) by island index; bought at the owner's shop, kept for the whole match. */
  genLevels: number[];
  waterY: number;
  suddenDeath: boolean;
  forcedSeal: boolean;
  /** Sudden-death storm (null until sudden death). */
  storm: StormState | null;
  /** Match seed (the storm's lightning stream is derived from it). */
  seed: number;
  /** Where the storm closes in (the centre island; Match sets it from the MapDef). */
  stormCenter: StormCenter;
  /** Winning player id, -1 for a draw, null while the match is running. */
  winner: number | null;
  nextId: number;
  /** Practice range (practice.ts): no sudden death, no breakout countdown, no result. */
  practice?: boolean;
};

export function newMatchState(map: IslandLayout[], seed = 1): MatchStateCore {
  return {
    time: 0,
    players: new Map(),
    pieces: new Map(),
    loot: new Map(),
    generators: map.map((i) => ({ island: i.index, stored: 0 })),
    genLevels: map.map(() => 1),
    waterY: MAP.waterY,
    suddenDeath: false,
    forcedSeal: false,
    storm: null,
    seed,
    stormCenter: { x: 0, z: 0, r: 0 },
    winner: null,
    nextId: 1,
  };
}

const ev = (t: number, type: MatchEvent['type'], data: Record<string, unknown>): MatchEvent => ({ t, type, data });
const PARKED = v3(0, -1000, 0);

const isEmpty = (inv: Inventory) =>
  inv.cash === 0 && inv.grenades === 0 && inv.charges === 0 && inv.medkits === 0 && !inv.traps && !inv.grapples && Object.values(inv.potions).every((n) => !n) &&
  Object.keys(inv.weapons).length === 0 && Object.values(inv.pieces).every((n) => !n);

/**
 * Moves what fits from a loot bag into a player's inventory: cash always, kinds the player already
 * holds, and new kinds while hotbar slots are free. Returns true when the bag is now empty.
 */
export function pickUp(p: PlayerState, bag: Inventory, ammoOnly = false): boolean {
  const got = emptyInventory();
  got.cash = bag.cash;
  bag.cash = 0;
  mergeInventory(p.inv, got);
  for (const kind of heldKinds(bag)) {
    // Crate ammo: only for someone who owns that gun (it goes to their spare rounds).
    if (ammoOnly && isGunItem(kind) && !p.inv.weapons[kind]) continue;
    if (countOf(p.inv, kind) === 0 && addKind(p.hotbar, kind) < 0) continue;
    const taken = takeOut(bag, kind, 'stack');
    if (taken) mergeInventory(p.inv, taken);
  }
  return isEmpty(bag);
}

/**
 * Who gets the kill for a death by the environment (water, a fall, the storm): the last player who hurt `p` or
 * broke the piece they stood on, if that was within LIFECYCLE.envCreditSec. Null when nobody.
 */
export function envKiller(s: MatchStateCore, p: PlayerState, now: number): number | null {
  const h = p.hurtBy;
  return h && h.by !== p.id && now - h.at <= LIFECYCLE.envCreditSec && s.players.has(h.by) ? h.by : null;
}

export function killPlayer(
  s: MatchStateCore, physics: Physics, victimId: number, now: number, inWater: boolean, killer: number | null = null,
  /** What killed them when it wasn't a player ('storm', 'lightning'); recorded on the kill event. */
  cause?: string,
  /** What set it off when it wasn't the killer's own weapon (e.g. 'barrel'): the feed says "X via barrel". */
  via?: string,
): MatchEvent[] {
  const p = s.players.get(victimId);
  if (!p) throw new Error(`killPlayer: no player ${victimId}`);
  if (!p.alive) return [];
  // The drop bag's id rides on the kill event (elimination.ts takes the spoils' share of its cash).
  let bag: number | undefined;
  if (!inWater && !isEmpty(p.inv)) {
    bag = s.nextId++;
    s.loot.set(bag, { id: bag, pos: clone(p.pos), inv: p.inv });
  }
  p.inv = emptyInventory();
  p.hotbar = emptyHotbar();
  p.healAt = null;
  p.shield = 0;
  p.drinking = null;
  p.healLeft = 0;
  p.speedUntil = 0;
  delete p.surgeUntil;
  p.equipped = 'fists';
  p.reloadUntil = 0;
  p.reloadSec = 0;
  p.ads = false;
  p.hp = 0;
  p.alive = false;
  p.vel = v3();
  delete p.yankedBy;
  delete p.hurtBy;
  p.deaths++;
  const k = killer !== null && killer !== victimId ? s.players.get(killer) : undefined;
  if (k) k.kills++;
  if (p.breakoutUntil !== null) {
    // Died while trapped in a sealed bunker: no more respawns.
    p.breakoutUntil = null;
    p.respawnAt = null;
    p.eliminated = true;
    physics.setPlayerPos(victimId, PARKED);
    const kill = { victim: victimId, killer, inWater, ...(cause ? { cause } : {}), ...(via ? { via } : {}), ...(bag !== undefined ? { bag } : {}) };
    return [ev(now, 'kill', kill), ev(now, 'eliminated', { player: victimId })];
  }
  p.respawnAt = now + LIFECYCLE.respawnSec;
  physics.setPlayerPos(victimId, PARKED);
  return [ev(now, 'kill', { victim: victimId, killer, inWater, ...(cause ? { cause } : {}), ...(via ? { via } : {}), ...(bag !== undefined ? { bag } : {}) })];
}

/**
 * Seal checks are a flood fill, and the escape countdown asks every tick for anyone standing near their bunker:
 * cache per island until the set of pieces changes. Ids only ever grow, so (count, id sum) identifies the set.
 */
const sealCache = new WeakMap<MatchStateCore, { count: number; sum: number; byIsland: Map<number, boolean> }>();

export function islandSealed(s: MatchStateCore, map: IslandLayout[], island: number): boolean {
  if (s.forcedSeal) return true;
  let sum = 0;
  for (const id of s.pieces.keys()) sum += id;
  let c = sealCache.get(s);
  if (!c || c.count !== s.pieces.size || c.sum !== sum) {
    c = { count: s.pieces.size, sum, byIsland: new Map() };
    sealCache.set(s, c);
  }
  let sealed = c.byIsland.get(island);
  if (sealed === undefined) {
    sealed = isSealed(map[island].bunker, sealPieces(s, island));
    c.byIsland.set(island, sealed);
  }
  return sealed;
}

/** Pieces that count toward sealing this island's bunker: all but its owner's teammates' (teams.ts sealBlocker). */
export function sealPieces(s: MatchStateCore, island: number): PieceState[] {
  let owner: PlayerState | undefined;
  for (const p of s.players.values()) if (p.island === island) { owner = p; break; }
  const all = [...s.pieces.values()];
  return owner?.team === undefined ? all : all.filter((pc) => sealBlocker(owner, s.players.get(pc.owner)));
}

/** The spawn point, or the nearest free spot inside the bunker if a piece sits on it. */
export function freeSpawnSpot(physics: Physics, isl: IslandLayout): Vec3 {
  const half = v3(PLAYER.radius + 0.01, PLAYER.height / 2 - 0.05, PLAYER.radius + 0.01);
  const free = (p: Vec3) =>
    physics.overlapsBox(v3(p.x, p.y + PLAYER.height / 2 + 0.05, p.z), half, 0).every((h) => h.type === 'player');
  const lim = MAP.bunker.interior / 2 - PLAYER.radius - 0.05;
  const spots: Vec3[] = [];
  for (let x = -lim; x <= lim + 1e-6; x += 0.35)
    for (let z = -lim; z <= lim + 1e-6; z += 0.35) spots.push(v3(x, 0, z));
  spots.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  const sp = isl.spawn;
  if (free(sp)) return sp;
  for (const o of spots) {
    const r = rotateY(o, isl.bunker.facingYaw);
    const p = v3(sp.x + r.x, sp.y, sp.z + r.z);
    if (free(p)) return p;
  }
  return sp;
}

export function tickLifecycle(
  s: MatchStateCore, physics: Physics, map: IslandLayout[], now: number, dt: number,
  suddenDeathAt: number = LIFECYCLE.suddenDeathAt,
): MatchEvent[] {
  const out: MatchEvent[] = [];

  if (!s.practice && !s.suddenDeath && now >= suddenDeathAt) {
    s.suddenDeath = true;
    s.forcedSeal = true;
    s.storm = newStorm(map, s.stormCenter, suddenDeathAt, s.seed);
    out.push(ev(now, 'suddenDeath', {}));
  }

  // Drowned: a grappling hook yank just before it makes it the yanker's kill ("X via grapple"); else a player
  // who hurt them or broke their floor just before ("X via water").
  for (const p of s.players.values()) {
    if (!p.alive || p.pos.y >= s.waterY) continue;
    const y = p.yankedBy;
    const yank = y && now - y.at <= GRAPPLE.yankCreditSec && y.by !== p.id ? y.by : null;
    const by = yank ?? envKiller(s, p, now);
    out.push(...killPlayer(s, physics, p.id, now, true, by, undefined, yank !== null ? 'grapple' : by !== null ? 'water' : undefined));
  }

  for (const p of s.players.values())
    if (p.alive && p.hp < PLAYER.hp && now - p.lastDamagedAt >= LIFECYCLE.regenDelaySec)
      p.hp = Math.min(PLAYER.hp, p.hp + LIFECYCLE.regenPerSec * dt);

  for (const bag of [...s.loot.values()]) {
    if (bag.pos.y < s.waterY) { s.loot.delete(bag.id); continue; }
    for (const p of s.players.values()) {
      if (!p.alive || dist(p.pos, bag.pos) > LIFECYCLE.lootPickupRadius) continue;
      if (bag.noPickup && bag.noPickup.id === p.id && now < bag.noPickup.until) continue;
      if (pickUp(p, bag.inv, bag.ammoOnly)) { s.loot.delete(bag.id); break; }
    }
  }

  for (const p of s.players.values()) {
    if (p.alive || p.eliminated || p.respawnAt === null || now < p.respawnAt) continue;
    p.respawnAt = null;
    // Sudden death seals every bunker for good (nothing to break): no respawn at all.
    if (s.forcedSeal) {
      p.eliminated = true;
      out.push(ev(now, 'eliminated', { player: p.id }));
      continue;
    }
    // Physically sealed: respawn inside anyway, with a short window to break out.
    if (islandSealed(s, map, p.island)) {
      p.breakoutUntil = now + LIFECYCLE.breakoutSec;
      out.push(ev(now, 'trapped', { player: p.id, until: p.breakoutUntil }));
    }
    const spawn = freeSpawnSpot(physics, map[p.island]);
    p.pos = clone(spawn);
    p.hp = PLAYER.hp;
    p.shield = 0;
    p.alive = true;
    if (p.mv) refillStamina(p.mv);
    p.stamina = STAMINA.max;
    grantLockedGuns(p);
    // The vault refills the hotbar to the player's restock loadout (sim/vault.ts).
    const rs = restockFromVault(p);
    if (rs && rs.moved + rs.bought + rs.cash > 0) out.push(ev(now, 'restock', { player: p.id, ...rs }));
    // Come back with a pistol + one spare mag so a camper with a rifle isn't a guaranteed kill.
    if (!p.inv.weapons.pistol && addKind(p.hotbar, 'pistol') >= 0) p.inv.weapons.pistol = { mag: WEAPONS.pistol.mag, spare: WEAPONS.pistol.mag };
    // Face out through the bunker's front doorway from wherever the free spot put us; level the view.
    p.yaw = spawnYaw(map[p.island].bunker, spawn);
    p.pitch = 0;
    out.push(ev(now, 'spawn', { player: p.id, yaw: p.yaw }));
    p.invulnUntil = now + LIFECYCLE.spawnProtectMaxSec;
    p.spawnProtected = true;
    physics.setPlayerPos(p.id, spawn);
  }

  for (const p of s.players.values()) {
    if (!p.alive) continue;
    const bunker = map[p.island].bunker.center;
    // Spawn protection runs out invulnSec after you step out of your bunker.
    if (p.spawnProtected && dist2D(p.pos, bunker) > SEAL.exitRadius) {
      p.invulnUntil = Math.min(p.invulnUntil, now + LIFECYCLE.invulnSec);
      p.spawnProtected = false;
    }
    // Inside your own bunker while it's sealed (however you got there): the escape clock starts.
    if (!s.practice && p.breakoutUntil === null && dist2D(p.pos, bunker) <= SEAL.exitRadius && islandSealed(s, map, p.island)) {
      p.breakoutUntil = now + LIFECYCLE.breakoutSec;
      out.push(ev(now, 'trapped', { player: p.id, until: p.breakoutUntil }));
      continue;
    }
    if (p.breakoutUntil === null) continue;
    if (dist2D(p.pos, bunker) > SEAL.exitRadius) {
      p.breakoutUntil = null;
      out.push(ev(now, 'escaped', { player: p.id }));
    } else if (now >= p.breakoutUntil) {
      out.push(...killPlayer(s, physics, p.id, now, false));
    }
  }

  if (!s.practice && s.winner === null && s.players.size >= 2) {
    const left = [...s.players.values()].filter((p) => !p.eliminated);
    // Last side standing: one player in free-for-all, one team in a teams match (winner = one of its players).
    if (sidesLeft(left) <= 1) {
      s.winner = left[0]?.id ?? -1;
      out.push(ev(now, 'win', { winner: s.winner }));
    }
  }
  return out;
}

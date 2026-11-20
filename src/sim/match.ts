import { buy, collect, mergeInventory, emptyInventory, startMedkit, tickGenerator, tickHealing, vaultTransfer } from './economy';
import { damagePiece, snapPlacement, validatePlacement, type Placement } from './building';
import { applyPlayerDamage, placeCharge, throwGrenade, tickExplosives, tickReload, tryFire, tryReload, eyePos, type CombatCtx, type Explosive } from './combat';
import { DT, ECONOMY, LIFECYCLE, PIECES, PLAYER } from './constants';
import { equippedFor, isGunItem, swapSlots, syncFromInventory, takeOut, validSlot } from './hotbar';
import { islandSealed, killPlayer, newMatchState, tickLifecycle, type MatchStateCore } from './lifecycle';
import { buildMapDef, type IslandLayout, type MapDef } from './map';
import { collectGold, collectSupply, inShieldWell, newCenterState, refillShield, tickCenter, type CenterState } from './center';
import { Cosmetics } from './cosmetics';
import type { MatchApi, MatchSetup } from './matchApi';
import { Physics } from './physics';
import { unsupportedPieces } from './support';
import { newPlayer } from './player';
import { isPlaceholderBotName, nickname } from './names';
import type { BotView, FeedLine, HurtEvent, ShotSeen } from './bots/view';
import { Bot } from './bots/bot';
import type { BuildRequest, Difficulty, Inventory, MatchEvent, PlayerInput, PlayerState, Snapshot, Vec3, WeaponKind } from './types';
import { NO_INPUT } from './types';
import { add, clone, dist, dist2D, forward, norm, right, scale, sub, v3 } from './vec';

export type BotBrain = { think(view: BotView): PlayerInput };
export type MatchOptions = { makeBot?: (id: number, difficulty: Difficulty, rng: () => number) => BotBrain };

const MAX_PITCH = 1.4;
const SIGHT_RANGE = 120;
/** How long hits/tracers stay in a bot's short-term memory, and how long the kill feed is. */
const RECENT_SEC = 4;
const FEED_SEC = 30;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Match implements MatchApi {
  private s: MatchStateCore;
  private tickNo = 0;
  private events: MatchEvent[] = [];
  private explosives: Explosive[] = [];
  private grounded = new Map<number, boolean>();
  private bots = new Map<number, BotBrain>();
  private rng: () => number;
  private makeBot?: MatchOptions['makeBot'];
  private sealed: boolean[];
  private sealDirty = true;
  private supportDirty = false;
  private kills: { victim: number; killer: number | null }[] = [];
  private ctx: CombatCtx;
  /** Public recent history a human would have on screen: hits, tracers, kill feed, scoreboard. */
  private hits: (HurtEvent & { target: number })[] = [];
  private shots: ShotSeen[] = [];
  private feed: FeedLine[] = [];
  private killCount = new Map<number, number>();
  readonly map: IslandLayout[];
  private center: CenterState = newCenterState();
  private cosmetics: Cosmetics;

  private constructor(readonly def: MapDef, private physics: Physics, setup: MatchSetup, opts: MatchOptions) {
    const map = def.islands;
    this.map = map;
    this.cosmetics = new Cosmetics(def.cosmetics);
    this.s = newMatchState(map);
    this.s.waterY = def.waterY;
    this.sealed = map.map(() => false);
    const rng = mulberry32(setup.seed ?? 1);
    this.rng = rng;
    this.makeBot = opts.makeBot;
    // Bot seats with a placeholder name ("Bot (hard)") get a human-looking nickname; a separate stream so
    // names don't shift the bots' own random choices.
    const nameRng = mulberry32(((setup.seed ?? 1) * 2654435761) ^ 0x5bd1e995);
    const taken = new Set(setup.players.filter((c) => !(c.isBot && isPlaceholderBotName(c.name))).map((c) => c.name.toLowerCase()));
    setup.players.forEach((cfg, i) => {
      const id = i + 1;
      const name = cfg.isBot && isPlaceholderBotName(cfg.name) ? nickname(nameRng, taken) : cfg.name;
      const p = newPlayer(id, name, cfg.isBot, i, map[i].spawn);
      p.yaw = map[i].bunker.facingYaw;
      this.s.players.set(id, p);
      physics.addPlayer(id, p.pos);
      if (cfg.isBot && opts.makeBot) {
        this.bots.set(id, opts.makeBot(id, cfg.difficulty ?? 'medium', rng));
      }
    });
    this.ctx = {
      physics,
      players: this.s.players,
      pieces: this.s.pieces,
      explosives: this.explosives,
      nextId: () => this.s.nextId++,
      onPieceDestroyed: (id) => {
        this.s.pieces.delete(id);
        physics.removePiece(id);
        this.sealDirty = true;
        this.supportDirty = true;
      },
      onKill: (victim, killer) => {
        this.kills.push({ victim, killer });
        this.events.push(...killPlayer(this.s, physics, victim, this.s.time, false, killer));
      },
    };
  }

  static async create(
    setup: MatchSetup,
    opts: MatchOptions = { makeBot: (id, difficulty, rng) => new Bot(id, difficulty, rng) },
  ): Promise<Match> {
    const n = setup.players.length;
    if (n < 2 || n > 8) throw new Error(`Match.create: need 2..8 players, got ${n}`);
    const def = buildMapDef(n, setup.map ?? 'harbor', setup.seed ?? 1);
    return new Match(def, await Physics.create(def), setup, opts);
  }

  humanIds(): number[] {
    return [...this.s.players.values()].filter((p) => !p.isBot).map((p) => p.id);
  }

  tick(inputs: Map<number, PlayerInput>): Snapshot {
    const now = this.s.time + DT;
    this.s.time = now;
    this.tickNo++;
    this.events = [];

    for (const p of this.s.players.values()) {
      if (!p.alive) continue;
      const bot = this.bots.get(p.id);
      const input = bot ? bot.think(this.botView(p)) : inputs.get(p.id) ?? NO_INPUT;
      this.applyInput(p, input, now);
    }

    this.events.push(...tickExplosives(this.ctx, now));
    this.collapseUnsupported(now);
    for (const g of this.s.generators) g.stored = tickGenerator(g.stored, DT, !this.s.suddenDeath);
    tickCenter(this.center, DT, !this.s.suddenDeath);
    for (const p of this.s.players.values()) if (p.alive && inShieldWell(this.def.center, p.pos)) refillShield(p, DT);
    this.events.push(...this.cosmetics.onEvents(this.events, now));
    this.events.push(...tickLifecycle(this.s, this.physics, this.map, now, DT, this.def.tideRate));
    // Items used up, picked up or lost this tick: keep every hotbar (and the hand) in step with inv.
    for (const p of this.s.players.values()) { tickHealing(p, now); this.syncHand(p); }
    this.updateSeals(now);
    this.remember(now);
    return this.snapshot();
  }

  previewBuild(playerId: number, req: BuildRequest): Placement {
    const p = this.mustPlayer(playerId);
    const snapped = snapPlacement(req.pos, req.rotY, req.free);
    return validatePlacement(this.physics, req.kind, snapped.pos, snapped.rotY, p.pos);
  }

  /** Hand a seat to a bot (e.g. a friend disconnected). */
  setBot(playerId: number, difficulty: Difficulty): void {
    const p = this.mustPlayer(playerId);
    if (!this.makeBot) throw new Error('Match.setBot: no bot factory configured');
    p.isBot = true;
    this.bots.set(playerId, this.makeBot(playerId, difficulty, this.rng));
  }

  /** Pieces left with nothing holding them up fall apart (no floating bridges or walls). */
  private collapseUnsupported(now: number) {
    if (!this.supportDirty) return;
    this.supportDirty = false;
    for (const id of unsupportedPieces(this.physics, this.s.pieces)) {
      const p = this.s.pieces.get(id)!;
      this.s.pieces.delete(id);
      this.physics.removePiece(id);
      this.sealDirty = true;
      const pos = v3(p.pos.x, p.pos.y + PIECES[p.kind].h / 2, p.pos.z);
      this.events.push({ t: now, type: 'destroyed', data: { piece: id, kind: p.kind, pos, rotY: p.rotY, collapse: true } });
    }
  }

  debugDamagePlayer(playerId: number, amount: number): void {
    this.events.push(...applyPlayerDamage(this.ctx, this.mustPlayer(playerId), amount, null, this.s.time));
  }

  /** Every kill so far (tests/debug). */
  debugKills(): { victim: number; killer: number | null }[] {
    return this.kills;
  }

  debugDamagePiece(pieceId: number, amount: number): void {
    const p = this.s.pieces.get(pieceId);
    if (!p) throw new Error(`Match.debugDamagePiece: no piece ${pieceId}`);
    if (damagePiece(p, amount, 'explosive')) this.ctx.onPieceDestroyed(pieceId);
  }

  debugTeleport(playerId: number, pos: Vec3): void {
    const p = this.mustPlayer(playerId);
    p.pos = clone(pos);
    p.vel = v3();
    this.physics.setPlayerPos(playerId, pos);
  }

  debugGive(playerId: number, inv: Partial<Inventory>): void {
    const p = this.mustPlayer(playerId);
    mergeInventory(p.inv, { ...emptyInventory(), ...inv });
    const overflow = syncFromInventory(p.hotbar, p.inv);
    if (overflow.length) console.warn(`debugGive: hotbar full, ${overflow.join(', ')} carried without a slot`);
  }

  debugSetHp(playerId: number, hp: number): void {
    if (!Number.isFinite(hp) || hp <= 0) throw new Error(`debugSetHp: hp must be > 0, got ${hp}`);
    this.mustPlayer(playerId).hp = Math.min(PLAYER.hp, hp);
  }

  debugKill(playerId: number): void {
    this.events.push(...killPlayer(this.s, this.physics, playerId, this.s.time, false));
  }

  private applyInput(p: PlayerState, input: PlayerInput, now: number) {
    p.yaw = input.yaw;
    p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, input.pitch));

    if (input.moveSlot) swapSlots(p.hotbar, input.moveSlot.from, input.moveSlot.to);
    if (validSlot(input.select)) p.selected = input.select;
    if (input.slot) this.selectWeapon(p, input.slot);
    this.syncHand(p);

    this.move(p, input);
    if (input.drop) this.drop(p, input.drop, now);

    tickReload(p, now);
    if (now < p.busyUntil) return;
    const isl = this.map[p.island];
    const near = (pt: Vec3) => dist2D(p.pos, pt) <= ECONOMY.interactRadius && Math.abs(p.pos.y - pt.y) < 2;

    if (input.interact) {
      for (const g of this.s.generators) if (near(this.map[g.island].generator)) collect(p, g);
      const c = this.def.center;
      if (near(c.goldGen)) {
        const cash = collectGold(p, this.center);
        if (cash > 0) this.events.push({ t: now, type: 'centerCollect', data: { by: p.id, station: 'gold', cash } });
      }
      if (near(c.supplyGen)) {
        const got = collectSupply(p, this.center);
        if (got.sandbags + got.steel > 0) this.events.push({ t: now, type: 'centerCollect', data: { by: p.id, station: 'supply', ...got } });
      }
    }
    if (input.shop && near(isl.shop)) buy(p, input.shop);
    if (input.vault && near(isl.vault) && vaultTransfer(p, input.vault).ok) p.busyUntil = now + ECONOMY.vaultSec;
    if (input.reload) tryReload(p, now);
    if (input.fire) this.events.push(...tryFire(this.ctx, p, now));
    if (input.throwGrenade) throwGrenade(this.ctx, p, now);
    if (input.placeCharge) placeCharge(this.ctx, p, now);
    if (input.useMedkit) startMedkit(p, now);
    if (input.build) this.build(p, input.build, now);
    this.syncHand(p);
  }

  /** Legacy weapon pick (bots): select the slot holding that gun, or a non-gun slot for fists. */
  private selectWeapon(p: PlayerState, w: WeaponKind) {
    if (w === 'fists') {
      if (!isGunItem(p.hotbar[p.selected])) return;
      const free = p.hotbar.indexOf(null);
      const at = free >= 0 ? free : p.hotbar.findIndex((k) => !isGunItem(k));
      if (at >= 0) p.selected = at;
      return;
    }
    const at = p.hotbar.indexOf(w);
    if (at >= 0) p.selected = at;
  }

  /** Hotbar follows the inventory; the hand follows the selected slot. */
  private syncHand(p: PlayerState) {
    syncFromInventory(p.hotbar, p.inv);
    const e = equippedFor(p.hotbar, p.selected);
    if (e !== p.equipped) {
      p.equipped = e;
      p.reloadUntil = 0;
    }
  }

  /** Drops from the selected slot as a loot bag just in front of the player (on the ground there, else at their feet). */
  private drop(p: PlayerState, amount: 'one' | 'stack', now: number) {
    const kind = p.hotbar[p.selected];
    if (!kind) return;
    const inv = takeOut(p.inv, kind, amount);
    if (!inv) return;
    this.syncHand(p);
    const f = forward(p.yaw);
    const ax = p.pos.x + f.x * LIFECYCLE.dropAhead, az = p.pos.z + f.z * LIFECYCLE.dropAhead;
    const ground = this.physics.isGroundAt(ax, az);
    const pos = ground !== null && Math.abs(ground - p.pos.y) <= 1 ? v3(ax, ground, az) : clone(p.pos);
    const id = this.s.nextId++;
    this.s.loot.set(id, { id, pos, inv, noPickup: { id: p.id, until: now + LIFECYCLE.dropPickupDelaySec } });
  }

  private move(p: PlayerState, input: PlayerInput) {
    let dir = add(scale(forward(p.yaw), input.moveZ), scale(right(p.yaw), input.moveX));
    const l = Math.hypot(dir.x, dir.z);
    if (l > 1) dir = scale(dir, 1 / l);
    const speed = input.sprint ? PLAYER.sprint : PLAYER.walk;
    const grounded = this.grounded.get(p.id) ?? false;
    p.vel.x = dir.x * speed;
    p.vel.z = dir.z * speed;
    p.vel.y = grounded && input.jump ? PLAYER.jumpVelocity : p.vel.y - PLAYER.gravity * DT;
    const r = this.physics.movePlayer(p.id, scale(p.vel, DT));
    p.pos = r.pos;
    this.grounded.set(p.id, r.grounded);
    const impact = -p.vel.y;
    if (!grounded && r.grounded && impact > LIFECYCLE.safeFallSpeed)
      this.events.push(...applyPlayerDamage(this.ctx, p, (impact - LIFECYCLE.safeFallSpeed) * LIFECYCLE.fallDmgPerSpeed, null, this.s.time));
    if (r.grounded && p.vel.y < 0) p.vel.y = 0;
  }

  private build(p: PlayerState, req: BuildRequest, now: number) {
    if ((p.inv.pieces[req.kind] ?? 0) <= 0) return;
    const snapped = snapPlacement(req.pos, req.rotY, req.free);
    const r = validatePlacement(this.physics, req.kind, snapped.pos, snapped.rotY, p.pos);
    if (!r.ok) return;
    const id = this.s.nextId++;
    const piece = { id, kind: req.kind, owner: p.id, pos: r.pos, rotY: snapped.rotY, hp: PIECES[req.kind].hp };
    this.s.pieces.set(id, piece);
    this.physics.addPiece(piece);
    p.inv.pieces[req.kind]! -= 1;
    if (p.inv.pieces[req.kind] === 0) delete p.inv.pieces[req.kind];
    p.busyUntil = now + PIECES[req.kind].placeSec;
    this.sealDirty = true;
    this.events.push({ t: now, type: 'placed', data: { piece: id, kind: req.kind, by: p.id } });
  }

  private updateSeals(now: number) {
    if (!this.sealDirty && !this.s.forcedSeal) return;
    this.sealDirty = false;
    this.map.forEach((isl, i) => {
      const sealed = islandSealed(this.s, this.map, i);
      if (sealed !== this.sealed[i])
        this.events.push({ t: now, type: sealed ? 'sealed' : 'unsealed', data: { island: i } });
      this.sealed[i] = sealed;
    });
  }

  private remember(now: number) {
    for (const e of this.events) {
      const d = e.data;
      if (e.type === 'hit') this.hits.push({ t: e.t, target: d.target as number, by: (d.by as number | null) ?? null, amount: d.amount as number });
      else if (e.type === 'shot') this.shots.push({ t: e.t, by: d.by as number, from: d.from as Vec3, to: d.to as Vec3 });
      else if (e.type === 'kill') {
        const killer = (d.killer as number | null) ?? null, victim = d.victim as number;
        this.feed.push({ t: e.t, killer, victim });
        if (killer !== null && killer !== victim) this.killCount.set(killer, (this.killCount.get(killer) ?? 0) + 1);
      }
    }
    const keep = <T extends { t: number }>(xs: T[], sec: number) => (xs.length && xs[0].t < now - sec ? xs.filter((x) => x.t >= now - sec) : xs);
    this.hits = keep(this.hits, RECENT_SEC);
    this.shots = keep(this.shots, RECENT_SEC);
    this.feed = keep(this.feed, FEED_SEC);
  }

  private botView(self: PlayerState): BotView {
    const eye = eyePos(self);
    const enemies: PlayerState[] = [];
    for (const o of this.s.players.values()) {
      if (o.id === self.id || !o.alive) continue;
      const chest = v3(o.pos.x, o.pos.y + 1.2, o.pos.z);
      const d = dist(eye, chest);
      if (d > SIGHT_RANGE) continue;
      const hit = this.physics.raycast(eye, norm(sub(chest, eye)), d + 0.5, self.id);
      if (hit?.hit.type === 'player' && hit.hit.id === o.id) enemies.push(o);
    }
    return {
      now: this.s.time,
      self,
      enemies,
      others: [...this.s.players.values()].filter((o) => o.id !== self.id)
        .map((o) => ({ id: o.id, island: o.island, alive: o.alive, eliminated: o.eliminated, respawnAt: o.respawnAt, kills: this.killCount.get(o.id) ?? 0 })),
      map: this.map,
      center: { island: this.def.center, gold: this.center.gold, bags: this.center.bags, steel: this.center.steel },
      statics: this.def.statics,
      pieces: [...this.s.pieces.values()],
      generators: this.s.generators.map((g) => g.stored),
      sealed: [...this.sealed],
      hurt: this.hits.filter((h) => h.target === self.id).map(({ t, by, amount }) => ({ t, by, amount })),
      shots: this.shots.filter((s) => s.by !== self.id && dist(s.from, eye) <= SIGHT_RANGE),
      feed: [...this.feed],
      loot: [...this.s.loot.values()].filter((b) => dist(b.pos, eye) <= SIGHT_RANGE).map((b) => clone(b.pos)),
      waterY: this.s.waterY,
      suddenDeath: this.s.suddenDeath,
      groundAt: (x, z) => this.physics.isGroundAt(x, z),
      canPlace: (kind, pos, rotY) => validatePlacement(this.physics, kind, pos, rotY, self.pos),
    };
  }

  private snapshot(): Snapshot {
    return structuredClone({
      time: this.s.time,
      tick: this.tickNo,
      players: [...this.s.players.values()],
      pieces: [...this.s.pieces.values()],
      loot: [...this.s.loot.values()],
      generators: this.s.generators,
      center: { gold: this.center.gold, bags: this.center.bags, steel: this.center.steel },
      broken: this.cosmetics.broken,
      sealed: this.sealed,
      waterY: this.s.waterY,
      suddenDeath: this.s.suddenDeath,
      winner: this.s.winner,
      events: this.events,
    });
  }

  private mustPlayer(id: number) {
    const p = this.s.players.get(id);
    if (!p) throw new Error(`Match: no player ${id}`);
    return p;
  }
}

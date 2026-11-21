import { buyAt, collect, isHomeOnly, mergeInventory, emptyInventory, startMedkit, tickGenerator, tickHealing, vaultTransfer } from './economy';
import { damagePiece, snapPlacement, validatePlacement, type Placement } from './building';
import { applyPlayerDamage, placeCharge, projectiles, throwGrenade, tickExplosives, tickReload, tryFire, tryReload, eyePos, type CombatCtx, type Explosive } from './combat';
import { BUILD, DT, ECONOMY, LIFECYCLE, PIECES, PLAYER, SHIELD_MAX, SEAL } from './constants';
import { equippedFor, isGunItem, swapSlots, syncFromInventory, takeOut, validSlot } from './hotbar';
import { islandSealed, killPlayer, newMatchState, tickLifecycle, type MatchStateCore } from './lifecycle';
import { buildMapDef, type IslandLayout, type MapDef } from './map';
import { collectGold, collectSupply, inShieldWell, newCenterState, refillShield, tickCenter, type CenterState } from './center';
import { Cosmetics } from './cosmetics';
import { potionShopsAt, speedMult, startDrink, tickPotions } from './potions';
import type { MatchApi, MatchSetup } from './matchApi';
import { Physics, type RayHit } from './physics';
import { HitboxHistory, LAG_COMP, rayPlayer } from './lagComp';
import { newMoveState, stepMove, type MoveCmd } from './movement';
import { adsMoveCmd, adsSpeed } from './gunplay';
import { unsupportedPieces } from './support';
import { newPlayer } from './player';
import { MatchStats } from './stats';
import { isPlaceholderBotName, nickname } from './names';
import type { BotView, FeedLine, HurtEvent, ShotSeen } from './bots/view';
import { Bot } from './bots/bot';
import type { BotBrainInfo, BuildRequest, Difficulty, Inventory, MatchEvent, PieceKind, PlayerInput, PlayerState, PotionShop, Snapshot, Vec3, WeaponKind } from './types';
import { NO_INPUT } from './types';
import { clone, dist, dist2D, forward, norm, sub, v3 } from './vec';

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
  /** End-screen totals (damage, seals, pieces, cash, longest life). */
  private stats = new MatchStats();

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
  readonly map: IslandLayout[];
  private center: CenterState = newCenterState();
  private cosmetics: Cosmetics;
  /** Potion sellers: the NPC on the center island. */
  potionShops: PotionShop[];
  /** Recent player hitboxes, and the time the shot being resolved right now is rewound to (lagComp.ts). */
  private history = new HitboxHistory();
  private rewindT: number | null = null;
  /** Per player: a build request waiting for the busy time from the last placement to end (see applyInput). */
  private queuedBuild = new Map<number, { req: BuildRequest; until: number }>();
  /**
   * Snapshots are deep copies by default (callers may keep or mutate them). The worker turns this off:
   * postMessage copies the snapshot anyway, synchronously, so the extra copy is pure cost.
   */
  cloneSnapshots = true;
  /** Lag-compensated shots resolved so far, and the total rewind (tests/debug). */
  lagStats = { shots: 0, rewindSec: 0 };

  private constructor(readonly def: MapDef, private physics: Physics, setup: MatchSetup, opts: MatchOptions) {
    const map = def.islands;
    this.map = map;
    this.cosmetics = new Cosmetics(def.cosmetics);
    this.potionShops = potionShopsAt([def.center.potionShop]);
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
      grounded: (id) => this.s.players.get(id)?.mv?.grounded ?? false,
      onKnockback: (id, dv) => {
        // The movement model keeps momentum (fully in the air, braking on the ground), so a blast is just a
        // velocity change; an upward one lifts you off the ground (rocket jump).
        const p = this.s.players.get(id);
        if (!p) return;
        p.vel.x += dv.x; p.vel.z += dv.z;
        p.vel.y = Math.max(p.vel.y, 0) + dv.y;
        if (dv.y > 0 && p.mv) { p.mv.grounded = false; p.mv.airTime = 1; }
      },
      castShot: (o, d, max, shooter) => (this.rewindT === null ? physics.raycast(o, d, max, shooter, true) : this.rewoundRay(o, d, max, shooter, this.rewindT)),
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

  /**
   * moves: per human player, the movement commands to apply this tick (client-numbered, for
   * prediction/reconciliation). A player without an entry moves one step from its PlayerInput.
   */
  tick(inputs: Map<number, PlayerInput>, moves?: Map<number, MoveCmd[]>): Snapshot {
    const now = this.s.time + DT;
    this.s.time = now;
    this.tickNo++;
    this.events = [];

    for (const p of this.s.players.values()) {
      const cmds = this.bots.has(p.id) ? undefined : moves?.get(p.id);
      if (!p.alive) {
        // Dead: commands are consumed (acked) but do nothing.
        if (cmds?.length) (p.mv ??= newMoveState()).ack = cmds[cmds.length - 1].seq;
        continue;
      }
      const bot = this.bots.get(p.id);
      const input = bot ? bot.think(this.botView(p)) : inputs.get(p.id) ?? NO_INPUT;
      this.applyInput(p, input, now, cmds);
    }

    this.events.push(...tickExplosives(this.ctx, now));
    this.collapseUnsupported(now);
    for (const g of this.s.generators) g.stored = tickGenerator(g.stored, DT, !this.s.suddenDeath, this.s.genLevels[g.island] ?? 1);
    tickCenter(this.center, DT, !this.s.suddenDeath);
    for (const p of this.s.players.values()) if (p.alive && inShieldWell(this.def.center, p.pos)) refillShield(p, DT);
    this.events.push(...this.cosmetics.onEvents(this.events, now));
    this.events.push(...tickLifecycle(this.s, this.physics, this.map, now, DT, this.def.tideRate));
    // Items used up, picked up or lost this tick: keep every hotbar (and the hand) in step with inv.
    for (const p of this.s.players.values()) { tickHealing(p, now); tickPotions(p, now, DT); this.syncHand(p); }
    this.updateSeals(now);
    this.remember(now);
    this.stats.onTick(this.events, this.s.players.values(), now);
    this.history.record(now, this.s.players.values());
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

  /** A seat's human came back (reconnect grace): drop the bot; their movement numbering starts over. */
  setHuman(playerId: number): void {
    const p = this.mustPlayer(playerId);
    this.bots.delete(playerId);
    p.isBot = false;
    if (p.mv) p.mv.ack = 0;
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

  /** Put a piece exactly here, skipping placement rules (tests). */
  debugPlacePiece(kind: PieceKind, pos: Vec3, rotY: number, owner = 0): number {
    const id = this.s.nextId++;
    const piece = { id, kind, owner, pos: clone(pos), rotY, hp: PIECES[kind].hp };
    this.s.pieces.set(id, piece);
    this.physics.addPiece(piece);
    this.sealDirty = true;
    return id;
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

  debugSetShield(playerId: number, shield: number): void {
    if (!Number.isFinite(shield) || shield < 0) throw new Error(`debugSetShield: shield must be >= 0, got ${shield}`);
    this.mustPlayer(playerId).shield = Math.min(SHIELD_MAX, shield);
  }

  /** Move the potion sellers (tests/e2e, and until the map places the real one). */
  debugSetPotionShops(positions: Vec3[]): void {
    this.potionShops = potionShopsAt(positions);
    this.physics.setPotionShops(positions);
  }

  debugKill(playerId: number): void {
    this.events.push(...killPlayer(this.s, this.physics, playerId, this.s.time, false));
  }

  /** Kill (if alive) and eliminate for good: no respawn. The win check runs on the next tick. */
  debugEliminate(playerId: number): void {
    const p = this.mustPlayer(playerId);
    this.events.push(...killPlayer(this.s, this.physics, playerId, this.s.time, false));
    if (p.eliminated) return;
    p.eliminated = true;
    p.respawnAt = null;
    p.breakoutUntil = null;
    this.events.push({ t: this.s.time, type: 'eliminated', data: { player: playerId } });
  }

  private applyInput(p: PlayerState, input: PlayerInput, now: number, cmds?: MoveCmd[]) {
    p.yaw = input.yaw;
    p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, input.pitch));

    if (input.moveSlot) swapSlots(p.hotbar, input.moveSlot.from, input.moveSlot.to);
    if (validSlot(input.select)) p.selected = input.select;
    if (input.slot) this.selectWeapon(p, input.slot);
    this.syncHand(p);
    // Sights need a gun in hand and no reload; aiming rules out sprinting (see move).
    p.ads = input.ads && p.alive && p.equipped !== 'fists' && p.reloadUntil === 0;

    if (cmds) {
      for (const c of cmds) {
        if (p.alive) this.move(p, c); // a hard landing can kill mid-batch
        else p.mv!.ack = c.seq;
      }
    }
    else this.move(p, { seq: p.mv?.ack ?? 0, moveX: input.moveX, moveZ: input.moveZ, yaw: input.yaw, jump: input.jump, sprint: input.sprint });
    if (input.drop) this.drop(p, input.drop, now);

    tickReload(p, now);
    // A build sent while still busy (a held-place stream arriving a little bunched) waits for the busy time
    // to end instead of being dropped; it expires after BUILD.queueSec. The newest request wins.
    if (input.build) this.queuedBuild.set(p.id, { req: input.build, until: now + BUILD.queueSec });
    if (now < p.busyUntil) return;
    const isl = this.map[p.island];
    const near = (pt: Vec3) => dist2D(p.pos, pt) <= ECONOMY.interactRadius && Math.abs(p.pos.y - pt.y) < 2;

    if (input.interact) {
      for (const g of this.s.generators) if (near(this.map[g.island].generator)) {
        const before = p.inv.cash;
        collect(p, g);
        this.stats.earned(p.id, p.inv.cash - before);
      }
      const c = this.def.center;
      if (near(c.goldGen)) {
        const cash = collectGold(p, this.center);
        if (cash > 0) {
          this.stats.earned(p.id, cash);
          this.events.push({ t: now, type: 'centerCollect', data: { by: p.id, station: 'gold', cash } });
        }
      }
      if (near(c.supplyGen)) {
        const got = collectSupply(p, this.center);
        if (got.sandbags + got.steel > 0) this.events.push({ t: now, type: 'centerCollect', data: { by: p.id, station: 'supply', ...got } });
      }
    }
    // Shop NPCs serve anyone standing at them, on any island (vaults stay owner-only); potions only at the
    // potion seller; generator upgrades and gun locks only at your own island's shop.
    if (input.shop) {
      if (near(isl.shop)) buyAt(p, 'home', input.shop, this.s.genLevels);
      else if (this.map.some((i) => near(i.shop))) { if (!isHomeOnly(input.shop.buy)) buyAt(p, 'home', input.shop); }
      else if (this.potionShops.some((sh) => near(sh.pos))) buyAt(p, 'potion', input.shop);
    }
    if (input.vault && near(isl.vault) && vaultTransfer(p, input.vault).ok) p.busyUntil = now + ECONOMY.vaultSec;
    if (input.reload) tryReload(p, now);
    // Attacking ends spawn protection at once.
    if ((input.fire || input.throwGrenade || input.placeCharge) && (p.spawnProtected || p.invulnUntil > now)) {
      p.invulnUntil = Math.min(p.invulnUntil, now);
      p.spawnProtected = false;
    }
    if (input.fire) {
      this.rewindT = this.rewindTime(p, input, now);
      try { this.events.push(...tryFire(this.ctx, p, now)); } finally { this.rewindT = null; }
    }
    if (input.throwGrenade) throwGrenade(this.ctx, p, now);
    if (input.placeCharge) placeCharge(this.ctx, p, now);
    if (input.useMedkit) startMedkit(p, now);
    if (input.drink) startDrink(p, now);
    const queued = this.queuedBuild.get(p.id);
    if (queued) {
      this.queuedBuild.delete(p.id);
      if (now <= queued.until) this.build(p, queued.req, now);
    }
    this.syncHand(p);
  }

  /**
   * When a human fires, what time to resolve the shot at: the time of the world they were looking at
   * (input.viewT), never more than LAG_COMP.maxRewindSec back and never past the last finished tick
   * (no client has seen anything newer); null = now (bots, no viewT).
   */
  private rewindTime(p: PlayerState, input: PlayerInput, now: number): number | null {
    const vt = input.viewT;
    const newest = this.history.newest;
    if (this.bots.has(p.id) || typeof vt !== 'number' || !Number.isFinite(vt) || newest === null) return null;
    const t = Math.min(newest, Math.max(vt, now - LAG_COMP.maxRewindSec));
    this.lagStats.shots++;
    this.lagStats.rewindSec += now - t;
    return t;
  }

  /** A shot ray against the world as it is now and every other player where they were at time t. */
  private rewoundRay(o: Vec3, d: Vec3, maxDist: number, shooter: number, t: number): RayHit | null {
    let best = this.physics.raycastStatic(o, d, maxDist);
    let lim = best ? best.dist : maxDist;
    const feet = v3();
    for (const q of this.s.players.values()) {
      if (q.id === shooter || !q.alive || !this.history.at(t, q.id, feet)) continue;
      const h = rayPlayer(o, d, feet, lim);
      if (!h) continue;
      lim = h.dist;
      best = { dist: h.dist, point: v3(o.x + d.x * h.dist, o.y + d.y * h.dist, o.z + d.z * h.dist), hit: { type: 'player', id: q.id }, part: h.part };
    }
    return best;
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
      p.reloadSec = 0;
      p.reloadMag = 0;
      p.ads = false;
      p.burst = 0;
      p.bloom = 0;
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

  private move(p: PlayerState, cmd: MoveCmd) {
    const mv = (p.mv ??= newMoveState());
    // Sights up: slower, and no sprinting (the client's prediction applies the same rule: adsMoveCmd).
    const { landingSpeed } = stepMove(p as PlayerState & { mv: typeof mv }, adsMoveCmd(p, cmd), DT, { movePlayer: (d) => this.physics.movePlayer(p.id, d) },
      speedMult(p, this.s.time) * adsSpeed(p));
    mv.ack = cmd.seq;
    p.stamina = mv.stamina;
    if (landingSpeed > LIFECYCLE.safeFallSpeed)
      this.events.push(...applyPlayerDamage(this.ctx, p, (landingSpeed - LIFECYCLE.safeFallSpeed) * LIFECYCLE.fallDmgPerSpeed, null, this.s.time, { bypassShield: true, weapon: 'fall' }));
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
      if (sealed !== this.sealed[i]) {
        const owner = [...this.s.players.values()].find((p) => p.island === i)?.id ?? null;
        // Credit the seal to whoever placed the newest piece around that bunker (null in sudden death).
        let by: number | null = null, newest = -1;
        if (sealed && !this.s.forcedSeal)
          for (const pc of this.s.pieces.values())
            if (pc.id > newest && dist2D(pc.pos, isl.bunker.center) <= SEAL.half) { newest = pc.id; by = pc.owner; }
        this.events.push({ t: now, type: sealed ? 'sealed' : 'unsealed', data: { island: i, owner, by } });
      }
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
      const hit = this.physics.raycast(eye, norm(sub(chest, eye)), d + 0.5, self.id, true); // sight passes firing slits
      if (hit?.hit.type === 'player' && hit.hit.id === o.id) enemies.push(o);
    }
    return {
      now: this.s.time,
      self,
      enemies,
      others: [...this.s.players.values()].filter((o) => o.id !== self.id)
        .map((o) => ({ id: o.id, island: o.island, alive: o.alive, eliminated: o.eliminated, respawnAt: o.respawnAt, kills: o.kills })),
      map: this.map,
      center: { island: this.def.center, gold: this.center.gold, bags: this.center.bags, steel: this.center.steel },
      statics: this.def.statics,
      pieces: [...this.s.pieces.values()],
      generators: this.s.generators.map((g) => g.stored),
      genLevels: [...this.s.genLevels],
      sealed: [...this.sealed],
      hurt: this.hits.filter((h) => h.target === self.id).map(({ t, by, amount }) => ({ t, by, amount })),
      shots: this.shots.filter((s) => s.by !== self.id && dist(s.from, eye) <= SIGHT_RANGE),
      feed: [...this.feed],
      loot: [...this.s.loot.values()].filter((b) => dist(b.pos, eye) <= SIGHT_RANGE).map((b) => clone(b.pos)),
      waterY: this.s.waterY,
      suddenDeath: this.s.suddenDeath,
      potionShops: this.potionShops.map((sh) => clone(sh.pos)),
      groundAt: (x, z) => this.physics.isGroundAt(x, z),
      canPlace: (kind, pos, rotY) => validatePlacement(this.physics, kind, pos, rotY, self.pos),
    };
  }

  private snapshot(): Snapshot {
    const s: Snapshot = {
      time: this.s.time,
      tick: this.tickNo,
      players: [...this.s.players.values()],
      pieces: [...this.s.pieces.values()],
      loot: [...this.s.loot.values()],
      projectiles: projectiles(this.explosives),
      generators: this.s.generators,
      center: { gold: this.center.gold, bags: this.center.bags, steel: this.center.steel },
      broken: this.cosmetics.broken,
      genLevels: this.s.genLevels,
      sealed: this.sealed,
      waterY: this.s.waterY,
      suddenDeath: this.s.suddenDeath,
      winner: this.s.winner,
      potionShops: this.potionShops,
      brains: this.brainInfos(),
      events: this.events,
      // Totals only once there's a result: keeps the per-tick snapshot (and the network budget) unchanged.
      ...(this.s.winner !== null ? { stats: this.stats.totals(this.s.players.values(), this.s.time) } : {}),
    };
    return this.cloneSnapshots ? structuredClone(s) : s;
  }

  /** Each bot's thinking for spectators (whatever the bot exposes: the brain's debug view, else its current action). */
  private brainInfos(): BotBrainInfo[] {
    const out: BotBrainInfo[] = [];
    for (const [id, brain] of this.bots) {
      const b = brain as BotBrain & Partial<{
        personality: { archetype: string }; difficulty: Difficulty; currentGoal: string; currentTarget: number | null;
        planScores: { goal: string; score: number }[];
        debug: {
          action: string; goal: string | null; reason: string; fightOdds: number | null; thought: string; stepIndex: number; step: string;
          target: number | null; options?: { goal: string; score: number }[];
        };
        currentPlan: { steps: { label: string }[]; step: number } | null;
      }>;
      const d = b.debug;
      const plan = b.currentPlan ?? null;
      const action = d?.action ?? b.currentGoal ?? 'idle';
      out.push({
        id, personality: b.personality?.archetype ?? 'Bot', difficulty: b.difficulty ?? 'medium', action,
        goal: d?.goal ?? null, reason: d?.reason ?? '',
        steps: plan ? plan.steps.map((s) => s.label) : d?.step ? [d.step] : [],
        step: plan ? plan.step : d?.step ? 0 : -1,
        fightOdds: d?.fightOdds ?? null,
        target: d?.target ?? b.currentTarget ?? null,
        options: (d?.options ?? b.planScores ?? []).slice(0, 4).map((o) => ({ goal: o.goal, score: Math.round(o.score * 100) / 100 })),
        thought: d?.thought || `Doing: ${action}`,
      });
    }
    return out;
  }

  private mustPlayer(id: number) {
    const p = this.s.players.get(id);
    if (!p) throw new Error(`Match: no player ${id}`);
    return p;
  }
}

import { buy, collect, mergeInventory, emptyInventory, tickGenerator, vaultTransfer } from './economy';
import { snapPlacement, validatePlacement, type Placement } from './building';
import { placeCharge, throwGrenade, tickExplosives, tickReload, tryFire, tryReload, eyePos, type CombatCtx, type Explosive } from './combat';
import { DT, ECONOMY, PIECES, PLAYER } from './constants';
import { islandSealed, killPlayer, newMatchState, tickLifecycle, type MatchStateCore } from './lifecycle';
import { buildMap, type IslandLayout } from './map';
import type { MatchApi, MatchSetup } from './matchApi';
import { Physics } from './physics';
import { newPlayer } from './player';
import type { BotView } from './bots/view';
import type { BuildRequest, Difficulty, Inventory, MatchEvent, PlayerInput, PlayerState, Snapshot, Vec3 } from './types';
import { NO_INPUT } from './types';
import { add, clone, dist, dist2D, forward, norm, right, scale, sub, v3 } from './vec';

export type BotBrain = { think(view: BotView): PlayerInput };
export type MatchOptions = { makeBot?: (id: number, difficulty: Difficulty, rng: () => number) => BotBrain };

const MAX_PITCH = 1.4;
const SIGHT_RANGE = 120;

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
  private sealed: boolean[];
  private sealDirty = true;
  private ctx: CombatCtx;

  private constructor(readonly map: IslandLayout[], private physics: Physics, setup: MatchSetup, opts: MatchOptions) {
    this.s = newMatchState(map);
    this.sealed = map.map(() => false);
    const rng = mulberry32(setup.seed ?? 1);
    setup.players.forEach((cfg, i) => {
      const id = i + 1;
      const p = newPlayer(id, cfg.name, cfg.isBot, i, map[i].spawn);
      p.yaw = map[i].bunker.facingYaw;
      this.s.players.set(id, p);
      physics.addPlayer(id, p.pos);
      if (cfg.isBot && opts.makeBot) this.bots.set(id, opts.makeBot(id, cfg.difficulty ?? 'medium', rng));
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
      },
      onKill: (victim, killer) => {
        this.events.push(...killPlayer(this.s, physics, victim, this.s.time, false, killer));
      },
    };
  }

  static async create(setup: MatchSetup, opts: MatchOptions = {}): Promise<Match> {
    const n = setup.players.length;
    if (n < 2 || n > 8) throw new Error(`Match.create: need 2..8 players, got ${n}`);
    const map = buildMap(n);
    return new Match(map, await Physics.create(map), setup, opts);
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
    for (const g of this.s.generators) g.stored = tickGenerator(g.stored, DT, !this.s.suddenDeath);
    this.events.push(...tickLifecycle(this.s, this.physics, this.map, now, DT));
    this.updateSeals(now);
    return this.snapshot();
  }

  previewBuild(playerId: number, req: BuildRequest): Placement {
    const p = this.mustPlayer(playerId);
    const snapped = snapPlacement(req.pos, req.rotY, req.free);
    return validatePlacement(this.physics, req.kind, snapped.pos, snapped.rotY, p.pos);
  }

  debugTeleport(playerId: number, pos: Vec3): void {
    const p = this.mustPlayer(playerId);
    p.pos = clone(pos);
    p.vel = v3();
    this.physics.setPlayerPos(playerId, pos);
  }

  debugGive(playerId: number, inv: Partial<Inventory>): void {
    mergeInventory(this.mustPlayer(playerId).inv, { ...emptyInventory(), ...inv });
  }

  debugKill(playerId: number): void {
    this.events.push(...killPlayer(this.s, this.physics, playerId, this.s.time, false));
  }

  private applyInput(p: PlayerState, input: PlayerInput, now: number) {
    p.yaw = input.yaw;
    p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, input.pitch));

    if (input.slot && input.slot !== p.equipped && (input.slot === 'fists' || p.inv.weapons[input.slot])) {
      p.equipped = input.slot;
      p.reloadUntil = 0;
    }

    this.move(p, input);

    tickReload(p, now);
    if (now < p.busyUntil) return;
    const isl = this.map[p.island];
    const near = (pt: Vec3) => dist2D(p.pos, pt) <= ECONOMY.interactRadius && Math.abs(p.pos.y - pt.y) < 2;

    if (input.interact)
      for (const g of this.s.generators) if (near(this.map[g.island].generator)) collect(p, g);
    if (input.shop && near(isl.shop)) buy(p, input.shop);
    if (input.vault && near(isl.vault) && vaultTransfer(p, input.vault).ok) p.busyUntil = now + ECONOMY.vaultSec;
    if (input.reload) tryReload(p, now);
    if (input.fire) this.events.push(...tryFire(this.ctx, p, now));
    if (input.throwGrenade) throwGrenade(this.ctx, p, now);
    if (input.placeCharge) placeCharge(this.ctx, p, now);
    if (input.build) this.build(p, input.build, now);
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
        .map((o) => ({ id: o.id, island: o.island, alive: o.alive, eliminated: o.eliminated, respawnAt: o.respawnAt })),
      map: this.map,
      pieces: [...this.s.pieces.values()],
      generators: this.s.generators.map((g) => g.stored),
      sealed: [...this.sealed],
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

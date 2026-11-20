/**
 * Stand-in for src/sim/match.ts while the real simulation is being written.
 * Implements the same MatchApi with crude rules (flat ground, no physics) so the client can be
 * developed and e2e-tested. Delete once worker.ts imports the real Match.
 */
import { snapPlacement, type Placement } from '../sim/building';
import { CHARGE, DT, ECONOMY, GRENADE, LIFECYCLE, MAP, PIECES, PLAYER, WEAPONS } from '../sim/constants';
import { buy, collect, emptyInventory, mergeInventory, tickGenerator, vaultTransfer } from '../sim/economy';
import { bunkerWallBoxes, buildMap, type IslandLayout } from '../sim/map';
import type { MatchApi, MatchSetup } from '../sim/matchApi';
import { newPlayer } from '../sim/player';
import type {
  BuildRequest, Inventory, LootBag, MatchEvent, PieceKind, PieceState, PlayerInput, PlayerState, Snapshot, Vec3,
} from '../sim/types';
import { add, dist, dist2D, forward, right, rotateY, scale, v3 } from '../sim/vec';

const PROP_R = 0.8;

export class Match implements MatchApi {
  readonly map: IslandLayout[];
  private players: PlayerState[];
  private pieces: PieceState[] = [];
  private loot: LootBag[] = [];
  private generators: { island: number; stored: number }[];
  private pending: { at: number; ev: MatchEvent }[] = [];
  private events: MatchEvent[] = [];
  private time = 0;
  private tickNo = 0;
  private nextId = 1000;
  private vy = new Map<number, number>();
  private wander = new Map<number, Vec3>();
  private botShotAt = 0;
  private rng: () => number;

  private constructor(setup: MatchSetup) {
    this.map = buildMap(setup.players.length);
    let seed = setup.seed ?? 1;
    this.rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    this.players = setup.players.map((p, i) => {
      const pl = newPlayer(i, p.name, p.isBot, i, this.map[i].spawn);
      pl.yaw = this.map[i].bunker.facingYaw;
      return pl;
    });
    this.generators = this.map.map((m) => ({ island: m.index, stored: 0 }));
    // A sample of every piece kind on the bot's island so the renderer has something to draw.
    const bot = this.players.find((p) => p.isBot);
    if (bot) {
      bot.inv.weapons.pistol = { mag: 12, spare: 9999 };
      bot.equipped = 'pistol';
      const isl = this.map[bot.island];
      const kinds: PieceKind[] = ['sandbags', 'wood', 'metal', 'steel', 'scaffold', 'ramp', 'container'];
      kinds.forEach((kind, k) => {
        const local = v3(-9 + k * 3, 0, -2);
        const p = add(isl.center, rotateY(local, isl.bunker.facingYaw));
        this.pieces.push({ id: this.nextId++, kind, owner: bot.id, pos: v3(p.x, isl.groundY, p.z), rotY: isl.bunker.facingYaw, hp: PIECES[kind].hp });
      });
    }
    const home = this.map[0];
    const bagPos = add(home.center, rotateY(v3(4, 0, 3), home.bunker.facingYaw));
    const bagInv = emptyInventory();
    bagInv.cash = 25;
    this.loot.push({ id: this.nextId++, pos: v3(bagPos.x, home.groundY, bagPos.z), inv: bagInv });
  }

  static async create(setup: MatchSetup): Promise<Match> {
    return new Match(setup);
  }

  humanIds(): number[] {
    return this.players.filter((p) => !p.isBot).map((p) => p.id);
  }

  tick(inputs: Map<number, PlayerInput>): Snapshot {
    this.time += DT;
    this.tickNo++;
    this.events = [];
    const suddenDeath = this.time >= LIFECYCLE.suddenDeathAt;
    for (const p of this.players) {
      if (!p.alive) {
        if (p.respawnAt !== null && this.time >= p.respawnAt) this.respawn(p);
        continue;
      }
      const input = p.isBot ? this.botInput(p) : inputs.get(p.id);
      if (input) this.apply(p, input);
    }
    for (const g of this.generators) g.stored = tickGenerator(g.stored, DT, !suddenDeath);
    for (const lb of [...this.loot]) {
      const taker = this.players.find((p) => p.alive && dist(p.pos, lb.pos) < LIFECYCLE.lootPickupRadius);
      if (taker) { mergeInventory(taker.inv, lb.inv); this.loot = this.loot.filter((l) => l !== lb); }
    }
    const due = this.pending.filter((e) => this.time >= e.at);
    this.pending = this.pending.filter((e) => this.time < e.at);
    this.events.push(...due.map((d) => ({ ...d.ev, t: this.time })));
    const waterY = suddenDeath ? MAP.waterY + (this.time - LIFECYCLE.suddenDeathAt) * LIFECYCLE.tideRate : MAP.waterY;
    return structuredClone({
      time: this.time, tick: this.tickNo, players: this.players, pieces: this.pieces, loot: this.loot,
      generators: this.generators, sealed: this.map.map(() => suddenDeath), waterY, suddenDeath,
      winner: null, events: this.events,
    });
  }

  previewBuild(playerId: number, req: BuildRequest): Placement {
    const p = this.mustPlayer(playerId);
    const { pos, rotY } = snapPlacement(req.pos, req.rotY, req.free);
    if (dist2D(pos, p.pos) > 5) return { ok: false, reason: 'too far' };
    const s = PIECES[req.kind];
    const isl = this.islandAt(pos);
    if (!isl) return { ok: false, reason: 'nothing to build on' };
    const r = Math.hypot(s.w, s.d) / 2;
    for (const pc of this.pieces) {
      const pr = Math.hypot(PIECES[pc.kind].w, PIECES[pc.kind].d) / 2;
      if (dist2D(pc.pos, pos) < (r + pr) * 0.7) return { ok: false, reason: 'blocked' };
    }
    for (const b of bunkerWallBoxes(isl.bunker)) if (dist2D(b.center, pos) < r * 0.6 + 0.3) return { ok: false, reason: 'blocked' };
    for (const k of ['generator', 'vault', 'shop'] as const) if (dist2D(isl[k], pos) < r * 0.6 + PROP_R) return { ok: false, reason: 'blocked' };
    void rotY;
    return { ok: true, pos: v3(pos.x, isl.groundY, pos.z) };
  }

  debugTeleport(playerId: number, pos: Vec3): void {
    const p = this.mustPlayer(playerId);
    p.pos = { ...pos };
    p.vel = v3();
  }

  debugGive(playerId: number, inv: Partial<Inventory>): void {
    const p = this.mustPlayer(playerId);
    mergeInventory(p.inv, { ...emptyInventory(), ...structuredClone(inv) });
  }

  // ---------------------------------------------------------------------------------------------

  private mustPlayer(id: number) {
    const p = this.players.find((q) => q.id === id);
    if (!p) throw new Error(`FakeMatch: no player ${id}`);
    return p;
  }

  private islandAt(pos: { x: number; z: number }) {
    return this.map.find((m) => dist2D(m.center, pos) <= m.radius) ?? null;
  }

  private emit(type: MatchEvent['type'], data: Record<string, unknown>) {
    this.events.push({ t: this.time, type, data });
  }

  private apply(p: PlayerState, input: PlayerInput) {
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    let mx = input.moveX, mz = input.moveZ;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    const speed = input.sprint ? PLAYER.sprint : PLAYER.walk;
    const dir = add(scale(right(p.yaw), mx), scale(forward(p.yaw), mz));
    const next = add(p.pos, scale(dir, speed * DT));
    const isl = this.islandAt(next) ?? this.map[p.island];
    // Clamp to the island rim: no falling in the water in the fake.
    const off = v3(next.x - isl.center.x, 0, next.z - isl.center.z);
    const d = Math.hypot(off.x, off.z);
    if (d > isl.radius - 0.4) { next.x = isl.center.x + (off.x / d) * (isl.radius - 0.4); next.z = isl.center.z + (off.z / d) * (isl.radius - 0.4); }
    // Vertical: simple jump arc over flat ground.
    let vy = this.vy.get(p.id) ?? 0;
    const grounded = p.pos.y <= isl.groundY + 1e-3;
    if (input.jump && grounded) vy = PLAYER.jumpVelocity;
    vy -= PLAYER.gravity * DT;
    next.y = Math.max(isl.groundY, p.pos.y + vy * DT);
    if (next.y === isl.groundY) vy = 0;
    this.vy.set(p.id, vy);
    p.vel = scale(dir, speed);
    p.pos = next;

    if (input.slot && (input.slot === 'fists' || p.inv.weapons[input.slot])) { p.equipped = input.slot; p.reloadUntil = 0; }
    if (p.reloadUntil > 0 && this.time >= p.reloadUntil) this.finishReload(p);
    if (input.reload) this.startReload(p);
    if (input.fire) this.fire(p);
    if (input.interact) {
      const gen = this.generators.find((g) => dist2D(this.map[g.island].generator, p.pos) <= ECONOMY.interactRadius);
      if (gen) collect(p, gen);
    }
    const own = this.map[p.island];
    if (input.shop && dist2D(own.shop, p.pos) <= ECONOMY.interactRadius) buy(p, input.shop);
    if (input.vault && dist2D(own.vault, p.pos) <= ECONOMY.interactRadius) vaultTransfer(p, input.vault);
    if (input.build && this.time >= p.busyUntil && (p.inv.pieces[input.build.kind] ?? 0) > 0) {
      const res = this.previewBuild(p.id, input.build);
      if (res.ok) {
        const kind = input.build.kind;
        const { rotY } = snapPlacement(input.build.pos, input.build.rotY, input.build.free);
        const piece: PieceState = { id: this.nextId++, kind, owner: p.id, pos: res.pos, rotY, hp: PIECES[kind].hp };
        this.pieces.push(piece);
        p.inv.pieces[kind] = (p.inv.pieces[kind] ?? 0) - 1;
        if (p.inv.pieces[kind] === 0) delete p.inv.pieces[kind];
        p.busyUntil = this.time + PIECES[kind].placeSec;
        this.emit('placed', { piece: piece.id, kind, by: p.id });
      }
    }
    if (input.throwGrenade && p.inv.grenades > 0) {
      p.inv.grenades--;
      const at = add(p.pos, scale(forward(p.yaw), 8));
      this.pending.push({ at: this.time + GRENADE.fuseSec, ev: { t: 0, type: 'explosion', data: { kind: 'grenade', pos: at, by: p.id } } });
    }
    if (input.placeCharge && p.inv.charges > 0) {
      p.inv.charges--;
      const at = add(p.pos, add(scale(forward(p.yaw), 0.8), v3(0, 0.1, 0)));
      this.pending.push({ at: this.time + CHARGE.fuseSec, ev: { t: 0, type: 'explosion', data: { kind: 'charge', pos: at, by: p.id } } });
    }
  }

  private startReload(p: PlayerState) {
    const ammo = p.equipped === 'fists' ? null : p.inv.weapons[p.equipped];
    if (!ammo || ammo.spare <= 0 || ammo.mag >= WEAPONS[p.equipped].mag || p.reloadUntil > 0) return;
    p.reloadUntil = this.time + WEAPONS[p.equipped].reloadSec;
  }

  private finishReload(p: PlayerState) {
    p.reloadUntil = 0;
    const ammo = p.inv.weapons[p.equipped];
    if (!ammo) return;
    const take = Math.min(WEAPONS[p.equipped].mag - ammo.mag, ammo.spare);
    ammo.mag += take;
    ammo.spare -= take;
  }

  private fire(p: PlayerState) {
    if (this.time < p.nextFireAt || p.reloadUntil > 0 || this.time < p.busyUntil) return;
    const spec = WEAPONS[p.equipped];
    const ammo = p.equipped === 'fists' ? null : p.inv.weapons[p.equipped];
    if (ammo && ammo.mag <= 0) { this.startReload(p); return; }
    if (ammo) ammo.mag--;
    p.nextFireAt = this.time + 1 / spec.rps;
    const from = v3(p.pos.x, p.pos.y + PLAYER.eyeHeight, p.pos.z);
    const c = Math.cos(p.pitch);
    const dir = v3(-Math.sin(p.yaw) * c, Math.sin(p.pitch), -Math.cos(p.yaw) * c);
    let range = spec.range;
    for (const t of this.players) {
      if (t === p || !t.alive) continue;
      const center = v3(t.pos.x, t.pos.y + PLAYER.height / 2, t.pos.z);
      const rel = v3(center.x - from.x, center.y - from.y, center.z - from.z);
      const along = rel.x * dir.x + rel.y * dir.y + rel.z * dir.z;
      if (along < 0 || along > range) continue;
      const off = dist(rel, scale(dir, along));
      if (off > 0.5) continue;
      range = along;
      t.hp -= spec.dmg * spec.pellets;
      this.emit('hit', { target: t.id, by: p.id, amount: spec.dmg * spec.pellets });
      if (t.hp <= 0) this.kill(t, p.id);
    }
    this.emit('shot', { by: p.id, weapon: p.equipped, from, to: add(from, scale(dir, range)) });
    if (ammo && ammo.mag === 0) this.startReload(p);
  }

  private kill(t: PlayerState, killer: number | null) {
    t.hp = 0;
    t.alive = false;
    t.respawnAt = this.time + LIFECYCLE.respawnSec;
    this.emit('kill', { victim: t.id, killer });
  }

  private respawn(p: PlayerState) {
    p.alive = true;
    p.hp = PLAYER.hp;
    p.respawnAt = null;
    p.invulnUntil = this.time + LIFECYCLE.invulnSec;
    p.pos = { ...this.map[p.island].spawn };
  }

  private botInput(p: PlayerState): PlayerInput {
    const isl = this.map[p.island];
    let target = this.wander.get(p.id);
    if (!target || dist2D(target, p.pos) < 1) {
      const a = this.rng() * Math.PI * 2, r = 4 + this.rng() * 12;
      target = v3(isl.center.x + Math.cos(a) * r, isl.groundY, isl.center.z + Math.sin(a) * r);
      this.wander.set(p.id, target);
    }
    const yaw = Math.atan2(-(target.x - p.pos.x), -(target.z - p.pos.z));
    const fire = this.time - this.botShotAt > 4;
    if (fire) this.botShotAt = this.time;
    return {
      moveX: 0, moveZ: 1, yaw, pitch: 0.05, jump: false, sprint: false, fire, reload: false, interact: false,
      slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null,
    };
  }
}

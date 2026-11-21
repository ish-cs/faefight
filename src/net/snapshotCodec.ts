import { emptyInventory } from '../sim/economy';
import { emptyHotbar } from '../sim/hotbar';
import type { BotBrainInfo, MatchEvent, PieceState, PlayerState, Snapshot, Vec3 } from '../sim/types';

/**
 * What the host sends a remote client. Same as Snapshot except: pieces are omitted when unchanged
 * since that client's last update, events cover every tick since then, other players' inventories,
 * vaults, hotbars, gun locks and spread bookkeeping are left out (the decoder fills them in empty; `equipped` is
 * still sent so their gun renders), and floats are rounded. Everyone's shield IS sent: it is shown on name tags.
 * Stamina goes only to its owner (inside `mv`) and, like inventory and hotbar, to a dead/eliminated
 * spectator for the one player they follow (`follow`, vetted by net/interest.ts spectateTarget), plus
 * that player's bot brain when it's a bot (`brain`).
 */
type Private = 'inv' | 'vault' | 'hotbar' | 'locked' | 'bloom' | 'lastShotAt' | 'burst' | 'reloadUntil' | 'reloadSec' | 'reloadMag' | 'ads' | 'stamina';
export type NetPlayer = Omit<PlayerState, Private> & Partial<Pick<PlayerState, Private>>;
/** A live projectile on the wire: [id, kind (0 grenade, 1 charge, 2 rocket), x, y, z, vx, vy, vz]. */
export type NetProjectile = [number, number, number, number, number, number, number, number];
const PROJ_KINDS = ['grenade', 'charge', 'rocket'] as const;
/** A ground fire on the wire: [id, kind (0 grass, 1 crate, 2 palm), x, y, z]. */
export type NetFire = [number, number, number, number, number];
const FIRE_KINDS = ['grass', 'crate', 'palm'] as const;
export type NetSnapshot = Omit<Snapshot, 'pieces' | 'players' | 'projectiles' | 'brains' | 'fires'> & {
  pieces?: PieceState[]; players: NetPlayer[]; proj?: NetProjectile[]; fire?: NetFire[];
  /** Spectators only: the followed bot's thinking. */
  brain?: BotBrainInfo;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r1v = (v: Vec3): Vec3 => ({ x: Math.round(v.x * 10) / 10, y: Math.round(v.y * 10) / 10, z: Math.round(v.z * 10) / 10 });
const rv = (v: Vec3): Vec3 => ({ x: r2(v.x), y: r2(v.y), z: r2(v.z) });

/** Keep at most this many ticks of events for a client that stopped taking (e.g. a stalled link). */
const MAX_EVENT_TICKS = 90;

export class SnapshotEncoder {
  private latest: Snapshot | null = null;
  private piecesKey = '';
  private pieces: PieceState[] = [];
  private events: MatchEvent[][] = [];
  private eventTicks: number[] = [];
  private sentTick = new Map<number, number>();
  private sentPiecesKey = new Map<number, string>();

  push(snap: Snapshot): void {
    this.latest = snap;
    this.events.push(snap.events);
    this.eventTicks.push(snap.tick);
    if (this.events.length > MAX_EVENT_TICKS) { this.events.shift(); this.eventTicks.shift(); }
    const key = snap.pieces.map((p) => `${p.id}:${Math.round(p.hp)}${p.burning ? 'f' : ''}`).join(',');
    if (key !== this.piecesKey) {
      this.piecesKey = key;
      this.pieces = snap.pieces.map((p) => ({ ...p, pos: rv(p.pos), rotY: r3(p.rotY), hp: Math.round(p.hp) }));
    }
  }

  /** `allPieces`: always include the pieces list (the binary wire format deltas it per client instead). */
  /** `follow`: a player whose private HUD state (and bot brain) this client may see — only ever from spectateTarget(). */
  take(forPlayerId: number, allPieces = false, follow: number | null = null): NetSnapshot {
    const s = this.latest;
    if (!s) throw new Error('SnapshotEncoder.take: nothing pushed yet');
    const since = this.sentTick.get(forPlayerId) ?? -Infinity;
    const events = this.events.filter((_, i) => this.eventTicks[i] > since).flat();
    this.sentTick.set(forPlayerId, s.tick);
    const out: NetSnapshot = {
      ...s,
      waterY: r3(s.waterY),
      generators: s.generators.map((g) => ({ island: g.island, stored: Math.floor(g.stored) })),
      players: s.players.map((p) => this.player(p, p.id === forPlayerId, p.id === follow && follow !== forPlayerId)),
      events,
    };
    delete (out as Partial<Snapshot>).brains;
    const brain = follow !== null && follow !== forPlayerId ? s.brains?.find((b) => b.id === follow) : undefined;
    if (brain) out.brain = brain;
    delete (out as Partial<Snapshot>).projectiles;
    // Live grenades / charges / rockets, every update so everyone sees them fly (compact tuples; omitted when none).
    if (s.projectiles?.length) out.proj = s.projectiles.map((e): NetProjectile => {
      const p = rv(e.pos), v = r1v(e.vel);
      return [e.id, PROJ_KINDS.indexOf(e.kind), p.x, p.y, p.z, v.x, v.y, v.z];
    });
    // Ground fires: tiny list, only while something burns.
    delete (out as Partial<Snapshot>).fires;
    if (s.fires?.length) out.fire = s.fires.map((f): NetFire => { const p = rv(f.pos); return [f.id, FIRE_KINDS.indexOf(f.kind), p.x, p.y, p.z]; });
    delete (out as Partial<Snapshot>).pieces;
    if (allPieces || this.sentPiecesKey.get(forPlayerId) !== this.piecesKey) {
      this.sentPiecesKey.set(forPlayerId, this.piecesKey);
      out.pieces = this.pieces;
    }
    return out;
  }

  /** A client starts over (reconnected): its next update carries every piece and only events from now on. */
  resync(forPlayerId: number): void {
    this.sentPiecesKey.delete(forPlayerId);
    if (this.latest) this.sentTick.set(forPlayerId, this.latest.tick);
  }

  private player(p: PlayerState, own: boolean, followed: boolean): NetPlayer {
    // Your own position/velocity go out unrounded: the client replays its movement from them (prediction).
    const out: NetPlayer = {
      ...p, pos: own ? { ...p.pos } : rv(p.pos), vel: own ? { ...p.vel } : rv(p.vel), yaw: r3(p.yaw), pitch: r3(p.pitch), hp: Math.ceil(p.hp), shield: Math.ceil(p.shield), healLeft: Math.ceil(p.healLeft),
      bloom: r2(p.bloom),
    };
    // Emote / speech bubble start times on the ms grid (cheap on the wire; the animation doesn't need more).
    if (p.emote) out.emote = { id: p.emote.id, at: r3(p.emote.at) };
    if (p.quip) out.quip = { id: p.quip.id, at: r3(p.quip.at) };
    if (own) delete out.stamina; // the owner gets it inside mv (prediction)
    if (followed) {
      // A spectator's view of the player they follow: their whole HUD, but nothing host-side.
      const o = out as Partial<PlayerState>;
      delete o.vault; delete o.mv; delete o.busyUntil; delete o.nextFireAt; delete o.lastDamagedAt;
      out.stamina = Math.round(p.stamina);
      out.lastShotAt = r3(p.lastShotAt);
    } else if (!own) {
      delete out.stamina;
      delete out.inv; delete out.vault; delete out.hotbar; delete out.locked; delete out.doorsBlocked;
      // Spread/recoil bookkeeping only drives your own crosshair.
      delete out.bloom; delete out.lastShotAt; delete out.burst;
      // Host-side bookkeeping a remote client never reads for other players (keeps 8 players under budget).
      const o = out as Partial<PlayerState>;
      delete o.mv; delete o.busyUntil; delete o.nextFireAt; delete o.lastDamagedAt; delete o.healAt;
      // Reload/aim state only matters while it's happening (others' reload animation and sounds).
      if (p.reloadUntil === 0) { delete o.reloadUntil; delete o.reloadSec; delete o.reloadMag; }
      if (!p.ads) delete o.ads;
    } else out.lastShotAt = r3(p.lastShotAt);
    return out;
  }
}

export class SnapshotDecoder {
  private pieces: PieceState[] = [];

  decode(n: NetSnapshot): Snapshot {
    if (n.pieces) this.pieces = n.pieces;
    const players = n.players.map((p): PlayerState => ({
      ...p, inv: p.inv ?? emptyInventory(), vault: p.vault ?? emptyInventory(), hotbar: p.hotbar ?? emptyHotbar(), locked: p.locked ?? [],
      busyUntil: p.busyUntil ?? 0, nextFireAt: p.nextFireAt ?? 0, lastDamagedAt: p.lastDamagedAt ?? 0, healAt: p.healAt ?? null,
      bloom: p.bloom ?? 0, lastShotAt: p.lastShotAt ?? -1e9, burst: p.burst ?? 0,
      reloadUntil: p.reloadUntil ?? 0, reloadSec: p.reloadSec ?? 0, reloadMag: p.reloadMag ?? 0, ads: p.ads ?? false,
      stamina: p.stamina ?? p.mv?.stamina ?? 100,
    }));
    const { proj, brain, fire, ...rest } = n;
    const projectiles = (proj ?? []).map(([id, k, x, y, z, vx, vy, vz]) => ({ id, kind: PROJ_KINDS[k] ?? 'grenade', pos: { x, y, z }, vel: { x: vx, y: vy, z: vz } }));
    const out: Snapshot = { ...rest, players, pieces: this.pieces, projectiles };
    if (brain) out.brains = [brain];
    if (fire?.length) out.fires = fire.map(([id, k, x, y, z]) => ({ id, kind: FIRE_KINDS[k] ?? 'grass', pos: { x, y, z } }));
    return out;
  }
}

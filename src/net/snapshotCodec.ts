import { emptyInventory } from '../sim/economy';
import { emptyHotbar } from '../sim/hotbar';
import type { MatchEvent, PieceState, PlayerState, Snapshot, Vec3 } from '../sim/types';

/**
 * What the host sends a remote client. Same as Snapshot except: pieces are omitted when unchanged
 * since that client's last update, events cover every tick since then, other players' inventories,
 * vaults, hotbars and gun locks are left out (the decoder fills them in empty; `equipped` is still sent
 * so their gun renders), and floats are rounded.
 */
type Private = 'inv' | 'vault' | 'hotbar' | 'locked';
export type NetPlayer = Omit<PlayerState, Private> & Partial<Pick<PlayerState, Private>>;
export type NetSnapshot = Omit<Snapshot, 'pieces' | 'players'> & { pieces?: PieceState[]; players: NetPlayer[] };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
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
    const key = snap.pieces.map((p) => `${p.id}:${Math.round(p.hp)}`).join(',');
    if (key !== this.piecesKey) {
      this.piecesKey = key;
      this.pieces = snap.pieces.map((p) => ({ ...p, pos: rv(p.pos), rotY: r3(p.rotY), hp: Math.round(p.hp) }));
    }
  }

  take(forPlayerId: number): NetSnapshot {
    const s = this.latest;
    if (!s) throw new Error('SnapshotEncoder.take: nothing pushed yet');
    const since = this.sentTick.get(forPlayerId) ?? -Infinity;
    const events = this.events.filter((_, i) => this.eventTicks[i] > since).flat();
    this.sentTick.set(forPlayerId, s.tick);
    const out: NetSnapshot = {
      ...s,
      waterY: r3(s.waterY),
      generators: s.generators.map((g) => ({ island: g.island, stored: Math.floor(g.stored) })),
      players: s.players.map((p) => this.player(p, p.id === forPlayerId)),
      events,
    };
    delete (out as Partial<Snapshot>).pieces;
    if (this.sentPiecesKey.get(forPlayerId) !== this.piecesKey) {
      this.sentPiecesKey.set(forPlayerId, this.piecesKey);
      out.pieces = this.pieces;
    }
    return out;
  }

  private player(p: PlayerState, own: boolean): NetPlayer {
    // Your own position/velocity go out unrounded: the client replays its movement from them (prediction).
    const out: NetPlayer = {
      ...p, pos: own ? { ...p.pos } : rv(p.pos), vel: own ? { ...p.vel } : rv(p.vel), yaw: r3(p.yaw), pitch: r3(p.pitch), hp: Math.ceil(p.hp),
    };
    if (!own) { delete out.inv; delete out.vault; delete out.hotbar; delete out.locked; }
    return out;
  }
}

export class SnapshotDecoder {
  private pieces: PieceState[] = [];

  decode(n: NetSnapshot): Snapshot {
    if (n.pieces) this.pieces = n.pieces;
    const players = n.players.map((p): PlayerState => ({
      ...p, inv: p.inv ?? emptyInventory(), vault: p.vault ?? emptyInventory(), hotbar: p.hotbar ?? emptyHotbar(), locked: p.locked ?? [],
    }));
    return { ...n, players, pieces: this.pieces };
  }
}

import { PIECES } from '../sim/constants';
import type { PieceKind, PieceState, Vec3 } from '../sim/types';

/** A predicted piece the host hasn't shown by then was refused (spot taken meanwhile, out of pieces, ...). */
export const REJECT_MS = 1000;
/** A refused piece fades out over this long instead of popping. */
export const FADE_MS = 150;
/** The host's piece matches a prediction when it lands this close (it validates the same spot with the same rules). */
const MATCH_DIST = 0.75;

type Pending = { piece: PieceState; sentAt: number; afterId: number };
export type Fading = { piece: PieceState; opacity: number };

/**
 * Client-side build prediction. A placement shows at the ghost spot the moment it is sent, as a real-looking
 * piece with a temporary negative id. The host stays authoritative: when its snapshot shows a new piece of
 * ours of that kind at that spot the prediction is dropped (the real one takes its place); if none shows up
 * within REJECT_MS it was refused and fades out. Also paces placing locally at the piece's placeSec, the
 * rate the host allows.
 */
export class BuildPredictor {
  private pending: Pending[] = [];
  private fading: { piece: PieceState; at: number }[] = [];
  private nextId = -1;
  private readyAt = -Infinity;
  readonly stats = { placed: 0, confirmed: 0, rejected: 0 };

  /** Predicted pieces still waiting for the host (render and collide with these). */
  get pieces(): PieceState[] { return this.pending.map((p) => p.piece); }

  /** Local pacing: the last placement's placeSec has passed. */
  canPlace(nowMs: number): boolean { return nowMs >= this.readyAt; }

  /**
   * Predict one placement sent now. `afterId`: the highest piece id the client knows of (the host's piece
   * will be newer).
   */
  place(kind: PieceKind, pos: Vec3, rotY: number, owner: number, nowMs: number, afterId: number): PieceState {
    const piece: PieceState = { id: this.nextId--, kind, owner, pos: { ...pos }, rotY, hp: PIECES[kind].hp };
    this.pending.push({ piece, sentAt: nowMs, afterId });
    this.readyAt = nowMs + PIECES[kind].placeSec * 1000;
    this.stats.placed++;
    return piece;
  }

  /** Predictions of this kind the given host pieces don't show yet (the client's inventory count is short by these). */
  unconfirmed(hostPieces: readonly PieceState[], kind: PieceKind): number {
    const used = new Set<number>();
    let n = 0;
    for (const p of this.pending) if (p.piece.kind === kind && !this.match(p, hostPieces, used)) n++;
    return n;
  }

  /**
   * Against the host pieces about to be drawn: matched predictions are confirmed (dropped; the real piece is
   * in that list), ones older than REJECT_MS are rejected and start fading. Returns what changed.
   */
  reconcile(hostPieces: readonly PieceState[], nowMs: number): { confirmed: PieceState[]; rejected: PieceState[] } {
    const confirmed: PieceState[] = [], rejected: PieceState[] = [];
    const used = new Set<number>();
    this.pending = this.pending.filter((p) => {
      if (this.match(p, hostPieces, used)) { confirmed.push(p.piece); return false; }
      if (nowMs - p.sentAt > REJECT_MS) { rejected.push(p.piece); this.fading.push({ piece: p.piece, at: nowMs }); return false; }
      return true;
    });
    this.stats.confirmed += confirmed.length;
    this.stats.rejected += rejected.length;
    if (rejected.length) console.info(`[build] host refused ${rejected.length} predicted piece(s): ${rejected.map((r) => r.kind).join(', ')}`);
    return { confirmed, rejected };
  }

  /** Refused pieces still fading out, with their opacity (1 → 0). */
  fades(nowMs: number): Fading[] {
    this.fading = this.fading.filter((f) => nowMs - f.at < FADE_MS);
    return this.fading.map((f) => ({ piece: f.piece, opacity: 1 - (nowMs - f.at) / FADE_MS }));
  }

  private match(p: Pending, hostPieces: readonly PieceState[], used: Set<number>): boolean {
    const q = p.piece;
    const hit = hostPieces.find((h) => h.id > p.afterId && !used.has(h.id) && h.owner === q.owner && h.kind === q.kind &&
      Math.hypot(h.pos.x - q.pos.x, h.pos.y - q.pos.y, h.pos.z - q.pos.z) < MATCH_DIST);
    if (!hit) return false;
    used.add(hit.id);
    return true;
  }
}

import { newCheckpointKey, openCheckpoint, sealCheckpoint, type Checkpoint, type SessionMeta } from '../net/checkpoint';
import { newInviteCode } from '../net/code';
import { NET_VERSION, type ClientMsg, type HostMsg } from '../net/protocol';
import { sanitizeClientMsg } from '../net/sanitize';
import type { HostRoom, Link, Transport } from '../net/transport';
import { TICK_HZ } from '../sim/constants';
import type { MapDef } from '../sim/map';
import type { RecordingLink } from '../sim/replay/format';
import type { ToWorker } from './protocol';
import { HostSession, type HostEvents } from './session';

/**
 * Host migration: if the host leaves mid-match, a guest (the "backup") takes over and the match goes on.
 *
 * - The host picks a backup (pickBackup: sticky; else lowest RTT, then lowest seat) and every few seconds
 *   sends it a full checkpoint of the authoritative match (matchCheckpoint.ts: state, bots, rng, Rapier
 *   world; gzipped, ~30–50 KB) plus the seating/tokens (SessionMeta). Every guest gets the plan
 *   ('mplan'): which seat takes over and the room code it will open.
 * - Anti-cheat: the checkpoint is AES-GCM encrypted. The key goes to every guest EXCEPT the backup; they
 *   hand it to the backup in their hello only once they have lost the host themselves (probe failed / the
 *   host said goodbye). So the backup can't read other players' inventories or positions while the host is
 *   alive. Trade-off: with no other human guest (1 host + 1 guest + bots) the backup gets the key up front
 *   (nobody else could deliver it), so it could in principle read the bots' state.
 * - On host loss the backup restores the match in its own worker, fast-forwards it to "now" (bots act;
 *   humans stand still for the gap: the rollback is at most one checkpoint interval for human positions),
 *   botifies the old host's player and hosts room `code`; the other guests rejoin it with their seat token.
 */

/** Checkpoint cadence: aim at `budgetBps` to the backup, but never more often than minSec or less than maxSec. */
export const CHECKPOINT = { minSec: 2, maxSec: 5, budgetBps: 12 * 1024 } as const;
/** How long the backup waits for another guest to bring the key, and a guest keeps looking for the new host. */
export const KEY_WAIT_MS = 10_000;
export const FOLLOW_MS = 15_000;
/** A worker that never answers a checkpoint request doesn't block the next one forever. */
const CHECKPOINT_STUCK_MS = 10_000;

export const checkpointDelayMs = (bytes: number) =>
  Math.min(CHECKPOINT.maxSec, Math.max(CHECKPOINT.minSec, bytes / CHECKPOINT.budgetBps)) * 1000;

export type BackupCandidate = { seat: number; peerId: string; rtt: number | null };

/**
 * Which guest becomes host if the host is lost. Sticky: the current backup keeps the job while it is
 * connected (every change rotates the key and costs a fresh checkpoint). Otherwise the lowest known RTT
 * to the host (a proxy for a good connection), unknown RTTs last, ties to the lowest seat (joined first).
 */
export function pickBackup(cands: BackupCandidate[], current: number | null): number | null {
  if (current !== null && cands.some((c) => c.seat === current)) return current;
  const best = [...cands].sort((a, b) => (a.rtt ?? Infinity) - (b.rtt ?? Infinity) || a.seat - b.seat)[0];
  return best?.seat ?? null;
}

// ---------------------------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------------------------

export type MigratorIO = {
  /** Connected human guests of the running match. */
  guests(): BackupCandidate[];
  send(peerId: string, m: HostMsg): void;
  /** Ask the worker for a checkpoint; the answer comes back through onCheckpoint. */
  requestCheckpoint(): void;
  meta(): Omit<SessionMeta, 'tick'>;
};

/** Host side: keeps a backup chosen, every guest told the plan, and the backup's checkpoint fresh. */
export class HostMigrator {
  private epoch = 0;
  private backup: { seat: number; peerId: string; code: string; key: string; alone: boolean } | null = null;
  private told = new Map<string, number>();
  private nextDue = 0;
  private pendingSince: number | null = null;
  /** Bandwidth report (debug/e2e): checkpoints sent, last size and the interval chosen for it. */
  readonly stats = { sent: 0, lastBytes: 0, lastIntervalMs: 0, totalBytes: 0 };

  constructor(private io: MigratorIO, private now: () => number = () => performance.now()) {}

  get plan() { return this.backup ? { epoch: this.epoch, seat: this.backup.seat, code: this.backup.code } : null; }

  /** Once a second during a match. */
  tick(): void {
    const guests = this.io.guests();
    const seat = pickBackup(guests, this.backup?.seat ?? null);
    const b = guests.find((g) => g.seat === seat) ?? null;
    const alone = guests.length === 1;
    if (b?.peerId !== this.backup?.peerId || alone !== this.backup?.alone) {
      this.epoch++;
      this.told.clear();
      this.nextDue = 0;
      this.backup = b ? { seat: b.seat, peerId: b.peerId, code: newInviteCode(), key: newCheckpointKey(), alone } : null;
      if (b) console.info(`[migrate] backup host: seat ${b.seat} (rtt ${b.rtt ?? '?'} ms)${alone ? ', only guest: holds the key itself' : ''}`);
    }
    const bk = this.backup;
    if (!bk) return;
    for (const g of guests) {
      if (this.told.get(g.peerId) === this.epoch) continue;
      const key = g.peerId !== bk.peerId || bk.alone ? bk.key : undefined;
      this.io.send(g.peerId, key ? { t: 'mplan', epoch: this.epoch, seat: bk.seat, code: bk.code, key } : { t: 'mplan', epoch: this.epoch, seat: bk.seat, code: bk.code });
      this.told.set(g.peerId, this.epoch);
    }
    const now = this.now();
    if (this.pendingSince !== null && now - this.pendingSince > CHECKPOINT_STUCK_MS) {
      console.warn('[migrate] worker never answered the checkpoint request; asking again');
      this.pendingSince = null;
    }
    if (this.pendingSince === null && now >= this.nextDue) {
      this.pendingSince = now;
      this.io.requestCheckpoint();
    }
  }

  /** The worker's gzipped match at `tick` (and its recording's link): seal it and send it to the backup. */
  async onCheckpoint(match: Uint8Array, tick: number, recording?: RecordingLink): Promise<void> {
    this.pendingSince = null;
    const bk = this.backup, epoch = this.epoch;
    if (!bk) return;
    const sealed = await sealCheckpoint({ meta: { ...this.io.meta(), tick, ...(recording ? { recording } : {}) }, match }, bk.key);
    if (epoch !== this.epoch) return; // backup changed while sealing: the next tick asks again
    this.io.send(bk.peerId, { t: 'ckpt', epoch, b: sealed });
    const interval = checkpointDelayMs(sealed.byteLength);
    this.nextDue = this.now() + interval;
    const first = this.stats.sent === 0;
    Object.assign(this.stats, { sent: this.stats.sent + 1, lastBytes: sealed.byteLength, lastIntervalMs: interval, totalBytes: this.stats.totalBytes + sealed.byteLength });
    // Every checkpoint at debug level (e2e counts them); the first and every 20th at info.
    (first || this.stats.sent % 20 === 0 ? console.info : console.debug)(`[migrate] checkpoint #${this.stats.sent} to seat ${bk.seat}: ${sealed.byteLength} B, next in ${(interval / 1000).toFixed(1)} s (~${(sealed.byteLength / interval).toFixed(1)} KB/s)`);
  }

  /** Match over / back to the lobby: no plan until the next match. */
  reset(): void {
    this.epoch++;
    this.backup = null;
    this.told.clear();
    this.pendingSince = null;
    this.nextDue = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Guest side
// ---------------------------------------------------------------------------------------------

export type MigrationPlan = { epoch: number; seat: number; code: string; key?: string };

/** What a guest learns from the host for a migration: the plan, and (backup only) the latest checkpoint. */
export class GuestMigration {
  plan: MigrationPlan | null = null;
  sealed: { epoch: number; b: ArrayBuffer } | null = null;

  constructor(readonly seat: number) {}

  /** True if the message was a migration message (consumed). */
  onHostMsg(m: HostMsg): boolean {
    if (m.t === 'mplan') {
      this.plan = m.key ? { epoch: m.epoch, seat: m.seat, code: m.code, key: m.key } : { epoch: m.epoch, seat: m.seat, code: m.code };
      if (this.sealed?.epoch !== m.epoch) this.sealed = null;
      return true;
    }
    if (m.t === 'ckpt') {
      if (this.plan?.epoch === m.epoch && this.plan.seat === this.seat) this.sealed = { epoch: m.epoch, b: m.b };
      return true;
    }
    return false;
  }

  get isBackup(): boolean { return this.plan?.seat === this.seat; }
  /** Can this guest take part in a migration (a plan; the backup also needs a checkpoint)? */
  get ready(): boolean { return !!this.plan && (!this.isBackup || !!this.sealed); }
}

/** Is the old host's room still answering? (The guest's own connection may be what dropped.) */
export async function hostReachable(transport: Transport, code: string): Promise<boolean> {
  try {
    const probe = await withTimeout(transport.join(code), 6000);
    probe.close();
    return true;
  } catch (err) {
    console.info('[migrate] old host unreachable', err);
    return false;
  }
}

/** The new host's sim: a worker restored from the checkpoint. */
export type HostWorker = { postMessage(m: ToWorker): void };

export type TakeOverOpts = {
  transport: Transport;
  gm: GuestMigration;
  name: string;
  map: MapDef;
  /** Newest snapshot tick this guest saw, and when (performance.now ms): the restored match catches up to now. */
  lastTick: number;
  lastTickAt: number;
  /**
   * Start a worker on the checkpoint (restore, botify `botify`, fast-forward to `toTick`, then run).
   * `recording`: the old host's recording link from the checkpoint (unvalidated), to record the next segment.
   */
  startWorker(match: Uint8Array, humanId: number, botify: number[], toTick: number, recording: unknown): Promise<HostWorker>;
  events: HostEvents;
  keyWaitMs?: number;
  now?: () => number;
};

type Pending = { link: Link; hello: ClientMsg | null; handed: boolean };

/**
 * Backup host: open the announced room, get the key (own plan, or from the first guest who reconnects),
 * decrypt and restore the match, then host it. Throws (room closed) if any step fails.
 */
export async function takeOver(o: TakeOverOpts): Promise<{ session: HostSession; worker: HostWorker; checkpoint: Checkpoint }> {
  const plan = o.gm.plan, sealed = o.gm.sealed;
  if (!plan || !sealed || plan.seat !== o.gm.seat) throw new Error('takeOver: not the backup or no checkpoint');
  const now = o.now ?? (() => performance.now());
  const room: HostRoom = await o.transport.host(plan.code);
  console.info(`[migrate] backup room ${plan.code} open; ${plan.key ? 'holding the key' : 'waiting for a guest with the key'}`);
  const pending: Pending[] = [];
  let session: HostSession | null = null;
  let keyArrived: (() => void) | null = null;
  const keys: string[] = plan.key ? [plan.key] : [];
  room.onJoin((link) => {
    if (session) { session.accept(link); return; }
    const p: Pending = { link, hello: null, handed: false };
    pending.push(p);
    link.onMessage((raw) => {
      if (p.handed || p.hello) return;
      const m = sanitizeClientMsg(raw);
      if (m?.t !== 'hello') return;
      p.hello = m;
      if (session) { p.handed = true; session.accept(link, m); return; }
      if (m.mkey && !keys.includes(m.mkey)) { keys.push(m.mkey); keyArrived?.(); }
    });
  });
  try {
    let ck: Checkpoint | null = null;
    const deadline = now() + (o.keyWaitMs ?? KEY_WAIT_MS);
    for (let tried = 0; !ck;) {
      while (tried < keys.length && !ck) {
        try { ck = await openCheckpoint(sealed.b, keys[tried]); } catch { console.warn('[migrate] a key did not open the checkpoint'); }
        tried++;
      }
      if (ck) break;
      const left = deadline - now();
      if (left <= 0) throw new Error('no other player brought the checkpoint key in time');
      await new Promise<void>((res) => { const t = setTimeout(res, left); keyArrived = () => { clearTimeout(t); res(); }; });
      keyArrived = null;
    }
    const meta = ck.meta;
    const myId = meta.seatIds[o.gm.seat];
    const mine = meta.slots[o.gm.seat];
    if (myId == null || mine?.kind !== 'human' || mine.isHost) throw new Error(`checkpoint seat ${o.gm.seat} is not this guest's`);
    const oldHostSeat = meta.slots.findIndex((s) => s.kind === 'human' && s.isHost);
    const oldHostId = meta.seatIds[oldHostSeat] ?? null;
    const caughtUp = o.lastTick + Math.round(((now() - o.lastTickAt) / 1000) * TICK_HZ);
    const toTick = Math.max(meta.tick, Math.min(caughtUp, meta.tick + TICK_HZ * 20));
    console.info(`[migrate] restoring checkpoint tick ${meta.tick} (${ck.match.byteLength} B), catching up to tick ${toTick}`);
    const worker = await o.startWorker(ck.match, myId, oldHostId === null ? [] : [oldHostId], toTick, meta.recording);
    session = HostSession.adopt(room, o.name, o.events, { meta, seat: o.gm.seat, map: o.map, worker });
    for (const p of pending) if (p.hello && !p.handed) { p.handed = true; session.accept(p.link, p.hello); }
    return { session, worker, checkpoint: ck };
  } catch (err) {
    room.close();
    throw err;
  }
}

/**
 * A link whose messages are held until flush(), so every handler registered in between (the game's
 * backend and the lobby bookkeeping) sees the messages that followed the new host's 'start'.
 */
export class HeldLink implements Link {
  private cbs: ((m: unknown) => void)[] = [];
  private held: unknown[] | null = [];
  constructor(private inner: Link) {
    inner.onMessage((m) => { if (this.held) this.held.push(m); else for (const cb of this.cbs) cb(m); });
  }
  get peerId() { return this.inner.peerId; }
  send(m: unknown) { this.inner.send(m); }
  onMessage(cb: (m: unknown) => void) { this.cbs.push(cb); }
  onClose(cb: () => void) { this.inner.onClose(cb); }
  close() { this.inner.close(); }
  /** Drop what was held so far (the handshake's own lobby/start). */
  discard() { if (this.held) this.held = []; }
  flush() {
    const q = this.held ?? [];
    this.held = null;
    for (const m of q) for (const cb of this.cbs) cb(m);
  }
}

export type Followed = { link: HeldLink; start: Extract<HostMsg, { t: 'start' }>; hostName: string };

/** Other guests: find the backup's room, rejoin with our seat token (and the key), wait for its 'start'. */
export async function followNewHost(o: { transport: Transport; plan: MigrationPlan; name: string; token: string; timeoutMs?: number; now?: () => number }): Promise<Followed> {
  const now = o.now ?? (() => performance.now());
  const deadline = now() + (o.timeoutMs ?? FOLLOW_MS);
  let lastErr: unknown = null;
  while (now() < deadline) {
    let link: Link;
    try { link = await withTimeout(o.transport.join(o.plan.code), Math.max(500, deadline - now())); }
    catch (err) { lastErr = err; await sleep(400); continue; }
    try {
      return await handshake(link, o);
    } catch (err) {
      link.close();
      if (err instanceof Refused) throw err;
      lastErr = err;
      await sleep(400);
    }
  }
  throw new Error(`could not reach the new host (${String((lastErr as Error)?.message ?? lastErr)})`);
}

class Refused extends Error {}

function handshake(link: Link, o: { plan: MigrationPlan; name: string; token: string }): Promise<Followed> {
  const held = new HeldLink(link);
  return withTimeout(new Promise<Followed>((resolve, reject) => {
    let hostName = '';
    let done = false;
    link.onClose(() => { if (!done) reject(new Error('new host closed the link')); });
    link.onMessage((raw) => {
      if (done) return;
      const m = raw as HostMsg;
      if (m.t === 'lobby') { const h = m.slots.find((s) => s.kind === 'human' && s.isHost); hostName = h?.kind === 'human' ? h.name : ''; }
      else if (m.t === 'ended') { done = true; reject(new Refused(`new host refused: ${m.reason}`)); }
      else if (m.t === 'start') { done = true; held.discard(); resolve({ link: held, start: m, hostName }); }
    });
    const hello: ClientMsg = o.plan.key
      ? { t: 'hello', name: o.name, version: NET_VERSION, rejoin: o.token, mkey: o.plan.key }
      : { t: 'hello', name: o.name, version: NET_VERSION, rejoin: o.token };
    link.send(hello);
  }), 8000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

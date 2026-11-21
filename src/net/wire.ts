/**
 * Binary, delta-compressed snapshot wire format (host → remote client).
 *
 * The host encodes each client's (already interest-filtered) NetSnapshot tree into an ArrayBuffer,
 * as a delta against the newest snapshot that client has acknowledged (acks ride on its input
 * messages). Unchanged subtrees cost one byte; changed numbers are sent as small integer deltas
 * when both sides are on the same fixed-point grid (cm / mm, which is how SnapshotEncoder rounds
 * positions/angles); arrays of {id} objects (players, pieces, loot) are diffed by id. Lossless with
 * respect to the input tree, so a decoded snapshot equals what the host meant to send.
 *
 * Loss tolerance: a client that misses messages keeps acking an older one, and the host keeps
 * deltas against that until a newer ack arrives (or falls back to a full snapshot when the base
 * has left its history). A client that receives a delta whose base it doesn't have drops it.
 *
 * Layout: u8 version | varint seq | varint baseSeq (0 = full) | value.
 */

const VERSION = 1;

// Value tags.
const T_SAME = 0;      // delta: unchanged from base
const T_NULL = 1;
const T_UNDEF = 2;
const T_FALSE = 3;
const T_TRUE = 4;
const T_INT = 5;       // zigzag varint
const T_CENTI = 6;     // zigzag varint of v*100
const T_MILLI = 7;     // zigzag varint of v*1000
const T_F64 = 8;
const T_STR = 9;       // varint len + utf8 (added to the string table)
const T_STRREF = 10;   // varint index into the string table
const T_OBJ = 11;      // (key, value)* END
const T_OBJD = 12;     // delta: (key, deltaValue | T_DEL)* END
const T_ARR = 13;      // varint len, values
const T_ARRD = 14;     // delta, same length: varint len, deltaValues
const T_IDARR = 15;    // delta of ascending-{id} arrays: varint nRemoved, removed id gaps, (varint idGap+1, deltaValue)* 0
const T_DCENTI = 16;   // delta: zigzag varint of (v - base) * 100
const T_DMILLI = 17;   // delta: zigzag varint of (v - base) * 1000
const T_DEL = 18;      // delta: key removed
const T_DINT = 19;     // delta: zigzag varint of v - base (both integers)
const END = 0xff;

/** Strings every snapshot uses (keys, enums), pre-seeded in both tables so they cost 1–2 bytes from the start. */
const DICT = [
  'time', 'tick', 'players', 'pieces', 'loot', 'proj', 'generators', 'genLevels', 'sealed', 'waterY', 'suddenDeath', 'winner',
  'potionShops', 'events', 'hidden', 'id', 'name', 'isBot', 'island', 'pos', 'vel', 'x', 'y', 'z', 'yaw', 'pitch', 'hp', 'shield',
  'alive', 'eliminated', 'kills', 'deaths', 'equipped', 'selected', 'respawnAt', 'invulnUntil', 'breakoutUntil', 'drinking',
  'healLeft', 'speedUntil', 'healAt', 'reloadUntil', 'reloadSec', 'reloadMag', 'ads', 'inv', 'vault', 'hotbar', 'locked', 'bloom',
  'lastShotAt', 'burst', 'mv', 'busyUntil', 'nextFireAt', 'lastDamagedAt', 'cash', 'weapons', 'grenades', 'charges', 'medkits',
  'potions', 'mag', 'spare', 'kind', 'owner', 'rotY', 'stored', 't', 'type', 'data', 'by', 'target', 'weapon', 'from', 'to', 'tos',
  'kick', 'amount', 'shieldAmount', 'broke', 'part', 'head', 'body', 'shot', 'hit', 'pieceHit', 'destroyed', 'placed', 'explosion',
  'kill', 'dry', 'victim', 'killer', 'piece', 'source', 'bullet', 'maxHp', 'fists', 'pistol', 'smg', 'shotgun', 'rifle', 'rocket',
  'wood', 'metal', 'steel', 'sandbags', 'scaffold', 'ramp', 'container', 'grenade', 'charge', 'medkit', 'noPickup', 'until',
  'ack', 'grounded', 'airTime', 'storm', 'strikes', 'r', 'at', 'lightning', 'cause',
  'stamina', 'exhausted', 'sprinting', 'rest', 'stress', 'brain', 'personality', 'difficulty',
  'action', 'goal', 'reason', 'steps', 'step', 'fightOdds', 'thought',
  'burning', 'fire', 'view',
  'emote', 'quip', 'wheel',
  // appended (keep earlier indices stable): gameplay props
  'pr', 'p', 'q',
];

const enc = new TextEncoder();
const dec = new TextDecoder();

class Writer {
  buf = new Uint8Array(4096);
  view = new DataView(this.buf.buffer);
  n = 0;
  strings = new Map<string, number>();
  private added: string[] = [];

  reset() {
    this.n = 0;
    this.strings.clear();
    this.added.length = 0;
    DICT.forEach((s, i) => this.strings.set(s, i));
  }
  /** Position to come back to if a subtree turns out unchanged (strings added since are forgotten too). */
  mark(): number { return this.n * 65536 + this.added.length; }
  rewind(m: number) {
    this.n = Math.floor(m / 65536);
    const keep = m % 65536;
    while (this.added.length > keep) this.strings.delete(this.added.pop()!);
  }
  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
    this.view = new DataView(b.buffer);
  }
  u8(x: number) { this.room(1); this.buf[this.n++] = x; }
  varint(x: number) {
    this.room(10);
    while (x >= 0x80) { this.buf[this.n++] = (x % 0x80) | 0x80; x = Math.floor(x / 0x80); }
    this.buf[this.n++] = x;
  }
  zigzag(x: number) { this.varint(x >= 0 ? x * 2 : -x * 2 - 1); }
  f64(x: number) { this.room(8); this.view.setFloat64(this.n, x, true); this.n += 8; }
  str(s: string) {
    const i = this.strings.get(s);
    if (i !== undefined) { this.u8(T_STRREF); this.varint(i); return; }
    this.strings.set(s, this.strings.size);
    this.added.push(s);
    const b = enc.encode(s);
    this.u8(T_STR);
    this.varint(b.length);
    this.room(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  bytes(): ArrayBuffer { return this.buf.slice(0, this.n).buffer; }
}

class Reader {
  private view: DataView;
  private b: Uint8Array;
  i = 0;
  strings: string[] = [...DICT];
  constructor(buf: ArrayBuffer) { this.b = new Uint8Array(buf); this.view = new DataView(buf); }
  u8() {
    if (this.i >= this.b.length) throw new Error('wire: truncated message');
    return this.b[this.i++];
  }
  peek() { return this.b[this.i]; }
  varint() {
    let x = 0, mul = 1, byte: number;
    do { byte = this.u8(); x += (byte & 0x7f) * mul; mul *= 0x80; } while (byte & 0x80);
    return x;
  }
  zigzag() { const z = this.varint(); return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }
  f64() { const x = this.view.getFloat64(this.i, true); this.i += 8; return x; }
  str(tag: number): string {
    if (tag === T_STRREF) {
      const s = this.strings[this.varint()];
      if (s === undefined) throw new Error('wire: bad string ref');
      return s;
    }
    const len = this.varint();
    if (this.i + len > this.b.length) throw new Error('wire: truncated string');
    const s = dec.decode(this.b.subarray(this.i, this.i + len));
    this.i += len;
    this.strings.push(s);
    return s;
  }
  get done() { return this.i >= this.b.length; }
}

const MAX_INT = 2 ** 40;
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** Integer k if v == k/scale exactly as SnapshotEncoder's rounding produces it, else null. */
function fixed(v: number, scale: number): number | null {
  const k = Math.round(v * scale);
  return Math.abs(k) < MAX_INT && k / scale === v ? k : null;
}

function writeNumber(w: Writer, v: number) {
  if (Number.isInteger(v) && Math.abs(v) < MAX_INT) { w.u8(T_INT); w.zigzag(v); return; }
  const c = Number.isFinite(v) ? fixed(v, 100) : null;
  if (c !== null) { w.u8(T_CENTI); w.zigzag(c); return; }
  const m = Number.isFinite(v) ? fixed(v, 1000) : null;
  if (m !== null) { w.u8(T_MILLI); w.zigzag(m); return; }
  w.u8(T_F64); w.f64(v);
}

function writeFull(w: Writer, v: unknown): void {
  switch (typeof v) {
    case 'number': writeNumber(w, v); return;
    case 'string': w.str(v); return;
    case 'boolean': w.u8(v ? T_TRUE : T_FALSE); return;
    case 'undefined': w.u8(T_UNDEF); return;
  }
  if (v === null) { w.u8(T_NULL); return; }
  if (Array.isArray(v)) {
    w.u8(T_ARR); w.varint(v.length);
    for (const x of v) writeFull(w, x);
    return;
  }
  if (isPlain(v)) {
    w.u8(T_OBJ);
    for (const k in v) { w.str(k); writeFull(w, v[k]); }
    w.u8(END);
    return;
  }
  throw new Error(`wire: cannot encode ${Object.prototype.toString.call(v)}`);
}

/** Ascending integer ids on every element (players, pieces, loot)? */
function idSorted(a: unknown[]): boolean {
  let last = -Infinity;
  for (const x of a) {
    if (!isPlain(x) || !Number.isInteger(x.id) || (x.id as number) <= last) return false;
    last = x.id as number;
  }
  return true;
}

/** Writes v as a delta against base (or full). Returns false (and writes T_SAME) when unchanged. */
function writeDelta(w: Writer, v: unknown, base: unknown): boolean {
  if (v === base) { w.u8(T_SAME); return false; }
  if (typeof v === 'number' && typeof base === 'number') {
    if (Number.isInteger(v) && Number.isInteger(base) && Math.abs(v) < MAX_INT && Math.abs(base) < MAX_INT) {
      const d = v - base;
      if (Math.abs(d) < 64 && Math.abs(v) >= 64) { w.u8(T_DINT); w.zigzag(d); return true; }
    } else if (Number.isFinite(v) && Number.isFinite(base)) {
      for (const [scale, tag] of [[100, T_DCENTI], [1000, T_DMILLI]] as const) {
        const a = fixed(v, scale), b = fixed(base, scale);
        if (a !== null && b !== null) { w.u8(tag); w.zigzag(a - b); return true; }
      }
    }
    writeNumber(w, v);
    return true;
  }
  if (Array.isArray(v) && Array.isArray(base)) {
    const start = w.mark();
    let changed = false;
    if (v.length > 0 && idSorted(v) && idSorted(base)) {
      const ids = new Set<number>();
      for (const x of v as { id: number }[]) ids.add(x.id);
      const removed: number[] = [];
      for (const b of base as { id: number }[]) if (!ids.has(b.id)) removed.push(b.id);
      w.u8(T_IDARR);
      w.varint(removed.length);
      let last = 0;
      for (const id of removed) { w.zigzag(id - last); last = id; }
      changed = removed.length > 0;
      let bi = 0;
      last = 0;
      for (const x of v as { id: number }[]) {
        while (bi < base.length && (base[bi] as { id: number }).id < x.id) bi++;
        const b = bi < base.length && (base[bi] as { id: number }).id === x.id ? base[bi] : undefined;
        const at = w.mark();
        const gap = x.id - last;
        w.varint((gap >= 0 ? gap * 2 : -gap * 2 - 1) + 1); // zigzag + 1: 0 terminates the list
        if (b === undefined) writeFull(w, x);
        else if (!writeDelta(w, x, b)) { w.rewind(at); continue; } // unchanged: no entry
        changed = true;
        last = x.id;
      }
      w.varint(0);
    } else if (v.length === base.length) {
      w.u8(T_ARRD); w.varint(v.length);
      for (let i = 0; i < v.length; i++) if (writeDelta(w, v[i], base[i])) changed = true;
    } else {
      writeFull(w, v);
      return true;
    }
    if (!changed) { w.rewind(start); w.u8(T_SAME); }
    return changed;
  }
  if (isPlain(v) && isPlain(base)) {
    const start = w.mark();
    let changed = false;
    w.u8(T_OBJD);
    for (const k in v) {
      const at = w.mark();
      w.str(k);
      if (!(k in base)) { writeFull(w, v[k]); changed = true; continue; }
      if (writeDelta(w, v[k], base[k])) changed = true;
      else w.rewind(at);
    }
    for (const k in base) if (!(k in v)) { w.str(k); w.u8(T_DEL); changed = true; }
    w.u8(END);
    if (!changed) { w.rewind(start); w.u8(T_SAME); }
    return changed;
  }
  writeFull(w, v);
  return true;
}

function readValue(r: Reader, base: unknown, tag = r.u8()): unknown {
  switch (tag) {
    case T_SAME: return base;
    case T_NULL: return null;
    case T_UNDEF: return undefined;
    case T_FALSE: return false;
    case T_TRUE: return true;
    case T_INT: return r.zigzag();
    case T_CENTI: return r.zigzag() / 100;
    case T_MILLI: return r.zigzag() / 1000;
    case T_F64: return r.f64();
    case T_STR: case T_STRREF: return r.str(tag);
    case T_DINT: return (base as number) + r.zigzag();
    case T_DCENTI: return (Math.round((base as number) * 100) + r.zigzag()) / 100;
    case T_DMILLI: return (Math.round((base as number) * 1000) + r.zigzag()) / 1000;
    case T_ARR: {
      const n = r.varint();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readValue(r, undefined);
      return out;
    }
    case T_ARRD: {
      const n = r.varint(), b = base as unknown[];
      if (!Array.isArray(b) || b.length !== n) throw new Error('wire: array delta against a different base');
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readValue(r, b[i]);
      return out;
    }
    case T_IDARR: {
      const b = base as { id: number }[];
      if (!Array.isArray(b)) throw new Error('wire: id-array delta without a base array');
      const removed = new Set<number>();
      let last = 0;
      for (let k = r.varint(); k > 0; k--) { last += r.zigzag(); removed.add(last); }
      const byId = new Map<number, { id: number }>();
      for (const x of b) byId.set(x.id, x);
      const changed = new Map<number, unknown>();
      last = 0;
      for (let z = r.varint(); z !== 0; z = r.varint()) {
        const zz = z - 1;
        last += zz % 2 === 0 ? zz / 2 : -(zz + 1) / 2;
        changed.set(last, readValue(r, byId.get(last)));
      }
      const out: { id: number }[] = [];
      for (const x of b) if (!removed.has(x.id)) out.push((changed.get(x.id) as { id: number }) ?? x);
      for (const [id, x] of changed) if (!byId.has(id)) out.push(x as { id: number });
      out.sort((p, q) => p.id - q.id);
      return out;
    }
    case T_OBJ: {
      const out: Record<string, unknown> = {};
      for (let t = r.u8(); t !== END; t = r.u8()) out[r.str(t)] = readValue(r, undefined);
      return out;
    }
    case T_OBJD: {
      if (!isPlain(base)) throw new Error('wire: object delta without a base object');
      const out: Record<string, unknown> = { ...base };
      for (let t = r.u8(); t !== END; t = r.u8()) {
        const k = r.str(t);
        const vt = r.u8();
        if (vt === T_DEL) delete out[k];
        else out[k] = readValue(r, base[k], vt);
      }
      return out;
    }
    default: throw new Error(`wire: bad tag ${tag}`);
  }
}

/** Header of an encoded snapshot (without decoding the body). */
export function wireHeader(buf: ArrayBuffer): { seq: number; baseSeq: number } {
  const r = new Reader(buf);
  if (r.u8() !== VERSION) throw new Error('wire: version mismatch');
  return { seq: r.varint(), baseSeq: r.varint() };
}

/** History kept per client (host) and of received snapshots (client): ~4 s at 15 Hz. */
export const WIRE_HISTORY = 64;

/** Host side, one per remote client. */
export class WireEncoder {
  private sent = new Map<number, unknown>();
  private acked = 0;
  private w = new Writer();
  /** Bytes / full / delta counters (debug and tests). */
  stats = { bytes: 0, full: 0, delta: 0 };

  /** Client says it has decoded `seq`. Unknown or stale acks are ignored. */
  ack(seq: number): void {
    if (!Number.isInteger(seq) || seq <= this.acked || !this.sent.has(seq)) return;
    this.acked = seq;
    for (const k of this.sent.keys()) if (k < seq) this.sent.delete(k);
  }

  get ackedSeq() { return this.acked; }

  encode(seq: number, tree: unknown): ArrayBuffer {
    if (!Number.isInteger(seq) || seq <= 0) throw new Error(`WireEncoder.encode: bad seq ${seq}`);
    const base = this.acked ? this.sent.get(this.acked) : undefined;
    const w = this.w;
    w.reset();
    w.u8(VERSION);
    w.varint(seq);
    w.varint(base !== undefined ? this.acked : 0);
    if (base !== undefined) { writeDelta(w, tree, base); this.stats.delta++; } else { writeFull(w, tree); this.stats.full++; }
    this.sent.set(seq, tree);
    // Never ack'd for a long time (stalled client): bound the history; it gets a full snapshot next.
    if (this.sent.size > WIRE_HISTORY) {
      const oldest = this.sent.keys().next().value!;
      this.sent.delete(oldest);
      if (oldest === this.acked) this.acked = 0;
    }
    const out = w.bytes();
    this.stats.bytes += out.byteLength;
    return out;
  }
}

/** Client side. decode() returns null for a delta whose base it no longer has (dropped). */
export class WireDecoder {
  private got = new Map<number, unknown>();
  private newest = 0;

  /** Newest decoded seq: send it back as the ack. */
  get ack() { return this.newest; }

  decode<T>(buf: ArrayBuffer): T | null {
    const r = new Reader(buf);
    if (r.u8() !== VERSION) throw new Error('wire: version mismatch');
    const seq = r.varint(), baseSeq = r.varint();
    if (seq <= this.newest) return null; // stale / duplicate
    let base: unknown;
    if (baseSeq) {
      base = this.got.get(baseSeq);
      if (base === undefined) { console.warn(`[wire] dropping snapshot ${seq}: base ${baseSeq} not held`); return null; }
    }
    const tree = readValue(r, base);
    if (!r.done) throw new Error('wire: trailing bytes');
    this.got.set(seq, tree);
    this.newest = seq;
    for (const k of this.got.keys()) if (k < baseSeq || this.got.size > WIRE_HISTORY) this.got.delete(k);
    // Consumers get their own copy: decoded trees share structure with the history kept here.
    return structuredClone(tree) as T;
  }
}

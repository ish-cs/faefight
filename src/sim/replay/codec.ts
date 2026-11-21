import type { MoveCmd } from '../movement';
import type { PlayerInput, WeaponKind } from '../types';
import { REPLAY_FORMAT, type Replay, type TickInput } from './format';

/**
 * .faereplay binary: "FAER" + format byte + deflate-raw( sections ). Inputs are delta-coded per player
 * against that player's previous input (a bitmask of changed fields, then just those fields), move
 * commands against the input they came with; numbers are zigzag varints when integral, float32 when
 * that's exact, else float64. Everything else (header, ops, event log, summaries) is JSON inside the
 * compressed stream. Lossless: decode(encode(r)) deep-equals r.
 */

const MAGIC = [0x46, 0x41, 0x45, 0x52]; // FAER

const WEAPONS: WeaponKind[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'rocket'];
const BOOLS = ['jump', 'sprint', 'fire', 'ads', 'reload', 'interact', 'throwGrenade', 'placeCharge', 'useMedkit', 'drink'] as const;
const JSONS = ['build', 'shop', 'vault', 'moveSlot'] as const;
const KNOWN = new Set<string>(['moveX', 'moveZ', 'yaw', 'pitch', 'slot', 'select', 'drop', ...BOOLS, ...JSONS]);
const DROPS = [null, 'one', 'stack'] as const;

// Field bits of the per-input change mask.
const F = { moveX: 1, moveZ: 2, yaw: 4, pitch: 8, bools: 16, slot: 32, build: 64, shop: 128, vault: 256, select: 512, drop: 1024, moveSlot: 2048, extras: 4096 };
const JSON_BIT = { build: F.build, shop: F.shop, vault: F.vault, moveSlot: F.moveSlot } as const;

class Writer {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private dv = new DataView(this.buf.buffer);
  private need(k: number) {
    if (this.n + k <= this.buf.length) return;
    let len = this.buf.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new Uint8Array(len);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(v: number) { this.need(1); this.buf[this.n++] = v; }
  varint(v: number) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`codec: varint needs a non-negative integer, got ${v}`);
    this.need(10);
    while (v >= 0x80) { this.buf[this.n++] = (v % 0x80) | 0x80; v = Math.floor(v / 0x80); }
    this.buf[this.n++] = v;
  }
  zigzag(v: number) { this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
  u32(v: number) { this.need(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; }
  f32(v: number) { this.need(4); this.dv.setFloat32(this.n, v, true); this.n += 4; }
  f64(v: number) { this.need(8); this.dv.setFloat64(this.n, v, true); this.n += 8; }
  num(v: number) {
    if (Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) < 2 ** 40) { this.u8(0); this.zigzag(v); }
    else if (Math.fround(v) === v || Number.isNaN(v)) { this.u8(1); this.f32(v); }
    else { this.u8(2); this.f64(v); }
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    this.need(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  json(v: unknown) { this.str(JSON.stringify(v ?? null)); }
  raw(b: Uint8Array) { this.need(b.length); this.buf.set(b, this.n); this.n += b.length; }
  bytes() { return this.buf.slice(0, this.n); }
}

class Reader {
  n = 0;
  private dv: DataView;
  constructor(private buf: Uint8Array) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  private check(k: number) { if (this.n + k > this.buf.length) throw new Error('codec: replay is truncated'); }
  u8() { this.check(1); return this.buf[this.n++]; }
  varint() {
    let v = 0, mul = 1, b: number;
    do { b = this.u8(); v += (b & 0x7f) * mul; mul *= 0x80; } while (b & 0x80);
    return v;
  }
  zigzag() { const z = this.varint(); return z % 2 ? -(z + 1) / 2 : z / 2; }
  u32() { this.check(4); const v = this.dv.getUint32(this.n, true); this.n += 4; return v; }
  num() {
    const t = this.u8();
    if (t === 0) return this.zigzag();
    if (t === 1) { this.check(4); const v = this.dv.getFloat32(this.n, true); this.n += 4; return v; }
    if (t === 2) { this.check(8); const v = this.dv.getFloat64(this.n, true); this.n += 8; return v; }
    throw new Error(`codec: bad number tag ${t}`);
  }
  str() {
    const len = this.varint();
    this.check(len);
    const s = new TextDecoder().decode(this.buf.subarray(this.n, this.n + len));
    this.n += len;
    return s;
  }
  json<T>(): T { return JSON.parse(this.str()) as T; }
}

const boolWord = (i: PlayerInput) => BOOLS.reduce((w, k, b) => (i[k] ? w | (1 << b) : w), 0);
function extrasOf(i: PlayerInput): string {
  const ex: Record<string, unknown> = {};
  let any = false;
  for (const k of Object.keys(i)) if (!KNOWN.has(k)) { ex[k] = (i as Record<string, unknown>)[k]; any = true; }
  return any ? JSON.stringify(ex) : '';
}
const BLANK: PlayerInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ads: false, reload: false, interact: false,
  slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null, select: null, drop: null,
  moveSlot: null, useMedkit: false, drink: false,
};

/** Incremental tick encoder: the recorder pushes each tick as it happens (no input objects kept around). */
export class TickWriter {
  private w = new Writer();
  private prev = new Map<number, { input: PlayerInput; extras: string; seq: number }>();
  count = 0;

  get size() { return this.w.n; }
  bytes() { return this.w.bytes(); }

  push(entries: readonly TickInput[]) {
    const w = this.w, prev = this.prev;
    this.count++;
    w.varint(entries.length);
    for (const { id, input, moves } of entries) {
      const p = prev.get(id) ?? { input: BLANK, extras: '', seq: 0 };
      const extras = extrasOf(input);
      let mask = 0;
      if (!Object.is(input.moveX, p.input.moveX)) mask |= F.moveX;
      if (!Object.is(input.moveZ, p.input.moveZ)) mask |= F.moveZ;
      if (!Object.is(input.yaw, p.input.yaw)) mask |= F.yaw;
      if (!Object.is(input.pitch, p.input.pitch)) mask |= F.pitch;
      if (boolWord(input) !== boolWord(p.input)) mask |= F.bools;
      if (input.slot !== p.input.slot) mask |= F.slot;
      for (const k of JSONS) if (JSON.stringify(input[k] ?? null) !== JSON.stringify(p.input[k] ?? null)) mask |= JSON_BIT[k];
      if (input.select !== p.input.select) mask |= F.select;
      if (input.drop !== p.input.drop) mask |= F.drop;
      if (extras !== p.extras) mask |= F.extras;
      w.varint(id);
      w.varint(mask);
      if (mask & F.moveX) w.num(input.moveX);
      if (mask & F.moveZ) w.num(input.moveZ);
      if (mask & F.yaw) w.num(input.yaw);
      if (mask & F.pitch) w.num(input.pitch);
      if (mask & F.bools) w.varint(boolWord(input));
      if (mask & F.slot) {
        const at = input.slot === null ? 0 : WEAPONS.indexOf(input.slot) + 1;
        if (at < 0 || (input.slot !== null && at === 0)) throw new Error(`codec: unknown weapon slot ${input.slot}`);
        w.varint(at);
      }
      for (const k of JSONS) if (mask & JSON_BIT[k]) w.json(input[k]);
      if (mask & F.select) w.varint(input.select === null ? 0 : input.select + 1);
      if (mask & F.drop) w.varint(DROPS.indexOf(input.drop));
      if (mask & F.extras) w.str(extras);
      let seq = p.seq;
      if (!moves) w.varint(0);
      else {
        w.varint(moves.length + 1);
        for (const c of moves) {
          w.zigzag(c.seq - (seq + 1));
          seq = c.seq;
          const same = (Object.is(c.moveX, input.moveX) ? 1 : 0) | (Object.is(c.moveZ, input.moveZ) ? 2 : 0) | (Object.is(c.yaw, input.yaw) ? 4 : 0);
          w.u8(same | (c.sprint ? 8 : 0) | (c.jump ? 16 : 0));
          if (!(same & 1)) w.num(c.moveX);
          if (!(same & 2)) w.num(c.moveZ);
          if (!(same & 4)) w.num(c.yaw);
        }
      }
      prev.set(id, { input, extras, seq });
    }
  }
}

function readTicks(r: Reader): TickInput[][] {
  const prev = new Map<number, { input: PlayerInput; extras: string; seq: number }>();
  const n = r.varint();
  const ticks: TickInput[][] = new Array(n);
  for (let t = 0; t < n; t++) {
    const count = r.varint();
    const entries: TickInput[] = [];
    for (let e = 0; e < count; e++) {
      const id = r.varint();
      const mask = r.varint();
      const p = prev.get(id) ?? { input: BLANK, extras: '', seq: 0 };
      const base: Record<string, unknown> = { ...p.input };
      if (mask & F.moveX) base.moveX = r.num();
      if (mask & F.moveZ) base.moveZ = r.num();
      if (mask & F.yaw) base.yaw = r.num();
      if (mask & F.pitch) base.pitch = r.num();
      if (mask & F.bools) { const wd = r.varint(); BOOLS.forEach((k, b) => { base[k] = (wd & (1 << b)) !== 0; }); }
      if (mask & F.slot) { const at = r.varint(); base.slot = at === 0 ? null : WEAPONS[at - 1]; }
      for (const k of JSONS) if (mask & JSON_BIT[k]) base[k] = r.json();
      if (mask & F.select) { const s = r.varint(); base.select = s === 0 ? null : s - 1; }
      if (mask & F.drop) base.drop = DROPS[r.varint()];
      let extras = p.extras;
      if (mask & F.extras) {
        // Remove the previous extras' keys, then apply the new ones.
        if (p.extras) for (const k of Object.keys(JSON.parse(p.extras))) delete base[k];
        extras = r.str();
      }
      if (extras) Object.assign(base, JSON.parse(extras));
      const input = base as PlayerInput;
      const mc = r.varint();
      let seq = p.seq;
      let moves: MoveCmd[] | undefined;
      if (mc > 0) {
        moves = [];
        for (let i = 0; i < mc - 1; i++) {
          seq = seq + 1 + r.zigzag();
          const fl = r.u8();
          const moveX = fl & 1 ? input.moveX : r.num();
          const moveZ = fl & 2 ? input.moveZ : r.num();
          const yaw = fl & 4 ? input.yaw : r.num();
          moves.push({ seq, moveX, moveZ, yaw, jump: (fl & 16) !== 0, sprint: (fl & 8) !== 0 });
        }
      }
      prev.set(id, { input, extras, seq });
      entries.push(moves ? { id, input, moves } : { id, input });
    }
    ticks[t] = entries;
  }
  return ticks;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A replay to encode; `ticks` may be a TickWriter the recorder filled as it went. */
export type ReplayParts = Omit<Replay, 'ticks'> & { ticks: TickInput[][] | TickWriter };

export async function encodeReplay(r: ReplayParts): Promise<Uint8Array> {
  const w = new Writer();
  w.json(r.header);
  w.json(r.footer);
  const tw = r.ticks instanceof TickWriter ? r.ticks : (() => { const t = new TickWriter(); for (const e of r.ticks as TickInput[][]) t.push(e); return t; })();
  w.varint(tw.count);
  w.raw(tw.bytes());
  w.json(r.ops);
  w.varint(r.hashes.length);
  for (const h of r.hashes) w.u32(h);
  w.json(r.events);
  w.json(r.seconds);
  const body = await pipe(w.bytes(), new CompressionStream('deflate-raw'));
  const out = new Uint8Array(5 + body.length);
  out.set(MAGIC, 0);
  out[4] = REPLAY_FORMAT;
  out.set(body, 5);
  return out;
}

export async function decodeReplay(bytes: Uint8Array): Promise<Replay> {
  if (bytes.length < 5 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('decodeReplay: not a .faereplay file');
  if (bytes[4] !== REPLAY_FORMAT) throw new Error(`decodeReplay: format ${bytes[4]} is not supported (this build reads ${REPLAY_FORMAT})`);
  let body: Uint8Array;
  try { body = await pipe(bytes.subarray(5), new DecompressionStream('deflate-raw')); }
  catch (err) { throw new Error(`decodeReplay: corrupt data (${(err as Error).message})`); }
  const r = new Reader(body);
  const header = r.json<Replay['header']>();
  const footer = r.json<Replay['footer']>();
  const ticks = readTicks(r);
  const ops = r.json<Replay['ops']>();
  const nh = r.varint();
  const hashes: number[] = [];
  for (let i = 0; i < nh; i++) hashes.push(r.u32());
  const events = r.json<Replay['events']>();
  const seconds = r.json<Replay['seconds']>();
  return { header, footer, ticks, ops, hashes, events, seconds };
}

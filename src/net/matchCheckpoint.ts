import { Match } from '../sim/match';
import { Physics, type PhysicsSave } from '../sim/physics';
import { MatchStats } from '../sim/stats';
import { Cosmetics } from '../sim/cosmetics';
import { Docks } from '../sim/docks';
import { HitboxHistory } from '../sim/lagComp';
import { Bot } from '../sim/bots/bot';
import { Aim } from '../sim/bots/aim';
import { Nav, WalkGrid } from '../sim/bots/nav';
import { Memory } from '../sim/bots/mind';
import { Brain } from '../sim/bots/brain';
import { Dodger } from '../sim/bots/tactics';
import { BunkerGrid } from '../sim/bots/escape';
import { BrainProbe } from '../sim/bots/introspect';
import { DoorwayTracker } from '../sim/seal';
import { Fire } from '../sim/fire';
import { PropSim, type PropSimSave } from '../sim/props';
import { Hazards } from '../sim/hazards';
import { Traps } from '../sim/traps';
import { WheelLimiter } from '../sim/emotes';
import { Banter } from '../sim/bots/banter';
import { mulberry32, isRng, type Rng } from '../sim/rng';
import { gunzip, gzip } from './checkpoint';

/**
 * Host migration checkpoints: the whole authoritative match (state, bots' minds, seeded rng, Rapier
 * world) as bytes, so a guest can take over as host and continue it exactly (it ticks identically to
 * the original from there on: tests/net/checkpoint.test.ts).
 *
 * Format (before gzip): "FFC1" | u32 json length | u32 Rapier snapshot length | json | Rapier bytes | typed-array bytes.
 * The json is the match's object graph with shared references and cycles kept (a value seen twice
 * is written once and referenced by id). Class instances are tagged by a fixed name (CLASSES below,
 * not constructor.name, so minified builds agree); an unknown class or closure throws: add it here.
 *
 * Worker-side only (it pulls in the whole sim). The compressed/encrypted envelope the network carries is
 * in checkpoint.ts.
 */

const MAGIC = 0x31434646; // "FFC1" little-endian
const CLASSES: Record<string, { prototype: object }> = { Match, MatchStats, Cosmetics, HitboxHistory, Bot, Aim, Nav, WalkGrid, Memory, BunkerGrid, DoorwayTracker, Fire, BrainProbe, WheelLimiter, Banter, Hazards, Traps, Docks, Brain, Dodger };
const TAG_OF = new Map<object, string>(Object.entries(CLASSES).map(([k, c]) => [c.prototype, k]));
const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = { Float64Array, Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array };
/**
 * Pure caches rebuilt from their constructor arguments instead of saved (most of a checkpoint's bytes
 * otherwise): bot walk grids (from the island and its cover) and bunker escape grids (bunker + pieces).
 */
const REBUILT: Record<string, (o: Record<string, unknown>) => unknown[]> = {
  WalkGrid: (g) => [g.node, g.boxes],
  BunkerGrid: (g) => [g.bunker, g.blockers],
};
/** Closures the bots keep from their last BotView (Nav.view): replaced on the next think(), never called before. */
const STALE_FNS = new Set(['groundAt', 'canPlace', 'canTrap', 'nextId', 'clearShot', 'castHook', 'props']);
/** Match fields rebuilt on restore instead of saved: combat callbacks bound to the instance, the native world, the bot factory. */
const SKIP = new Set(['ctx', 'fireCtx', 'hazardHost', 'grappleCtx', 'physics', 'makeBot']);

type J = null | boolean | number | string | J[] | { [k: string]: J };

class Encoder {
  private ids = new Map<unknown, number>();
  private chunks: Uint8Array[] = [];
  private binLen = 0;
  constructor(private physics: Physics) {}

  bin(): Uint8Array {
    const out = new Uint8Array(this.binLen);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  }

  private id(v: unknown): number {
    const id = this.ids.size;
    this.ids.set(v, id);
    return id;
  }

  value(v: unknown, path: string): J {
    if (v === undefined) return ['u'];
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return ['n', 'NaN'];
      if (v === Infinity) return ['n', 'Inf'];
      if (v === -Infinity) return ['n', '-Inf'];
      if (Object.is(v, -0)) return ['n', '-0'];
      return v;
    }
    const seen = this.ids.get(v);
    if (seen !== undefined) return ['r', seen];
    if (typeof v === 'function') {
      if (isRng(v)) return ['g', this.id(v), v.state.a];
      const key = path.slice(path.lastIndexOf('.') + 1);
      if (STALE_FNS.has(key)) return ['f'];
      throw new Error(`checkpoint: can't save the function at ${path}`);
    }
    if (typeof v !== 'object') throw new Error(`checkpoint: can't save a ${typeof v} at ${path}`);
    if (v === this.physics) return ['p'];
    // gameplay props: their own Rapier world, saved as a snapshot + plain data (PropSim.save)
    if (v instanceof PropSim) return ['P', this.id(v), this.value(v.save(), `${path}.save()`)];
    if (Array.isArray(v)) {
      const id = this.id(v);
      const items: J[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) items[i] = this.value(v[i], `${path}[${i}]`);
      return ['a', id, items];
    }
    if (v instanceof Map) {
      const id = this.id(v);
      const entries: J[] = [];
      for (const [k, x] of v) entries.push([this.value(k, `${path}.<key>`), this.value(x, `${path}.${String(k)}`)]);
      return ['m', id, entries];
    }
    if (v instanceof Set) {
      const id = this.id(v);
      const items: J[] = [];
      for (const x of v) items.push(this.value(x, `${path}.<item>`));
      return ['s', id, items];
    }
    if (ArrayBuffer.isView(v)) {
      const kind = v.constructor.name;
      if (!TYPED[kind]) throw new Error(`checkpoint: can't save a ${kind} at ${path}`);
      const id = this.id(v);
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      const off = this.binLen;
      this.chunks.push(bytes);
      this.binLen += bytes.byteLength;
      return ['t', id, kind, off, bytes.byteLength];
    }
    const proto = Object.getPrototypeOf(v);
    const tag = proto === Object.prototype || proto === null ? '' : TAG_OF.get(proto);
    if (tag === undefined) throw new Error(`checkpoint: can't save a ${proto?.constructor?.name ?? 'native'} object at ${path} (add its class to CLASSES)`);
    const rebuild = tag ? REBUILT[tag] : undefined;
    if (rebuild) {
      const args = rebuild(v as Record<string, unknown>).map((a, i) => this.value(a, `${path}(arg ${i})`));
      return ['c', this.id(v), tag!, args];
    }
    const id = this.id(v);
    const fields: Record<string, J> = {};
    for (const k of Object.keys(v)) {
      if (tag === 'Match' && SKIP.has(k)) continue;
      fields[k] = this.value((v as Record<string, unknown>)[k], `${path}.${k}`);
    }
    return ['o', id, tag, fields];
  }
}

class Decoder {
  private refs: unknown[] = [];
  constructor(private bin: Uint8Array, private physics: Physics) {}

  value(j: J): unknown {
    if (!Array.isArray(j)) return j;
    switch (j[0]) {
      case 'u': return undefined;
      case 'n': return j[1] === 'NaN' ? NaN : j[1] === 'Inf' ? Infinity : j[1] === '-Inf' ? -Infinity : -0;
      case 'r': {
        const id = j[1] as number;
        if (!(id in this.refs)) throw new Error(`checkpoint: dangling reference ${id}`);
        return this.refs[id];
      }
      case 'g': {
        const r: Rng = mulberry32(0);
        r.state.a = j[2] as number;
        this.refs[j[1] as number] = r;
        return r;
      }
      case 'f': return staleViewFn;
      case 'p': return this.physics;
      case 'P': {
        const out = PropSim.load(this.physics, this.value(j[2] as J) as PropSimSave);
        this.refs[j[1] as number] = out;
        return out;
      }
      case 'a': {
        const out: unknown[] = [];
        this.refs[j[1] as number] = out;
        for (const x of j[2] as J[]) out.push(this.value(x));
        return out;
      }
      case 'm': {
        const out = new Map();
        this.refs[j[1] as number] = out;
        for (const e of j[2] as J[][]) out.set(this.value(e[0]), this.value(e[1]));
        return out;
      }
      case 's': {
        const out = new Set();
        this.refs[j[1] as number] = out;
        for (const x of j[2] as J[]) out.add(this.value(x));
        return out;
      }
      case 't': {
        const [, id, kind, off, len] = j as [string, number, string, number, number];
        const Ctor = TYPED[kind];
        if (!Ctor) throw new Error(`checkpoint: unknown typed array ${kind}`);
        const out = new Ctor(this.bin.slice(off, off + len).buffer);
        this.refs[id] = out;
        return out;
      }
      case 'o': {
        const [, id, tag, fields] = j as [string, number, string, Record<string, J>];
        const cls = tag === '' ? null : CLASSES[tag];
        if (tag !== '' && !cls) throw new Error(`checkpoint: unknown class ${tag}`);
        const out = Object.create(cls ? cls.prototype : Object.prototype) as Record<string, unknown>;
        this.refs[id] = out;
        for (const k of Object.keys(fields)) out[k] = this.value(fields[k]);
        return out;
      }
      case 'c': {
        const [, id, tag, args] = j as [string, number, string, J[]];
        const cls = CLASSES[tag] as unknown as (new (...a: unknown[]) => object) | undefined;
        if (!cls || !REBUILT[tag]) throw new Error(`checkpoint: ${tag} is not rebuildable`);
        const out = new cls(...args.map((a) => this.value(a)));
        this.refs[id] = out;
        return out;
      }
      default: throw new Error(`checkpoint: bad tag ${String(j[0])}`);
    }
  }
}

function staleViewFn(): never {
  throw new Error('checkpoint: a bot used its previous tick\'s view after a restore');
}

type MatchInternals = { physics: Physics; makeBot?: unknown; makeCtx(): unknown; ctx: unknown };

/** The match as raw (uncompressed) checkpoint bytes. Synchronous: call it between ticks. */
export function saveMatch(m: Match): Uint8Array {
  const mi = m as unknown as MatchInternals;
  const phys: PhysicsSave = mi.physics.save();
  const enc = new Encoder(mi.physics);
  const root = enc.value(m, 'match');
  const { world, ...physRest } = phys;
  const json = new TextEncoder().encode(JSON.stringify({ root, physics: physRest }));
  const bin = enc.bin();
  const out = new Uint8Array(12 + json.byteLength + world.byteLength + bin.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, json.byteLength, true);
  dv.setUint32(8, world.byteLength, true);
  out.set(json, 12);
  out.set(world, 12 + json.byteLength);
  out.set(bin, 12 + json.byteLength + world.byteLength);
  return out;
}

/** Inverse of saveMatch: a live Match (with its own Rapier world) that continues exactly where the saved one was. */
export async function loadMatch(bytes: Uint8Array): Promise<Match> {
  if (bytes.byteLength < 12) throw new Error('checkpoint: truncated');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('checkpoint: not a match checkpoint (bad magic)');
  const jsonLen = dv.getUint32(4, true), worldLen = dv.getUint32(8, true);
  if (12 + jsonLen + worldLen > bytes.byteLength) throw new Error('checkpoint: truncated');
  const { root, physics } = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen))) as { root: J; physics: Omit<PhysicsSave, 'world'> };
  const world = bytes.slice(12 + jsonLen, 12 + jsonLen + worldLen);
  const ph = await Physics.load({ ...physics, world });
  const m = new Decoder(bytes.subarray(12 + jsonLen + worldLen), ph).value(root) as Match;
  if (!(m instanceof Match)) throw new Error('checkpoint: root is not a Match');
  const mi = m as unknown as MatchInternals;
  mi.physics = ph;
  mi.makeBot = (id: number, difficulty: ConstructorParameters<typeof Bot>[1], rng: () => number) => new Bot(id, difficulty, rng);
  m.rebind(); // combat + fire callbacks, fire's piece-id source
  return m;
}

/** saveMatch + gzip: what the host's worker hands the session every few seconds. */
export const packMatch = (m: Match) => gzip(saveMatch(m));
/** gunzip + loadMatch. */
export const unpackMatch = async (b: Uint8Array) => loadMatch(await gunzip(b));

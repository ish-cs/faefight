import type { MoveCmd } from '../sim/movement';
import { PIECES, WEAPONS } from '../sim/constants';
import { POTION_KINDS, validSlot } from '../sim/hotbar';
import type { BuildRequest, GunKind, Inventory, PieceKind, PlayerInput, ShopItem, TrapRequest, VaultAction, Vec3, WeaponKind } from '../sim/types';
import { clampSettings, isColor, type GameSettings } from '../sim/settings';
import { CHAT_MAX_LEN, type ClientMsg, type ViewExtras } from './protocol';
import { isWheelId } from '../sim/emotes';

// Everything from a remote peer is untrusted: rebuild each message field by field from known shapes.

const NAME_MAX = 16;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown, fallback = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const bool = (x: unknown) => x === true;
const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);

const PIECE_KINDS = Object.keys(PIECES) as PieceKind[];
const WEAPON_KINDS = Object.keys(WEAPONS) as WeaponKind[];
const GUN_KINDS = WEAPON_KINDS.filter((k): k is GunKind => k !== 'fists');
const SHOP_ITEMS: ShopItem[] = [
  ...PIECE_KINDS, ...GUN_KINDS, 'ammo', 'grenade', 'charge', 'medkit', 'trap', ...POTION_KINDS,
  'genUpgrade', ...GUN_KINDS.map((g) => `lock:${g}` as const),
];
const oneOf = <T extends string>(list: readonly T[], x: unknown): T | null => (list.includes(x as T) ? (x as T) : null);

/** Names that would pass for the host, the game or a bot tag. */
const RESERVED_NAMES = new Set(['host', 'system', 'server', 'admin', 'bot', 'you']);

/**
 * Player name from an untrusted peer: NFKC (folds fullwidth/compat look-alikes), no control, format
 * (zero-width, bidi override) or lone-surrogate chars, whitespace collapsed, ≤ NAME_MAX code points.
 * Reserved names become "Player". Null if nothing is left. Uniqueness is the lobby's job.
 */
export function cleanName(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const s = x.slice(0, NAME_MAX * 8).normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, (c) => (/\p{Cc}/u.test(c) ? ' ' : ''))
    .replace(/\s+/gu, ' ').trim();
  const name = [...s].slice(0, NAME_MAX).join('').trim();
  if (!name) return null;
  return RESERVED_NAMES.has(name.toLowerCase()) ? 'Player' : name;
}

function vec(x: unknown): Vec3 | null {
  if (!isObj(x)) return null;
  const v = { x: x.x, y: x.y, z: x.z };
  return [v.x, v.y, v.z].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e4) ? (v as Vec3) : null;
}

function buildReq(x: unknown): BuildRequest | null {
  if (!isObj(x)) return null;
  const kind = oneOf(PIECE_KINDS, x.kind);
  const pos = vec(x.pos);
  if (!kind || !pos || typeof x.rotY !== 'number' || !Number.isFinite(x.rotY)) return null;
  return { kind, pos, rotY: x.rotY, free: bool(x.free) };
}

function trapReq(x: unknown): TrapRequest | undefined {
  if (!isObj(x)) return undefined;
  const pos = vec(x.pos);
  if (!pos || typeof x.rotY !== 'number' || !Number.isFinite(x.rotY)) return undefined;
  return { pos, rotY: x.rotY, wall: bool(x.wall) };
}

function partialInv(x: unknown): Partial<Inventory> | null {
  if (!isObj(x)) return null;
  const out: Partial<Inventory> = {};
  for (const k of ['cash', 'grenades', 'charges', 'medkits', 'traps'] as const) {
    if (x[k] === undefined) continue;
    const n = count(x[k]);
    if (n === null) return null;
    out[k] = n;
  }
  if (x.pieces !== undefined) {
    if (!isObj(x.pieces)) return null;
    out.pieces = {};
    for (const [k, v] of Object.entries(x.pieces)) {
      const kind = oneOf(PIECE_KINDS, k), n = count(v);
      if (!kind || n === null) return null;
      out.pieces[kind] = n;
    }
  }
  if (x.potions !== undefined) {
    if (!isObj(x.potions)) return null;
    out.potions = {};
    for (const [k, v] of Object.entries(x.potions)) {
      const kind = oneOf(POTION_KINDS, k), n = count(v);
      if (!kind || n === null) return null;
      out.potions[kind] = n;
    }
  }
  if (x.weapons !== undefined) {
    if (!isObj(x.weapons)) return null;
    out.weapons = {};
    for (const k of Object.keys(x.weapons)) {
      const kind = oneOf(WEAPON_KINDS, k);
      if (!kind) return null;
      out.weapons[kind] = { mag: 0, spare: 0 }; // vault moves weapons by key only
    }
  }
  return out;
}

function vaultAction(x: unknown): VaultAction | null {
  if (!isObj(x)) return null;
  const out: VaultAction = {};
  if (x.deposit !== undefined) { const d = partialInv(x.deposit); if (!d) return null; out.deposit = d; }
  if (x.withdraw !== undefined) { const w = partialInv(x.withdraw); if (!w) return null; out.withdraw = w; }
  return out.deposit || out.withdraw ? out : null;
}

function moveSlot(x: unknown): PlayerInput['moveSlot'] {
  if (!isObj(x) || !validSlot(x.from) || !validSlot(x.to)) return null;
  return { from: x.from, to: x.to };
}

export function sanitizeInput(x: unknown): PlayerInput | null {
  if (!isObj(x)) return null;
  const shopItem = isObj(x.shop) ? oneOf(SHOP_ITEMS, x.shop.buy) : null;
  return {
    moveX: clamp(num(x.moveX), -1, 1),
    moveZ: clamp(num(x.moveZ), -1, 1),
    yaw: num(x.yaw),
    pitch: num(x.pitch),
    jump: bool(x.jump),
    sprint: bool(x.sprint),
    fire: bool(x.fire),
    ads: bool(x.ads),
    reload: bool(x.reload),
    interact: bool(x.interact),
    slot: oneOf(WEAPON_KINDS, x.slot),
    build: x.build == null ? null : buildReq(x.build),
    throwGrenade: bool(x.throwGrenade),
    placeCharge: bool(x.placeCharge),
    shop: shopItem ? { buy: shopItem } : null,
    vault: x.vault == null ? null : vaultAction(x.vault),
    select: validSlot(x.select) ? x.select : null,
    drop: oneOf(['one', 'stack'] as const, x.drop),
    moveSlot: moveSlot(x.moveSlot),
    useMedkit: bool(x.useMedkit),
    drink: bool(x.drink),
    ...(x.view === 0 || x.view === 1 ? { view: x.view } : {}),
    ...(typeof x.viewT === 'number' && Number.isFinite(x.viewT) ? { viewT: x.viewT } : {}),
    ...(x.trap != null && trapReq(x.trap) ? { trap: trapReq(x.trap) } : {}),
  };
}

/** Most movement commands accepted in one message (~30 Hz sends carry 1–2 normally). */
export const MAX_CMDS_PER_MSG = 8;
const MAX_SEQ = 2 ** 31;

/** Numbered movement commands; any malformed entry rejects the whole batch. */
export function moveCmds(x: unknown): MoveCmd[] | null {
  if (!Array.isArray(x) || x.length > MAX_CMDS_PER_MSG) return null;
  const out: MoveCmd[] = [];
  for (const c of x) {
    if (!isObj(c) || !Number.isInteger(c.seq) || (c.seq as number) < 1 || (c.seq as number) > MAX_SEQ) return null;
    if (typeof c.yaw !== 'number' || !Number.isFinite(c.yaw)) return null;
    out.push({
      seq: c.seq as number,
      moveX: clamp(num(c.moveX), -1, 1),
      moveZ: clamp(num(c.moveZ), -1, 1),
      yaw: c.yaw,
      jump: bool(c.jump),
      sprint: bool(c.sprint),
    });
  }
  return out;
}

const PANELS = ['shop', 'potions', 'vault'] as const;
const coord = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e4 ? x : null);

/** A player's ghost / open panel for spectators (ViewExtras), or null if malformed. */
export function sanitizeView(x: unknown): ViewExtras | null {
  if (!isObj(x)) return null;
  let ghost: ViewExtras['ghost'] = null;
  if (x.ghost != null) {
    const g = x.ghost;
    if (!isObj(g)) return null;
    const kind = oneOf(PIECE_KINDS, g.kind), px = coord(g.x), py = coord(g.y), pz = coord(g.z), rotY = coord(g.rotY);
    if (!kind || px === null || py === null || pz === null || rotY === null) return null;
    ghost = { kind, x: px, y: py, z: pz, rotY, ok: bool(g.ok) };
  }
  return { ghost, panel: oneOf(PANELS, x.panel), hover: oneOf(SHOP_ITEMS, x.hover) };
}

export function sanitizeClientMsg(x: unknown): ClientMsg | null {
  if (!isObj(x)) return null;
  switch (x.t) {
    case 'hello': {
      if (typeof x.name !== 'string' || typeof x.version !== 'number') return null;
      const name = cleanName(x.name);
      if (!name) return null;
      const rejoin = typeof x.rejoin === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(x.rejoin) ? x.rejoin : undefined;
      // Host migration: the checkpoint key this guest held, handed to the backup that now hosts (only with a rejoin token).
      const mkey = rejoin && typeof x.mkey === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(x.mkey) ? x.mkey : undefined;
      if (!rejoin) return { t: 'hello', name, version: x.version };
      return mkey ? { t: 'hello', name, version: x.version, rejoin, mkey } : { t: 'hello', name, version: x.version, rejoin };
    }
    case 'pong': {
      return Number.isInteger(x.n) && (x.n as number) > 0 ? { t: 'pong', n: x.n as number } : null;
    }
    case 'input': {
      const input = sanitizeInput(x.input);
      const cmds = x.cmds === undefined ? [] : moveCmds(x.cmds);
      if (!input || !cmds) return null;
      const ack = Number.isInteger(x.ack) && (x.ack as number) > 0 && (x.ack as number) <= MAX_SEQ ? (x.ack as number) : undefined;
      return ack === undefined ? { t: 'input', input, cmds } : { t: 'input', input, cmds, ack };
    }
    case 'preview': {
      const req = buildReq(x.req);
      return req && Number.isInteger(x.key) ? { t: 'preview', req, key: x.key as number } : null;
    }
    case 'follow':
      return x.id === null || (Number.isInteger(x.id) && (x.id as number) > 0 && (x.id as number) <= 64) ? { t: 'follow', id: x.id as number | null } : null;
    case 'view': {
      const v = sanitizeView(x.v);
      return v ? { t: 'view', v } : null;
    }
    case 'ready':
      return typeof x.ready === 'boolean' ? { t: 'ready', ready: x.ready } : null;
    case 'color':
      return isColor(x.color) ? { t: 'color', color: x.color } : null;
    case 'team':
      return Number.isInteger(x.team) && (x.team as number) >= 0 && (x.team as number) < 4 ? { t: 'team', team: x.team as number } : null;
    case 'chat':
      // Generous bound here; cleanChat trims to CHAT_MAX_LEN after stripping junk.
      return typeof x.text === 'string' && x.text.length <= CHAT_MAX_LEN * 4 ? { t: 'chat', text: x.text } : null;
    case 'wheel':
      // Only catalog ids (sim/emotes.ts): anything else is malformed.
      return isWheelId(x.id) ? { t: 'wheel', id: x.id } : null;
    default:
      return null;
  }
}

/**
 * Game settings from anywhere untrusted (the host's lobby message on a guest, localStorage, an old
 * recording): every field clamped to its slider range and step; missing / junk fields take the defaults.
 */
export function sanitizeSettings(x: unknown): GameSettings {
  return clampSettings(x);
}

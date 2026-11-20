import { PIECES, WEAPONS } from '../sim/constants';
import { validSlot } from '../sim/hotbar';
import type { BuildRequest, GunKind, Inventory, PieceKind, PlayerInput, ShopItem, VaultAction, Vec3, WeaponKind } from '../sim/types';
import { CHAT_MAX_LEN, type ClientMsg } from './protocol';

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
  ...PIECE_KINDS, ...GUN_KINDS, 'ammo', 'grenade', 'charge', 'medkit', 'genUpgrade', ...GUN_KINDS.map((g) => `lock:${g}` as const),
];
const oneOf = <T extends string>(list: readonly T[], x: unknown): T | null => (list.includes(x as T) ? (x as T) : null);

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

function partialInv(x: unknown): Partial<Inventory> | null {
  if (!isObj(x)) return null;
  const out: Partial<Inventory> = {};
  for (const k of ['cash', 'grenades', 'charges', 'medkits'] as const) {
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
  };
}

export function sanitizeClientMsg(x: unknown): ClientMsg | null {
  if (!isObj(x)) return null;
  switch (x.t) {
    case 'hello': {
      if (typeof x.name !== 'string' || typeof x.version !== 'number') return null;
      const name = x.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
      return name ? { t: 'hello', name, version: x.version } : null;
    }
    case 'input': {
      const input = sanitizeInput(x.input);
      return input ? { t: 'input', input } : null;
    }
    case 'preview': {
      const req = buildReq(x.req);
      return req && Number.isInteger(x.key) ? { t: 'preview', req, key: x.key as number } : null;
    }
    case 'chat':
      // Generous bound here; cleanChat trims to CHAT_MAX_LEN after stripping junk.
      return typeof x.text === 'string' && x.text.length <= CHAT_MAX_LEN * 4 ? { t: 'chat', text: x.text } : null;
    default:
      return null;
  }
}

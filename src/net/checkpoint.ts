import type { MapChoice } from '../sim/map';
import type { Slot } from './protocol';

/**
 * Host migration checkpoint envelope (main thread side): the gzipped match from the host's worker
 * (matchCheckpoint.ts) plus the session metadata the next host needs, AES-GCM encrypted with a key the
 * backup host is not given. The other guests hold the key and hand it over only when they reconnect to
 * the backup after losing the host (migration.ts), so the backup can't read anyone's inventory or
 * position early. See docs in migration.ts for the trade-off.
 */

// ---- compression ----

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (b: Uint8Array) => pipe(b, new CompressionStream('gzip'));
export const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream('gzip'));

// ---- envelope: session metadata + match, encrypted for the backup host ----

/** What the next host needs besides the match itself (written by the current host's session). */
export type SessionMeta = {
  /** Lobby seats at the time (names, which seat is the host, bots). */
  slots: Slot[];
  /** Seat → player id in this match. */
  seatIds: (number | null)[];
  /** islands[id - 1] = island of player id (sent with 'start'). */
  islands: number[];
  mapChoice: MapChoice;
  /** Rejoin tokens by seat: the new host checks them when the other guests reconnect. */
  tokens: [number, string][];
  /** The match tick of the checkpoint. */
  tick: number;
};

export type Checkpoint = { meta: SessionMeta; match: Uint8Array };

const toB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A fresh AES-GCM key for one backup host, as base64 (sent to every guest but the backup). */
export function newCheckpointKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(16)));
}

export const validCheckpointKey = (k: unknown): k is string => typeof k === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(k);

const importKey = (key: string, use: KeyUsage) => {
  if (!validCheckpointKey(key)) throw new Error('checkpoint: malformed key');
  return crypto.subtle.importKey('raw', fromB64(key) as BufferSource, 'AES-GCM', false, [use]);
};

/** meta + gzipped match → encrypted bytes (12-byte IV, then AES-GCM ciphertext). */
export async function sealCheckpoint(c: Checkpoint, key: string): Promise<ArrayBuffer> {
  const meta = new TextEncoder().encode(JSON.stringify(c.meta));
  const plain = new Uint8Array(4 + meta.byteLength + c.match.byteLength);
  new DataView(plain.buffer).setUint32(0, meta.byteLength, true);
  plain.set(meta, 4);
  plain.set(c.match, 4 + meta.byteLength);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key, 'encrypt'), plain));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, 12);
  return out.buffer;
}

/** Inverse of sealCheckpoint; throws on a wrong key or tampered bytes (GCM authenticates). */
export async function openCheckpoint(sealed: ArrayBuffer, key: string): Promise<Checkpoint> {
  const b = new Uint8Array(sealed);
  if (b.byteLength < 12 + 16 + 4) throw new Error('checkpoint: sealed data too short');
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, await importKey(key, 'decrypt'), b.subarray(12)));
  const metaLen = new DataView(plain.buffer).getUint32(0, true);
  if (4 + metaLen > plain.byteLength) throw new Error('checkpoint: bad envelope');
  const meta = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + metaLen))) as SessionMeta;
  return { meta, match: plain.slice(4 + metaLen) };
}

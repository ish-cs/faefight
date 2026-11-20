// THROWAWAY: minimal stand-ins for src/net/{lobby,chat,code,index,sanitize}.ts while those are being written
// by other agents. Delete once the real modules land and the client imports are switched over.
import type { MatchSetup } from '../sim/matchApi';
import { CHAT_MAX_LEN, MAX_PLAYERS, type Slot } from './protocol';
import type { HostRoom, Link, Transport } from './transport';

export class Lobby {
  private s: Slot[];
  constructor(hostName: string, hostPeerId: string) {
    this.s = [{ kind: 'human', name: hostName, peerId: hostPeerId, isHost: true }, { kind: 'open' }];
  }
  addHuman(name: string, peerId: string): number | null {
    const i = this.s.findIndex((x) => x.kind === 'open');
    if (i < 0) return null;
    this.s[i] = { kind: 'human', name, peerId, isHost: false };
    return i;
  }
  removePeer(peerId: string): number | null {
    const i = this.seatOf(peerId);
    if (i === null) return null;
    this.s[i] = { kind: 'open' };
    return i;
  }
  setSeat(i: number, slot: Slot): boolean {
    if (i <= 0 || i >= this.s.length || slot.kind === 'human') return false;
    this.s[i] = slot;
    return true;
  }
  addSeat(): boolean {
    if (this.s.length >= MAX_PLAYERS) return false;
    this.s.push({ kind: 'open' });
    return true;
  }
  removeSeat(i: number): boolean {
    if (i <= 0 || i >= this.s.length || this.s.length <= 2 || this.s[i].kind === 'human') return false;
    this.s.splice(i, 1);
    return true;
  }
  slots(): Slot[] { return this.s.map((x) => ({ ...x })); }
  seatOf(peerId: string): number | null {
    const i = this.s.findIndex((x) => x.kind === 'human' && x.peerId === peerId);
    return i < 0 ? null : i;
  }
  toMatchSetup(): MatchSetup {
    return {
      players: this.s.map((x, i) => {
        if (x.kind === 'human') return { name: x.name, isBot: false };
        if (x.kind === 'bot') return { name: `Bot ${i + 1}`, isBot: true, difficulty: x.difficulty };
        throw new Error('open seat');
      }),
    };
  }
}

export function cleanChat(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX_LEN);
  return t ? t : null;
}

export class ChatLimiter {
  private last = new Map<string, number[]>();
  allow(sender: string, nowMs: number): boolean {
    const recent = (this.last.get(sender) ?? []).filter((t) => nowMs - t < 1000);
    if (recent.length >= 2) { this.last.set(sender, recent); return false; }
    recent.push(nowMs);
    this.last.set(sender, recent);
    return true;
  }
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function normalizeCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, '');
  return c.length === 6 && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

// ---- BroadcastChannel transport (same-browser tabs) ----
type Wire =
  | { k: 'join'; from: string }
  | { k: 'accept'; from: string; to: string }
  | { k: 'msg'; from: string; to: string; data: unknown }
  | { k: 'close'; from: string; to: string }
  | { k: 'ping'; from: string; to: string };

const rid = () => Math.random().toString(36).slice(2, 10);

function makeLink(ch: BroadcastChannel, me: string, peer: string): Link & { recv(w: Wire): void } {
  const msgCbs: ((m: unknown) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let open = true, lastSeen = Date.now();
  const shut = (notify: boolean) => {
    if (!open) return;
    open = false;
    clearInterval(hb);
    if (notify) ch.postMessage({ k: 'close', from: me, to: peer } satisfies Wire);
    closeCbs.forEach((c) => c());
  };
  const hb = setInterval(() => {
    if (Date.now() - lastSeen > 3000) { shut(false); return; }
    ch.postMessage({ k: 'ping', from: me, to: peer } satisfies Wire);
  }, 500);
  addEventListener('pagehide', () => shut(true));
  return {
    peerId: peer,
    send: (data) => { if (open) ch.postMessage({ k: 'msg', from: me, to: peer, data } satisfies Wire); },
    onMessage: (cb) => msgCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => shut(true),
    recv: (w) => {
      if (!open || !('from' in w) || w.from !== peer) return;
      lastSeen = Date.now();
      if (w.k === 'msg') msgCbs.forEach((c) => c(w.data));
      else if (w.k === 'close') shut(false);
    },
  };
}

class BroadcastTransport implements Transport {
  async host(): Promise<HostRoom> {
    const code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    const me = rid();
    const ch = new BroadcastChannel(`faefight-${code}`);
    const links = new Map<string, ReturnType<typeof makeLink>>();
    let joinCb: ((l: Link) => void) | null = null;
    ch.onmessage = (e: MessageEvent<Wire>) => {
      const w = e.data;
      if (w.k === 'join') {
        const l = makeLink(ch, me, w.from);
        links.set(w.from, l);
        l.onClose(() => links.delete(w.from));
        ch.postMessage({ k: 'accept', from: me, to: w.from } satisfies Wire);
        joinCb?.(l);
      } else if ('to' in w && w.to === me && 'from' in w) links.get(w.from)?.recv(w);
    };
    return { code, onJoin: (cb) => { joinCb = cb; }, close: () => { links.forEach((l) => l.close()); ch.close(); } };
  }

  join(code: string): Promise<Link> {
    const me = rid();
    const ch = new BroadcastChannel(`faefight-${code}`);
    return new Promise((resolve, reject) => {
      let link: ReturnType<typeof makeLink> | null = null;
      const t = setTimeout(() => { ch.close(); reject(new Error('Room not found')); }, 3000);
      ch.onmessage = (e: MessageEvent<Wire>) => {
        const w = e.data;
        if (!link && w.k === 'accept' && w.to === me) {
          clearTimeout(t);
          link = makeLink(ch, me, w.from);
          resolve(link);
        } else if (link && 'to' in w && w.to === me) link.recv(w);
      };
      ch.postMessage({ k: 'join', from: me } satisfies Wire);
    });
  }
}

export function pickTransport(search: string): Transport {
  if (new URLSearchParams(search).get('net') === 'local') return new BroadcastTransport();
  return {
    host: () => Promise.reject(new Error('PeerJS transport not available in stub')),
    join: () => Promise.reject(new Error('PeerJS transport not available in stub')),
  };
}

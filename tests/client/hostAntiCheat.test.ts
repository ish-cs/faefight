import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { HostSession as HostSessionT } from '../../src/client/session';
import { LoopbackTransport } from '../../src/net/loopback';
import { NET_VERSION } from '../../src/net/protocol';
import { WireDecoder } from '../../src/net/wire';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type Snapshot } from '../../src/sim/types';
import { add, rotateY, v3 } from '../../src/sim/vec';

let HostSession: typeof HostSessionT;
beforeAll(async () => {
  (globalThis as any).addEventListener ??= () => {};
  ({ HostSession } = await import('../../src/client/session'));
});

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

async function host() {
  const t = new LoopbackTransport();
  const chats: string[] = [];
  const h = await HostSession.create(t, 'Alice', { lobby: () => {}, chat: (from, text) => chats.push(`${from}: ${text}`) });
  return { t, h, chats };
}

async function friend(t: LoopbackTransport, h: HostSessionT, name: string) {
  const link = await t.join(h.code);
  const got: any[] = [];
  let closed = false;
  link.onMessage((m) => got.push(m));
  link.onClose(() => { closed = true; });
  link.send({ t: 'hello', name, version: NET_VERSION });
  await flush();
  return { link, got, isClosed: () => closed };
}

function startWithWorker(h: HostSessionT) {
  const posted: any[] = [];
  h.setSeat(1, { kind: 'bot', difficulty: 'easy' }); // no-op if seat 1 is human
  h.start({ postMessage: (m: any) => posted.push(m) });
  return posted;
}

describe('HostSession anti-cheat', () => {
  test('an input flood is throttled, then the peer is disconnected with a reason', async () => {
    const { t, h } = await host();
    const f = await friend(t, h, 'Bob');
    const posted = startWithWorker(h);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3000; i++) f.link.send({ t: 'input', input: NO_INPUT });
    await flush();
    await new Promise((r) => setTimeout(r, 300));
    warn.mockRestore();
    const inputs = posted.filter((m) => m.type === 'remoteInput').length;
    expect(inputs).toBeGreaterThan(0);
    expect(inputs).toBeLessThanOrEqual(250);
    expect(f.got.some((m) => m.t === 'ended' && m.reason === 'flood')).toBe(true);
    expect(f.isClosed()).toBe(true);
    expect(posted.some((m) => m.type === 'botify' && m.playerId === 2)).toBe(true);
  });

  test('a normal 30 Hz client is never throttled', async () => {
    const { t, h } = await host();
    const f = await friend(t, h, 'Bob');
    const posted = startWithWorker(h);
    const now = vi.spyOn(Date, 'now');
    let ms = Date.now();
    now.mockImplementation(() => ms);
    for (let i = 0; i < 300; i++) { f.link.send({ t: 'input', input: NO_INPUT }); ms += 33; await flush(1); }
    await flush();
    now.mockRestore();
    expect(posted.filter((m) => m.type === 'remoteInput').length).toBe(300);
    expect(f.isClosed()).toBe(false);
  });

  test('joiners cannot impersonate the host or each other', async () => {
    const { t, h } = await host();
    await friend(t, h, 'alice');
    await friend(t, h, 'Ho\u200bst');
    await friend(t, h, '\u202eBob');
    await friend(t, h, 'Bob');
    const names = h.lobby.slots().map((s) => (s.kind === 'human' ? s.name : null));
    expect(names).toEqual(['Alice', 'alice 2', 'Player', 'Bob', 'Bob 2']);
  });

  test('chat from a joiner is shown under the seat name, not a claimed one', async () => {
    const { t, h, chats } = await host();
    const f = await friend(t, h, 'Alice');
    f.link.send({ t: 'chat', text: 'hi', from: 'Alice' });
    await flush();
    expect(chats).toEqual(['Alice 2: hi']);
  });

  test('oversized messages are dropped before sanitizing', async () => {
    const { t, h, chats } = await host();
    const f = await friend(t, h, 'Bob');
    f.link.send({ t: 'chat', text: 'x'.repeat(50_000) });
    f.link.send({ t: 'chat', text: 'ok', junk: Array.from({ length: 5000 }, (_, i) => i) });
    await flush();
    expect(chats).toEqual([]);
  });

  test('a joiner cannot drive host functions (start, kick, seats)', async () => {
    const { t, h } = await host();
    const f = await friend(t, h, 'Bob');
    const before = JSON.stringify(h.lobby.slots());
    for (const m of [
      { t: 'start' }, { t: 'kick', seat: 0 }, { t: 'setSeat', i: 1, slot: { kind: 'open' } }, { t: 'addSeat' },
      { t: 'lobby', slots: [], you: 0 }, { t: 'ended', reason: 'host-left' }, { t: 'rematch' }, { t: 'hello', name: 'Zed', version: NET_VERSION },
    ]) f.link.send(m);
    await flush();
    expect(JSON.stringify(h.lobby.slots())).toBe(before);
    expect(h.canStart()).toBe(true);
    expect(f.isClosed()).toBe(false);
  });

  test('snapshots to a remote client go through interest management', async () => {
    const { t, h } = await host();
    const f = await friend(t, h, 'Bob');
    startWithWorker(h);
    const map = buildMap(2);
    h.onMap(map, [0, 1]);
    // Host (id 1) hides in its bunker's back corner; Bob (id 2) stands on his island.
    const b = map[0].bunker;
    const corner = add(b.center, rotateY(v3(1.5, 0, 1.5), b.facingYaw));
    const p1 = newPlayer(1, 'Alice', false, 0, v3(corner.x, map[0].groundY, corner.z));
    p1.inv.cash = 4321;
    const p2 = newPlayer(2, 'Bob', false, 1, map[1].center);
    const snap: Snapshot = {
      time: 5, tick: 150, players: [p1, p2], pieces: [], loot: [], generators: [{ island: 0, stored: 99 }, { island: 1, stored: 5 }], genLevels: [1, 1],
      sealed: [false, false], waterY: 0, suddenDeath: false, winner: null, events: [],
    };
    h.onSnapshot(snap);
    await flush();
    const wb = f.got.find((m) => m.t === 'snap')?.b;
    const s = wb && new WireDecoder().decode<any>(wb);
    expect(s).toBeDefined();
    expect(s.hidden).toEqual([1]);
    const hostP = s.players.find((p: any) => p.id === 1);
    expect(hostP.inv).toBeUndefined();
    expect(Math.hypot(hostP.pos.x - corner.x, hostP.pos.z - corner.z)).toBeGreaterThan(1);
    expect(s.generators[0].stored).toBe(0);
    expect(s.generators[1].stored).toBe(5);
  });

  test("'follow' gets a dead spectator the followed player's kit and brain, never a living one", async () => {
    const { t, h } = await host();
    const f = await friend(t, h, 'Bob');
    startWithWorker(h);
    const map = buildMap(2);
    h.onMap(map, [0, 1]);
    const p1 = newPlayer(1, 'Alice', false, 0, map[0].center);
    p1.inv.cash = 4321;
    const p2 = newPlayer(2, 'Bob', false, 1, map[1].center);
    const brain = { id: 1, personality: 'Turtle', difficulty: 'easy' as const, action: 'shop', goal: null, reason: '', steps: [], step: -1, fightOdds: null, thought: 'hm', target: null, options: [] };
    const snapAt = (tick: number): Snapshot => ({
      time: tick / 30, tick, players: [p1, p2], pieces: [], loot: [], generators: [{ island: 0, stored: 0 }, { island: 1, stored: 0 }], genLevels: [1, 1],
      sealed: [false, false], waterY: 0, suddenDeath: false, winner: null, events: [], brains: [brain],
    });
    const dec = new WireDecoder();
    const last = () => { const snaps = f.got.filter((m) => m.t === 'snap'); return dec.decode<any>(snaps[snaps.length - 1].b); };
    f.link.send({ t: 'follow', id: 1 });
    await flush();
    h.onSnapshot(snapAt(150));
    await flush();
    let s = last();
    expect(s.players.find((p: any) => p.id === 1).inv).toBeUndefined(); // Bob is alive
    expect(s.brain).toBeUndefined();
    p2.alive = false;
    p2.respawnAt = 10;
    h.onSnapshot(snapAt(151));
    await flush();
    s = last();
    expect(s.players.find((p: any) => p.id === 1).inv.cash).toBe(4321);
    expect(s.brain?.thought).toBe('hm');
  });
});

import { beforeAll, describe, expect, test } from 'vitest';
import type { HostSession as HostSessionT } from '../../src/client/session';
import { LoopbackTransport } from '../../src/net/loopback';
import { NET_VERSION } from '../../src/net/protocol';
import { newPlayer } from '../../src/sim/player';
import type { MatchEvent, PieceState, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

let HostSession: typeof HostSessionT;
beforeAll(async () => {
  (globalThis as any).addEventListener ??= () => {};
  ({ HostSession } = await import('../../src/client/session'));
});

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const MAP = [] as never[];

function fakeWorker() {
  const posted: any[] = [];
  return { posted, postMessage: (m: any) => posted.push(m) };
}

function snap(tick: number, pieces: PieceState[] = [], events: MatchEvent[] = [], winner: number | null = null): Snapshot {
  const players = [1, 2, 3].map((id) => newPlayer(id, `p${id}`, id === 3, id - 1, v3(id * 10, 2, 0)));
  return { time: tick / 30, tick, players, pieces, loot: [], generators: [], genLevels: [1, 1, 1], sealed: [false, false, false], waterY: 0, suddenDeath: false, winner, events };
}

async function join(t: LoopbackTransport, code: string, name: string) {
  const link = await t.join(code);
  const got: any[] = [];
  let closed = false;
  link.onMessage((m) => got.push(m));
  link.onClose(() => { closed = true; });
  link.send({ t: 'hello', name, version: NET_VERSION });
  await flush();
  return { link, got, isClosed: () => closed };
}

/** Host + Bob (human) + an easy bot, match started on worker #1. */
async function startedMatch() {
  const t = new LoopbackTransport();
  const host = await HostSession.create(t, 'Alice', { lobby: () => {}, chat: () => {} });
  const bob = await join(t, host.code, 'Bob');
  host.addSeat();
  host.setSeat(2, { kind: 'bot', difficulty: 'easy' });
  const w1 = fakeWorker();
  const first = host.start(w1);
  host.onMap(MAP, [0, 1, 2]);
  await flush();
  return { t, host, bob, w1, first };
}

describe('HostSession rematch', () => {
  test('restart reuses the same seats: humans, bots with their nicknames and difficulties', async () => {
    const { host, bob, first } = await startedMatch();
    const botName = first.setup.players[2].name;
    expect(first.setup.players[2]).toMatchObject({ isBot: true, difficulty: 'easy' });
    const w2 = fakeWorker();
    const again = host.restart(w2);
    expect(again).toEqual(first);
    expect(again.setup.players.map((p) => p.name)).toEqual(['Alice', 'Bob', botName]);
    bob.got.length = 0;
    host.onMap(MAP, [0, 1, 2]);
    await flush();
    expect(bob.got).toEqual([{ t: 'start', map: MAP, playerId: 2, island: 1 }]);
    expect(bob.isClosed()).toBe(false);
  });

  test("after a restart, the friend's inputs go to the new worker only", async () => {
    const { host, bob, w1 } = await startedMatch();
    const w2 = fakeWorker();
    host.restart(w2);
    w1.posted.length = 0;
    bob.link.send({ t: 'input', input: { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, reload: false, interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null } });
    await flush();
    expect(w1.posted).toEqual([]);
    expect(w2.posted.filter((m) => m.type === 'remoteInput').map((m) => m.playerId)).toEqual([2]);
  });

  test('the new match starts with a fresh snapshot stream (pieces resent, no old events)', async () => {
    const { host, bob } = await startedMatch();
    const wall: PieceState = { id: 9, kind: 'steel', owner: 1, pos: v3(0, 0, 0), rotY: 0, hp: 1200 };
    host.onSnapshot(snap(10, [wall], [{ t: 0.3, type: 'shot', data: { by: 1 } }], 1));
    host.onSnapshot(snap(11, [wall], [{ t: 0.33, type: 'shot', data: { by: 1 } }], 1)); // odd tick: not sent, events kept
    host.restart(fakeWorker());
    host.onMap(MAP, [0, 1, 2]);
    await flush();
    bob.got.length = 0;
    host.onSnapshot(snap(1));
    await flush();
    const msgs = bob.got.filter((m) => m.t === 'snap');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].s.tick).toBe(1);
    expect(msgs[0].s.pieces).toEqual([]);
    expect(msgs[0].s.events).toEqual([]);
    expect(msgs[0].s.winner).toBeNull();
  });

  test('a friend who left mid-match is replaced by a bot in the rematch', async () => {
    const { host, bob } = await startedMatch();
    bob.link.close();
    await flush();
    const again = host.restart(fakeWorker());
    expect(again.setup.players).toHaveLength(3);
    expect(again.setup.players[1]).toMatchObject({ isBot: true, difficulty: 'medium' });
    expect(again.setup.players[1].name).not.toBe('Bob');
    expect(again.setup.players[1].name).not.toBe('');
  });

  test('restart before the first start is an error', async () => {
    const t = new LoopbackTransport();
    const host = await HostSession.create(t, 'Alice', { lobby: () => {}, chat: () => {} });
    expect(() => host.restart(fakeWorker())).toThrow(/not started/);
  });

  test('back to lobby: friends get the lobby again, seats can be edited and a new friend can join', async () => {
    const { t, host, bob } = await startedMatch();
    const lobbies: any[] = [];
    (host as any).ev.lobby = (s: any) => lobbies.push(s);
    bob.got.length = 0;
    host.backToLobby();
    await flush();
    expect(bob.got).toHaveLength(1);
    expect(bob.got[0]).toMatchObject({ t: 'lobby', you: 1 });
    expect(bob.got[0].slots.map((s: any) => s.kind)).toEqual(['human', 'human', 'bot']);
    expect(lobbies).toHaveLength(1);
    expect(host.canStart()).toBe(true);
    host.addSeat();
    const carol = await join(t, host.code, 'Carol');
    expect(carol.got[0]).toMatchObject({ t: 'lobby', you: 3 });
    expect(host.canStart()).toBe(true);
    const next = host.start(fakeWorker());
    expect(next.setup.players.map((p) => p.name)).toEqual(['Alice', 'Bob', expect.any(String), 'Carol']);
  });

  test('back to lobby frees the seat of a friend who left', async () => {
    const { host, bob } = await startedMatch();
    bob.link.close();
    await flush();
    host.backToLobby();
    expect(host.lobby.slots()[1]).toEqual({ kind: 'open' });
    expect(host.canStart()).toBe(false);
  });
});

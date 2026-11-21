import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { HostSession as HostSessionT } from '../../src/client/session';
import { LoopbackTransport } from '../../src/net/loopback';
import { NET_VERSION } from '../../src/net/protocol';
import { sanitizeClientMsg } from '../../src/net/sanitize';
import { SnapshotEncoder } from '../../src/net/snapshotCodec';
import { WireDecoder, WireEncoder } from '../../src/net/wire';
import { WHEEL_IDS } from '../../src/sim/emotes';
import { newPlayer } from '../../src/sim/player';
import type { Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

let HostSession: typeof HostSessionT;
beforeAll(async () => {
  (globalThis as any).addEventListener ??= () => {};
  ({ HostSession } = await import('../../src/client/session'));
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sanitize: wheel messages', () => {
  test('every catalog id passes, rebuilt field by field', () => {
    for (const id of WHEEL_IDS) expect(sanitizeClientMsg({ t: 'wheel', id, extra: 'x' })).toEqual({ t: 'wheel', id });
  });
  test('bad emote / quick-chat ids are rejected', () => {
    for (const id of ['moonwalk', 'GG', 'Wave', '', ' gg', 'gg ', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 3, null, undefined, true, ['gg'], { id: 'gg' }]) {
      expect(sanitizeClientMsg({ t: 'wheel', id })).toBeNull();
    }
    expect(sanitizeClientMsg({ t: 'wheel' })).toBeNull();
  });
});

async function startedHostWithFriend() {
  const t = new LoopbackTransport();
  const chats: { from: string; text: string }[] = [];
  const host = await HostSession.create(t, 'Alice', { lobby: () => {}, chat: (from, text) => chats.push({ from, text }) });
  const link = await t.join(host.code);
  const got: any[] = [];
  link.onMessage((m) => got.push(m));
  link.send({ t: 'hello', name: 'Bob', version: NET_VERSION });
  await flush(); await flush();
  const posted: any[] = [];
  (host as any).started = true;
  (host as any).seatIds = [1, 2];
  (host as any).hostPlayerId = 1;
  (host as any).worker = { postMessage: (m: any) => posted.push(m) };
  return { host, link, got, posted, chats };
}

describe('host session: wheel', () => {
  test('a friend gets at most one wheel action per 2 s through to the sim', async () => {
    const { link, posted } = await startedHostWithFriend();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (let i = 0; i < 20; i++) link.send({ t: 'wheel', id: i % 2 ? 'wave' : 'gg' });
    await flush(); await flush();
    expect(posted.filter((m) => m.type === 'wheel')).toEqual([{ type: 'wheel', playerId: 2, id: 'gg' }]);
    info.mockRestore();
  });

  test('a bad id from a friend never reaches the sim', async () => {
    const { link, posted } = await startedHostWithFriend();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    link.send({ t: 'wheel', id: 'moonwalk' });
    await flush(); await flush();
    expect(posted.some((m) => m.type === 'wheel')).toBe(false);
    warn.mockRestore();
  });

  test('the host has its own budget, not shared with friends', async () => {
    const { host, link, posted } = await startedHostWithFriend();
    host.localWheel('wave');
    link.send({ t: 'wheel', id: 'gg' });
    await flush(); await flush();
    expect(posted.filter((m) => m.type === 'wheel').map((m) => m.playerId).sort()).toEqual([1, 2]);
  });

  test("quick chat in the sim's events becomes a chat line from that player for everyone", async () => {
    const { host, got, chats } = await startedHostWithFriend();
    const players = [newPlayer(1, 'Alice', false, 0, v3()), newPlayer(2, 'Bob', false, 1, v3())];
    const snap: Snapshot = {
      time: 1, tick: 30, players, pieces: [], loot: [], projectiles: [], generators: [], genLevels: [1, 1], sealed: [false, false],
      waterY: 0, suddenDeath: false, winner: null, potionShops: [],
      events: [{ t: 1, type: 'wheel', data: { by: 2, id: 'gg' } }, { t: 1, type: 'wheel', data: { by: 1, id: 'wave' } }],
    };
    host.onSnapshot(snap);
    await flush();
    expect(chats).toEqual([{ from: 'Bob', text: 'GG' }]); // emotes are not chat
    expect(got.filter((m) => m.t === 'chat')).toEqual([{ t: 'chat', from: 'Bob', text: 'GG' }]);
  });
});

test('8 players all emoting and chatting still fit the binary snapshot budget', () => {
  const enc = new SnapshotEncoder(), wire = new WireEncoder(), dec = new WireDecoder();
  const players = Array.from({ length: 8 }, (_, i) => newPlayer(i + 1, 'p' + i, true, i, v3(i * 10.123456, 2, 3.333333)));
  const s: Snapshot = {
    time: 1, tick: 1, players, pieces: [], loot: [], projectiles: [], generators: [], genLevels: Array(8).fill(1), sealed: Array(8).fill(false),
    waterY: 0, suddenDeath: false, winner: null, potionShops: [], events: [],
  };
  enc.push(s);
  dec.decode(wire.encode(1, enc.take(1, true)));
  wire.ack(dec.ack);
  for (const p of players) {
    p.pos = v3(p.pos.x + 0.17, p.pos.y, p.pos.z - 0.11);
    p.emote = { id: 'dance', at: 1.0333333333333 };
    p.quip = { id: 'niceShot', at: 1.0333333333333 };
  }
  const events = players.map((p) => ({ t: 1.0333333333333, type: 'wheel' as const, data: { by: p.id, id: 'gg' } }));
  enc.push({ ...s, tick: 2, time: 2 / 30, events });
  const delta = wire.encode(2, enc.take(1, true));
  expect(delta.byteLength).toBeLessThan((20 * 1024) / 30);
  const back = dec.decode<any>(delta);
  expect(back.players[3].emote).toEqual({ id: 'dance', at: 1.033 });
});

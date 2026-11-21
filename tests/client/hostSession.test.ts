import { buildMapDef } from '../../src/sim/map';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { HostSession as HostSessionT } from '../../src/client/session';
import { LoopbackTransport } from '../../src/net/loopback';
import { NET_VERSION } from '../../src/net/protocol';
import { NO_INPUT } from '../../src/sim/types';

let HostSession: typeof HostSessionT;
beforeAll(async () => {
  (globalThis as any).addEventListener ??= () => {};
  ({ HostSession } = await import('../../src/client/session'));
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function hostWithFriend() {
  const t = new LoopbackTransport();
  const host = await HostSession.create(t, 'Alice', { lobby: () => {}, chat: () => {} });
  const link = await t.join(host.code);
  const got: any[] = [];
  let closed = false;
  link.onMessage((m) => got.push(m));
  link.onClose(() => { closed = true; });
  link.send({ t: 'hello', name: 'Bob', version: NET_VERSION });
  await flush(); await flush();
  return { host, link, got, isClosed: () => closed };
}

describe('HostSession', () => {
  test('host can kick a joined friend from the lobby', async () => {
    const { host, got, isClosed } = await hostWithFriend();
    expect(host.lobby.slots()[1]).toMatchObject({ kind: 'human', name: 'Bob' });
    host.kick(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(got.some((m) => m.t === 'ended' && m.reason === 'kicked')).toBe(true);
    expect(isClosed()).toBe(true);
    expect(host.lobby.slots()[1]).toEqual({ kind: 'open' });
  });

  test('preview requests from one friend are rate limited', async () => {
    const { host, link } = await hostWithFriend();
    const posted: any[] = [];
    (host as any).started = true;
    (host as any).seatIds = [1, 2];
    (host as any).worker = { postMessage: (m: any) => posted.push(m) };
    const req = { kind: 'wood', pos: { x: 0, y: 2, z: 0 }, rotY: 0, free: false };
    for (let i = 0; i < 200; i++) link.send({ t: 'preview', req, key: i });
    await flush(); await flush();
    const previews = posted.filter((m) => m.type === 'preview').length;
    expect(previews).toBeGreaterThan(0);
    expect(previews).toBeLessThanOrEqual(30);
  });

  test('/spectate in the lobby: host seat excluded from MatchSetup, friends renumbered', async () => {
    const { host, link, got } = await hostWithFriend();
    host.addSeat();
    host.setSeat(2, { kind: 'bot', difficulty: 'hard' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = host.toggleSpectate();
    expect(r.handoff).toBe(false);
    await flush();
    const lobbyMsg = got.filter((m) => m.t === 'lobby').at(-1);
    expect(lobbyMsg.slots[0]).toMatchObject({ isHost: true, spectator: true });
    const posted: any[] = [];
    const { setup, humanId } = host.start({ postMessage: (m) => posted.push(m) });
    expect(humanId).toBe(0);
    expect(setup.players.map((p) => p.name)).toEqual(['Bob', (host.lobby.slots()[2] as any).name]);
    expect(host.hostPlayer).toBeNull();
    // Bob (seat 1) is player 1 now: his start message and his inputs use that id.
    host.onMap(buildMapDef(2), [4, 6]);
    await flush();
    expect(got.find((m) => m.t === 'start')).toMatchObject({ playerId: 1, island: 4 });
    link.send({ t: 'input', input: NO_INPUT });
    await flush(); await flush();
    const inputs = posted.filter((m) => m.type === 'remoteInput');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0].playerId).toBe(1);
    // Toggling mid-match while already spectating only affects the next match.
    expect(host.toggleSpectate()).toEqual({ text: 'You can rejoin as a player next match.', handoff: false });
    expect(posted.some((m) => m.type === 'botify')).toBe(false);
    expect(host.restart({ postMessage: () => {} }).humanId).toBe(1);
    info.mockRestore();
  });

  test('/spectate mid-match hands the host player to a bot; again → rejoin next match', async () => {
    const { host } = await hostWithFriend();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const posted: any[] = [];
    const chat: string[] = [];
    (host as any).ev.chat = (_: string, text: string) => chat.push(text);
    host.addSeat();
    host.setSeat(2, { kind: 'bot', difficulty: 'medium' });
    expect(host.start({ postMessage: (m) => posted.push(m) }).humanId).toBe(1);
    const r = host.toggleSpectate();
    expect(r.handoff).toBe(true);
    expect(posted).toContainEqual({ type: 'botify', playerId: 1 });
    expect(chat.some((t) => /spectating/.test(t))).toBe(true);
    expect(host.hostPlayer).toBeNull();
    const again = host.toggleSpectate();
    expect(again).toEqual({ text: 'You can rejoin as a player next match.', handoff: false });
    expect(posted.filter((m) => m.type === 'botify')).toHaveLength(1);
    // Rematch: the host plays again (it asked to); a third toggle would have kept it spectating.
    expect(host.restart({ postMessage: () => {} }).humanId).toBe(1);
    host.toggleSpectate(); // hand off again in the rematch
    const re = host.restart({ postMessage: () => {} });
    expect(re.humanId).toBe(0);
    expect(re.setup.players.map((p) => p.name)).toEqual(['Bob', (host.lobby.slots()[2] as any).name]);
    // Too few seats left to keep spectating: the host is put back in rather than failing the rematch.
    host.toggleSpectate(); host.toggleSpectate(); // (spectating stays on for the next match)
    host.lobby.removeSeat(2);
    expect(host.restart({ postMessage: () => {} }).humanId).toBe(1);
    info.mockRestore();
  });

  test('/money credits the host player through the worker; guests cannot trigger it', async () => {
    const { host, link } = await hostWithFriend();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const posted: any[] = [];
    expect(host.giveMoney(500)).toBe('/money only works during a match');
    expect(host.start({ postMessage: (m) => posted.push(m) }).humanId).toBe(1);
    expect(host.giveMoney(500)).toBe('+$500 (host command)');
    expect(posted).toContainEqual({ type: 'debug', cmd: 'give', inv: { cash: 500 }, id: 1 });
    // Re-validated even though parseCommand already did.
    for (const bad of [0, -1, 1.5, NaN, 100_001]) expect(host.giveMoney(bad)).toMatch(/Usage: \/money <amount>/);
    // A guest typing it (or a forged message) never reaches the sim.
    link.send({ t: 'chat', text: '/money 100000' });
    link.send({ t: 'money', amount: 100000 });
    link.send({ t: 'debug', cmd: 'give', inv: { cash: 100000 } });
    await flush(); await flush();
    expect(posted.filter((m) => m.type === 'debug')).toHaveLength(1);
    // Spectating host has no player to credit.
    host.toggleSpectate();
    expect(host.giveMoney(500)).toMatch(/spectating/);
    expect(posted.filter((m) => m.type === 'debug')).toHaveLength(1);
    info.mockRestore();
  });

  test('a flood of malformed messages logs only a few warnings', async () => {
    const { link } = await hostWithFriend();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 500; i++) link.send({ t: 'garbage', i });
    await flush(); await flush();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(2);
    warn.mockRestore();
  });

  test('the host picks the map; joiners see it in the lobby message', async () => {
    const { host, got } = await hostWithFriend();
    host.setMap('yard');
    await flush(); await flush();
    expect(got.filter((m) => m.t === 'lobby').at(-1)).toMatchObject({ map: 'yard' });
    expect(host.nextMap()).toBe('yard');
  });

  test('Random never plays the same map twice in a row across matches (rematches) of one host session', async () => {
    const { host } = await hostWithFriend();
    host.setMap('harbor');
    expect(host.nextMap()).toBe('harbor');
    host.setMap('random');
    let last = host.lastPlayedMap;
    for (let i = 0; i < 30; i++) {
      const m = host.nextMap();
      expect(m).not.toBe(last);
      last = m;
    }
  });
});

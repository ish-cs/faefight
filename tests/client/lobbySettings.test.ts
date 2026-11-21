import { beforeAll, describe, expect, test } from 'vitest';
import type { HostSession as HostSessionT } from '../../src/client/session';
import { LoopbackTransport } from '../../src/net/loopback';
import { NET_VERSION } from '../../src/net/protocol';
import { DEFAULT_SETTINGS } from '../../src/sim/settings';
import { formatSetting } from '../../src/client/gameSettingsUi';
import { clearMutes, isMuted, toggleMute } from '../../src/client/chatMute';

let HostSession: typeof HostSessionT;
let startLabel: (n: number) => string;
let takenColors: typeof import('../../src/client/lobbyUi').takenColors;
beforeAll(async () => {
  (globalThis as any).addEventListener ??= () => {};
  ({ HostSession } = await import('../../src/client/session'));
  ({ startLabel, takenColors } = await import('../../src/client/lobbyUi'));
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function hostWithFriends(n = 1) {
  const t = new LoopbackTransport();
  const hostLobbies: any[] = [];
  const host = await HostSession.create(t, 'Alice', { lobby: (slots, map, settings) => hostLobbies.push({ slots, map, settings }), chat: () => {} });
  const friends = [];
  for (let i = 0; i < n; i++) {
    const link = await t.join(host.code);
    const got: any[] = [];
    link.onMessage((m) => got.push(m));
    link.send({ t: 'hello', name: `F${i}`, version: NET_VERSION });
    await flush(); await flush();
    friends.push({ link, got, last: () => got.filter((m) => m.t === 'lobby').at(-1) });
  }
  return { host, friends, hostLobbies };
}

describe('lobby over the network', () => {
  test('NET_VERSION bumped for the new messages', () => {
    expect(NET_VERSION).toBeGreaterThanOrEqual(8);
  });

  test('ready state syncs to the host and every guest; resets back in the lobby', async () => {
    const { host, friends, hostLobbies } = await hostWithFriends(2);
    expect(host.lobby.notReady()).toBe(2);
    friends[0].link.send({ t: 'ready', ready: true });
    await flush(); await flush();
    expect(host.lobby.notReady()).toBe(1);
    expect(hostLobbies.at(-1).slots[1].ready).toBe(true);
    expect(friends[1].last().slots[1].ready).toBe(true);
    friends[0].link.send({ t: 'ready', ready: false });
    await flush(); await flush();
    expect(friends[1].last().slots[1].ready).toBeUndefined();
    friends[0].link.send({ t: 'ready', ready: true });
    await flush(); await flush();
    host.start({ postMessage: () => {} });
    host.backToLobby();
    expect(host.lobby.notReady()).toBe(2);
  });

  test('colours: a guest picks one, a second guest cannot take it, the host sees both', async () => {
    const { host, friends } = await hostWithFriends(2);
    friends[0].link.send({ t: 'color', color: 3 });
    await flush(); await flush();
    friends[1].link.send({ t: 'color', color: 3 });
    await flush(); await flush();
    expect(host.lobby.slots()[1]).toMatchObject({ color: 3 });
    expect(host.lobby.slots()[2]).not.toHaveProperty('color');
    host.setColor(0, 3); // taken: refused
    expect(host.lobby.slots()[0]).not.toHaveProperty('color');
    host.setColor(0, 6);
    await flush();
    expect(friends[1].last().slots.map((s: any) => s.color)).toEqual([6, 3, undefined]);
    const { setup } = host.start({ postMessage: () => {} });
    expect(setup.players.map((p) => p.color)).toEqual([6, 3, undefined]);
  });

  test('ready / colour are lobby-only (ignored mid-match)', async () => {
    const { host, friends } = await hostWithFriends(1);
    host.start({ postMessage: () => {} });
    friends[0].link.send({ t: 'color', color: 5 });
    friends[0].link.send({ t: 'ready', ready: true });
    await flush(); await flush();
    expect(host.lobby.slots()[1]).not.toHaveProperty('color');
    expect(host.lobby.slots()[1]).not.toHaveProperty('ready');
  });

  test('game settings: guests receive them; the host clamps; the match setup carries them', async () => {
    const { host, friends } = await hostWithFriends(1);
    expect(friends[0].last().settings).toEqual(DEFAULT_SETTINGS);
    host.setSettings({ startCash: 250 });
    await flush();
    expect(friends[0].last().settings).toEqual({ ...DEFAULT_SETTINGS, startCash: 250 });
    host.setSettings({ genMult: 7, suddenDeathSec: 60 } as any);
    expect(host.settings).toEqual({ startCash: 250, suddenDeathSec: 480, genMult: 2 });
    const { setup } = host.start({ postMessage: () => {} });
    expect(setup.settings).toEqual({ startCash: 250, suddenDeathSec: 480, genMult: 2 });
    host.setSettings({ startCash: 0 }); // locked while the match runs
    expect(host.settings.startCash).toBe(250);
  });

  test('guests cannot change settings (no such client message)', async () => {
    const { host, friends } = await hostWithFriends(1);
    friends[0].link.send({ t: 'settings', settings: { startCash: 999 } });
    await flush(); await flush();
    expect(host.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('lobby UI helpers', () => {
  test('start button label', () => {
    expect(startLabel(0)).toBe('Start match');
    expect(startLabel(2)).toBe('Start anyway (2 not ready)');
  });
  test('taken colours exclude your own pick', () => {
    const slots: any[] = [{ kind: 'human', isHost: true, color: 1 }, { kind: 'human', color: 4 }, { kind: 'bot', difficulty: 'easy' }];
    expect([...takenColors(slots, 0)]).toEqual([4]);
    expect([...takenColors(slots, 1)]).toEqual([1]);
  });
  test('setting text', () => {
    expect(formatSetting('startCash', 50)).toBe('$50');
    expect(formatSetting('suddenDeathSec', 900)).toBe('15 min');
    expect(formatSetting('genMult', 1.25)).toBe('1.25×');
  });
  test('local mute', () => {
    clearMutes();
    expect(isMuted('Bob')).toBe(false);
    expect(toggleMute('Bob')).toBe(true);
    expect(isMuted('bob')).toBe(true);
    expect(isMuted('')).toBe(false);
    expect(toggleMute('Bob')).toBe(false);
  });
});

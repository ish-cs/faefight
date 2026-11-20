import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { HostSession as HostSessionT } from '../../src/client/session';
import { LoopbackTransport } from '../../src/net/loopback';
import { NET_VERSION } from '../../src/net/protocol';

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
    (host as any).worker = { postMessage: (m: any) => posted.push(m) };
    const req = { kind: 'wood', pos: { x: 0, y: 2, z: 0 }, rotY: 0, free: false };
    for (let i = 0; i < 200; i++) link.send({ t: 'preview', req, key: i });
    await flush(); await flush();
    const previews = posted.filter((m) => m.type === 'preview').length;
    expect(previews).toBeGreaterThan(0);
    expect(previews).toBeLessThanOrEqual(30);
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

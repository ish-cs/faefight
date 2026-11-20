import { afterEach, describe, expect, test } from 'vitest';
import { LoopbackTransport } from '../../src/net/loopback';
import type { HostRoom, Link } from '../../src/net/transport';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let rooms: HostRoom[] = [];
afterEach(() => {
  for (const r of rooms) r.close();
  rooms = [];
});

async function hostWithJoins(t: LoopbackTransport) {
  const room = await t.host();
  rooms.push(room);
  const hostLinks: Link[] = [];
  room.onJoin((l) => hostLinks.push(l));
  return { room, hostLinks };
}

describe('LoopbackTransport', () => {
  test('host gets a 6-char invite code', async () => {
    const { room } = await hostWithJoins(new LoopbackTransport());
    expect(room.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  test('host + 2 clients round-trip both ways, delivered asynchronously', async () => {
    const t = new LoopbackTransport();
    const { room, hostLinks } = await hostWithJoins(t);
    const a = await t.join(room.code);
    const b = await t.join(room.code);
    await flush();
    expect(hostLinks).toHaveLength(2);
    expect(hostLinks[0].peerId).not.toBe(hostLinks[1].peerId);

    const atHost: Array<[string, unknown]> = [];
    for (const l of hostLinks) l.onMessage((m) => atHost.push([l.peerId, m]));
    const atA: unknown[] = [];
    const atB: unknown[] = [];
    a.onMessage((m) => atA.push(m));
    b.onMessage((m) => atB.push(m));

    a.send({ t: 'chat', text: 'from a' });
    b.send({ t: 'chat', text: 'from b' });
    expect(atHost).toHaveLength(0); // async, like a real network
    await flush();
    expect(atHost).toEqual([
      [hostLinks[0].peerId, { t: 'chat', text: 'from a' }],
      [hostLinks[1].peerId, { t: 'chat', text: 'from b' }],
    ]);

    hostLinks[0].send({ n: 1 });
    hostLinks[0].send({ n: 2 });
    hostLinks[1].send({ n: 3 });
    await flush();
    expect(atA).toEqual([{ n: 1 }, { n: 2 }]); // ordered
    expect(atB).toEqual([{ n: 3 }]);
  });

  test('messages are copied, not shared by reference', async () => {
    const t = new LoopbackTransport();
    const { room, hostLinks } = await hostWithJoins(t);
    const a = await t.join(room.code);
    await flush();
    const got: Array<{ v: number }> = [];
    hostLinks[0].onMessage((m) => got.push(m as { v: number }));
    const msg = { v: 1 };
    a.send(msg);
    msg.v = 2;
    await flush();
    expect(got).toEqual([{ v: 1 }]);
  });

  test('messages sent before onMessage is registered are buffered, not lost', async () => {
    const t = new LoopbackTransport();
    const { room, hostLinks } = await hostWithJoins(t);
    const a = await t.join(room.code);
    a.send({ t: 'hello' });
    await flush();
    await flush();
    const got: unknown[] = [];
    hostLinks[0].onMessage((m) => got.push(m));
    await flush();
    expect(got).toEqual([{ t: 'hello' }]);
  });

  test('client close fires onClose at the host, not at the closer; later sends are dropped', async () => {
    const t = new LoopbackTransport();
    const { room, hostLinks } = await hostWithJoins(t);
    const a = await t.join(room.code);
    await flush();
    let hostSaw = 0;
    let clientSaw = 0;
    const got: unknown[] = [];
    hostLinks[0].onClose(() => hostSaw++);
    hostLinks[0].onMessage((m) => got.push(m));
    a.onClose(() => clientSaw++);
    a.close();
    a.close(); // idempotent
    a.send({ late: true });
    await flush();
    expect(hostSaw).toBe(1);
    expect(clientSaw).toBe(0);
    expect(got).toEqual([]);
  });

  test('host link close fires onClose at the client', async () => {
    const t = new LoopbackTransport();
    const { room, hostLinks } = await hostWithJoins(t);
    const a = await t.join(room.code);
    const b = await t.join(room.code);
    await flush();
    let aSaw = 0;
    let bSaw = 0;
    a.onClose(() => aSaw++);
    b.onClose(() => bSaw++);
    hostLinks[0].close(); // kick a
    await flush();
    expect(aSaw).toBe(1);
    expect(bSaw).toBe(0);
  });

  test('room close closes every link and unregisters the code', async () => {
    const t = new LoopbackTransport();
    const { room } = await hostWithJoins(t);
    const a = await t.join(room.code);
    const b = await t.join(room.code);
    let closed = 0;
    a.onClose(() => closed++);
    b.onClose(() => closed++);
    room.close();
    await flush();
    expect(closed).toBe(2);
    await expect(t.join(room.code)).rejects.toThrow('Room not found');
  });

  test('onClose registered after the link already closed still fires', async () => {
    const t = new LoopbackTransport();
    const { room, hostLinks } = await hostWithJoins(t);
    const a = await t.join(room.code);
    await flush();
    hostLinks[0].close();
    await flush();
    let saw = 0;
    a.onClose(() => saw++);
    await flush();
    expect(saw).toBe(1);
  });

  test('joining an unknown code rejects', async () => {
    await expect(new LoopbackTransport().join('ZZZZZZ')).rejects.toThrow('Room not found');
  });

  test('a separate transport instance can join (shared registry)', async () => {
    const { room, hostLinks } = await hostWithJoins(new LoopbackTransport());
    const a = await new LoopbackTransport().join(room.code.toLowerCase());
    await flush();
    expect(hostLinks).toHaveLength(1);
    a.close();
  });
});

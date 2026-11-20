import { afterEach, describe, expect, test } from 'vitest';
import { BroadcastTransport } from '../../src/net/broadcast';
import type { HostRoom, Link } from '../../src/net/transport';

// Node ships BroadcastChannel; separate instances in one process talk to each other like tabs.
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(10);
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

async function setup() {
  const t = new BroadcastTransport();
  const room: HostRoom = await t.host();
  cleanup.push(() => room.close());
  const hostLinks: Link[] = [];
  room.onJoin((l) => hostLinks.push(l));
  const join = async () => {
    const l = await t.join(room.code.toLowerCase());
    cleanup.push(() => l.close());
    return l;
  };
  return { room, hostLinks, join };
}

describe('BroadcastTransport', () => {
  test('host + 2 clients round-trip, addressed per peer', async () => {
    const { hostLinks, join } = await setup();
    const a = await join();
    const b = await join();
    await until(() => hostLinks.length === 2);
    const atHost: Array<[string, unknown]> = [];
    for (const l of hostLinks) l.onMessage((m) => atHost.push([l.peerId, m]));
    const atA: unknown[] = [];
    const atB: unknown[] = [];
    a.onMessage((m) => atA.push(m));
    b.onMessage((m) => atB.push(m));

    a.send({ t: 'chat', text: 'hi from a' });
    b.send({ t: 'chat', text: 'hi from b' });
    hostLinks[0].send({ n: 1 });
    hostLinks[0].send({ n: 2 });
    hostLinks[1].send({ n: 3 });
    await until(() => atHost.length === 2 && atA.length === 2 && atB.length === 1);
    await wait(50);
    expect(atA).toEqual([{ n: 1 }, { n: 2 }]);
    expect(atB).toEqual([{ n: 3 }]);
    expect(new Map(atHost)).toEqual(
      new Map([
        [hostLinks[0].peerId, { t: 'chat', text: 'hi from a' }],
        [hostLinks[1].peerId, { t: 'chat', text: 'hi from b' }],
      ]),
    );
  });

  test('client close → host onClose; host link close (kick) → that client only', async () => {
    const { hostLinks, join } = await setup();
    const a = await join();
    const b = await join();
    await until(() => hostLinks.length === 2);
    let hostSawA = 0;
    let bClosed = 0;
    hostLinks[0].onClose(() => hostSawA++);
    b.onClose(() => bClosed++);
    let aClosed = 0;
    a.onClose(() => aClosed++);
    a.close();
    await until(() => hostSawA === 1);
    expect(aClosed).toBe(0);
    hostLinks[1].close();
    await until(() => bClosed === 1);
  });

  test('room close → every client onClose', async () => {
    const { room, hostLinks, join } = await setup();
    const a = await join();
    const b = await join();
    await until(() => hostLinks.length === 2);
    let closed = 0;
    a.onClose(() => closed++);
    b.onClose(() => closed++);
    room.close();
    await until(() => closed === 2);
  });

  test('unknown or malformed code rejects', async () => {
    const t = new BroadcastTransport();
    await expect(t.join('nope')).rejects.toThrow('Room not found');
    await expect(t.join('ZZZZZZ')).rejects.toThrow('Room not found');
  }, 10_000);

  test('a host that goes silent (killed tab) is detected by heartbeat timeout', async () => {
    // Fake host: accepts the join, then never speaks again.
    const ch = new BroadcastChannel('faefight-local-QQQQQQ');
    cleanup.push(() => ch.close());
    ch.onmessage = (e) => {
      if (e.data?.k === 'join') ch.postMessage({ k: 'accept', to: e.data.from });
    };
    const link = await new BroadcastTransport().join('QQQQQQ');
    cleanup.push(() => link.close());
    let closed = false;
    link.onClose(() => (closed = true));
    await wait(2000);
    expect(closed).toBe(false);
    await until(() => closed, 4000);
  }, 10_000);
});

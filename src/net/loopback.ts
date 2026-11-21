import { newInviteCode, normalizeCode } from './code';
import { LinkBase } from './linkBase';
import type { HostRoom, Link, Transport } from './transport';

/** In-memory transport for unit tests. Delivery is async (microtask) and messages are structured-cloned. */
class LoopbackLink extends LinkBase {
  other: LoopbackLink | null = null;

  protected transmit(msg: unknown): void {
    const copy = structuredClone(msg);
    const to = this.other;
    queueMicrotask(() => to?.deliver(copy));
  }

  protected teardown(): void {
    const to = this.other;
    queueMicrotask(() => to?.ended());
  }
}

class LoopbackRoom implements HostRoom {
  private joinCbs: Array<(link: Link) => void> = [];
  private waiting: Link[] = [];
  private links = new Set<LoopbackLink>();
  closed = false;

  constructor(readonly code: string) {}

  onJoin(cb: (link: Link) => void): void {
    this.joinCbs.push(cb);
    const queued = this.waiting;
    this.waiting = [];
    for (const l of queued) cb(l);
  }

  /** Called by join(): returns the client end. */
  connect(clientId: number): Link {
    const hostEnd = new LoopbackLink(`loop-${clientId}`);
    const clientEnd = new LoopbackLink('host');
    hostEnd.other = clientEnd;
    clientEnd.other = hostEnd;
    this.links.add(hostEnd);
    queueMicrotask(() => {
      if (this.joinCbs.length === 0) this.waiting.push(hostEnd);
      for (const cb of this.joinCbs) cb(hostEnd);
    });
    return clientEnd;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    LoopbackTransport.rooms.delete(this.code);
    for (const l of this.links) l.close();
    this.links.clear();
  }
}

export class LoopbackTransport implements Transport {
  /** Shared across instances so a "host" and a "client" transport can meet. */
  static rooms = new Map<string, LoopbackRoom>();
  private static nextClient = 1;

  async host(want?: string): Promise<HostRoom> {
    if (want !== undefined && (normalizeCode(want) !== want || LoopbackTransport.rooms.get(want)?.closed === false)) throw new Error(`Room ${want} is taken`);
    let code = want ?? newInviteCode();
    while (LoopbackTransport.rooms.has(code)) code = newInviteCode();
    const room = new LoopbackRoom(code);
    LoopbackTransport.rooms.set(code, room);
    return room;
  }

  async join(code: string): Promise<Link> {
    const room = LoopbackTransport.rooms.get(normalizeCode(code) ?? code);
    if (!room || room.closed) throw new Error('Room not found');
    return room.connect(LoopbackTransport.nextClient++);
  }
}

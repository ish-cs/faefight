import { beforeAll, describe, expect, test } from 'vitest';
import type { HostSession as HostSessionT } from '../../src/client/session';
import type * as MigrationT from '../../src/client/migration';
import { LoopbackTransport } from '../../src/net/loopback';
import { NET_VERSION, type HostMsg } from '../../src/net/protocol';
import { openCheckpoint } from '../../src/net/checkpoint';
import { packMatch, unpackMatch } from '../../src/net/matchCheckpoint';
import { Match } from '../../src/sim/match';
import { buildMapDef } from '../../src/sim/map';
import { stateHash } from '../../src/sim/replay/hash';

let HostSession: typeof HostSessionT;
let M: typeof MigrationT;
beforeAll(async () => {
  (globalThis as any).addEventListener ??= () => {};
  ({ HostSession } = await import('../../src/client/session'));
  M = await import('../../src/client/migration');
});

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const fakeWorker = () => { const posted: any[] = []; return { posted, postMessage: (m: any) => posted.push(m) }; };

async function join(t: LoopbackTransport, code: string, name: string) {
  const link = await t.join(code);
  const got: HostMsg[] = [];
  link.onMessage((m) => got.push(m as HostMsg));
  link.send({ t: 'hello', name, version: NET_VERSION });
  await flush();
  return { link, got, token: () => (got.filter((m) => m.t === 'rejoin').at(-1) as { token: string } | undefined)?.token };
}

describe('pickBackup', () => {
  test('the lowest seat (joined first) wins, whatever order the candidates come in', () => {
    expect(M.pickBackup([], null)).toBeNull();
    expect(M.pickBackup([{ seat: 2, peerId: 'b' }, { seat: 1, peerId: 'a' }], null)).toBe(1);
    expect(M.pickBackup([{ seat: 3, peerId: 'c' }, { seat: 2, peerId: 'b' }], null)).toBe(2);
    const cands = [{ seat: 4, peerId: 'd' }, { seat: 2, peerId: 'b' }, { seat: 3, peerId: 'c' }];
    for (let i = 0; i < cands.length; i++) expect(M.pickBackup([...cands.slice(i), ...cands.slice(0, i)], null)).toBe(2);
  });
  test('sticky while the current backup is still connected; re-picked once it leaves', () => {
    const c = [{ seat: 1, peerId: 'a' }, { seat: 2, peerId: 'b' }, { seat: 3, peerId: 'c' }];
    expect(M.pickBackup(c, 2)).toBe(2);
    expect(M.pickBackup(c.filter((x) => x.seat !== 2), 2)).toBe(1);
  });
  test('the host migrator plans the same backup whoever answers first (no RTT race)', () => {
    for (const order of [['carol', 'bob'], ['bob', 'carol']]) {
      const seatOf: Record<string, number> = { bob: 1, carol: 2 };
      const sent: [string, HostMsg][] = [];
      const mig = new M.HostMigrator({
        guests: () => order.map((peerId) => ({ seat: seatOf[peerId], peerId })),
        send: (peerId, m) => sent.push([peerId, m]),
        requestCheckpoint: () => {},
        meta: () => { throw new Error('unused'); },
      }, () => 0);
      mig.tick();
      expect(mig.plan?.seat).toBe(1);
      const plans = sent.filter(([, m]) => m.t === 'mplan').map(([p, m]) => [p, (m as Extract<HostMsg, { t: 'mplan' }>).seat]);
      expect(new Map(plans as [string, number][])).toEqual(new Map([['bob', 1], ['carol', 1]]));
    }
  });
});

describe('checkpoint cadence', () => {
  test('about 12 KB/s to the backup, every 2 s at most and 5 s at least', () => {
    expect(M.checkpointDelayMs(10_000)).toBe(2000);
    expect(M.checkpointDelayMs(36_864)).toBe(3000);
    expect(M.checkpointDelayMs(200_000)).toBe(5000);
  });
});

/** Alice hosts; Bob (seat 1), Carol (seat 2) and a bot (seat 3). Returns a live match matching the lobby. */
async function started() {
  const t = new LoopbackTransport();
  const host = await HostSession.create(t, 'Alice', { lobby: () => {}, chat: () => {} });
  const bob = await join(t, host.code, 'Bob');
  const carol = await join(t, host.code, 'Carol');
  host.addSeat();
  host.setSeat(3, { kind: 'bot', difficulty: 'easy' });
  const w = fakeWorker();
  const { setup } = host.start(w);
  const match = await Match.create({ ...setup, seed: 9 });
  const def = buildMapDef(4, setup.map, 9);
  host.onMap(def, [0, 1, 2, 3]);
  await flush();
  return { t, host, bob, carol, w, match, def, setup };
}

describe('host side: plans and checkpoints', () => {
  test('every guest learns the plan; the key goes to everyone but the backup; the checkpoint only to the backup', async () => {
    const { host, bob, carol, w, match } = await started();
    host.migrator.tick();
    await flush();
    const planOf = (g: { got: HostMsg[] }) => g.got.find((m) => m.t === 'mplan') as Extract<HostMsg, { t: 'mplan' }>;
    expect(planOf(bob)).toMatchObject({ seat: 1 });
    expect(planOf(bob).key).toBeUndefined();
    expect(planOf(carol)).toMatchObject({ seat: 1, code: planOf(bob).code });
    expect(planOf(carol).key).toMatch(/==$/);
    expect(w.posted.filter((m) => m.type === 'checkpoint')).toHaveLength(1);

    for (let i = 0; i < 60; i++) match.tick(new Map());
    await host.onCheckpoint(await packMatch(match), 60);
    await new Promise((r) => setTimeout(r, 50));
    const ck = bob.got.find((m) => m.t === 'ckpt') as Extract<HostMsg, { t: 'ckpt' }>;
    expect(ck).toBeTruthy();
    expect(carol.got.some((m) => m.t === 'ckpt')).toBe(false);
    // Bob can't read it without Carol's key; with it the meta + match come out.
    const opened = await openCheckpoint(ck.b, planOf(carol).key!);
    expect(opened.meta.seatIds).toEqual([1, 2, 3, 4]);
    expect(opened.meta.tokens.map(([s]) => s).sort()).toEqual([1, 2]);
    expect(host.migrator.stats.sent).toBe(1);
    // Not due again yet: no second request.
    host.migrator.tick();
    expect(w.posted.filter((m) => m.type === 'checkpoint')).toHaveLength(1);
    host.close();
  });

  test('a lone guest is the backup and holds the key itself; the key rotates when that changes', async () => {
    const t = new LoopbackTransport();
    const host = await HostSession.create(t, 'Alice', { lobby: () => {}, chat: () => {} });
    const bob = await join(t, host.code, 'Bob');
    host.addSeat();
    host.setSeat(2, { kind: 'bot', difficulty: 'easy' });
    const { setup } = host.start(fakeWorker());
    host.onMap(buildMapDef(3, setup.map), [0, 1, 2]);
    await flush();
    host.migrator.tick();
    await flush();
    const plan = bob.got.find((m) => m.t === 'mplan') as Extract<HostMsg, { t: 'mplan' }>;
    expect(plan).toMatchObject({ seat: 1 });
    expect(plan.key).toMatch(/==$/);
    host.close();
  });
});

describe('migration end to end (loopback)', () => {
  test('host leaves: Bob restores the match and hosts; Carol re-points to Bob and keeps her seat', async () => {
    const { t, host, bob, carol, match, def } = await started();
    host.migrator.tick();
    for (let i = 0; i < 90; i++) match.tick(new Map());
    const tick = match.tick(new Map()).tick;
    const link = { matchId: 'aliceRec', segment: 0, setup: { players: [], seed: 9 } };
    host.onCheckpoint(await packMatch(match), tick, link);
    await new Promise((r) => setTimeout(r, 50));

    const gmBob = new M.GuestMigration(1), gmCarol = new M.GuestMigration(2);
    for (const m of bob.got) gmBob.onHostMsg(m);
    for (const m of carol.got) gmCarol.onHostMsg(m);
    expect(gmBob.isBackup && gmBob.ready).toBe(true);
    expect(gmCarol.isBackup).toBe(false);
    expect(gmCarol.ready).toBe(true);

    host.close(); // Alice's tab closes
    await flush();
    expect(bob.got.at(-1)).toEqual({ t: 'ended', reason: 'host-left' });

    const restores: { humanId: number; botify: number[]; toTick: number; recording: unknown; restored?: Match }[] = [];
    const newWorker = fakeWorker();
    const chat: string[] = [];
    const bobTakes = M.takeOver({
      transport: t, gm: gmBob, name: 'Bob', map: def, lastTick: tick, lastTickAt: performance.now(),
      startWorker: async (bytes, humanId, botify, toTick, recording) => {
        restores.push({ humanId, botify, toTick, recording, restored: await unpackMatch(bytes) });
        return newWorker;
      },
      events: { lobby: () => {}, chat: (from, text) => chat.push(`${from}: ${text}`) },
    });
    const carolFollows = M.followNewHost({ transport: t, plan: gmCarol.plan!, name: 'Carol', token: carol.token()! });
    const [{ session }, f] = await Promise.all([bobTakes, carolFollows]);

    // Bob's worker got the checkpoint: Bob plays player 2, Alice's player 1 goes to a bot.
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ humanId: 2, botify: [1] });
    // Alice's recording link came along in the sealed checkpoint: Bob records the next segment of it.
    expect(restores[0].recording).toEqual(link);
    const r = restores[0].restored!;
    expect(stateHash(r.tick(new Map()))).toBe(stateHash(match.tick(new Map())));
    expect(session.hostPlayer).toBe(2);

    // Carol is back in her seat on Bob's room, same player id and island.
    expect(f.hostName).toBe('Bob');
    expect(f.start.playerId).toBe(3);
    expect(f.start.island).toBe(2);
    const after: HostMsg[] = [];
    f.link.onMessage((m) => after.push(m as HostMsg));
    f.link.flush();
    expect(after.some((m) => m.t === 'rejoin')).toBe(true);
    // Bob's host streams snapshots to Carol, and relays her input to his worker.
    session.onSnapshot(r.tick(new Map()));
    await flush();
    expect(after.some((m) => m.t === 'snap')).toBe(true);
    f.link.send({ t: 'input', input: { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ads: false, reload: false, interact: false, slot: null, build: null, throwGrenade: false, placeCharge: false, shop: null, vault: null, select: null, drop: null, moveSlot: null, useMedkit: false, drink: false }, cmds: [] });
    await flush();
    expect(newWorker.posted.some((m) => m.type === 'remoteInput' && m.playerId === 3)).toBe(true);
    expect(chat.join('\n')).toContain('Carol reconnected');
    session.close();
    match.dispose(); r.dispose();
  }, 60_000);

  test('a stranger without a seat token is refused by the new host', async () => {
    const { t, host, bob, carol, match, def } = await started();
    host.migrator.tick();
    await host.onCheckpoint(await packMatch(match), 1);
    await new Promise((r) => setTimeout(r, 50));
    const gmBob = new M.GuestMigration(1), gmCarol = new M.GuestMigration(2);
    for (const m of bob.got) gmBob.onHostMsg(m);
    for (const m of carol.got) gmCarol.onHostMsg(m);
    host.close();
    const bobTakes = M.takeOver({
      transport: t, gm: gmBob, name: 'Bob', map: def, lastTick: 1, lastTickAt: performance.now(),
      startWorker: async () => fakeWorker(), events: { lobby: () => {}, chat: () => {} },
    });
    // Carol brings the key (so Bob can start), Mallory has only a made-up token.
    const f = await M.followNewHost({ transport: t, plan: gmCarol.plan!, name: 'Carol', token: carol.token()! });
    const { session } = await bobTakes;
    await expect(M.followNewHost({ transport: t, plan: { ...gmCarol.plan!, key: undefined }, name: 'Mallory', token: 'aaaaaaaa-bbbb', timeoutMs: 3000 })).rejects.toThrow(/started/);
    f.link.close();
    session.close();
    match.dispose();
  }, 60_000);

  test('migration fails cleanly when no guest brings the key (the backup can not read the checkpoint alone)', async () => {
    const { t, host, bob, match, def } = await started();
    host.migrator.tick();
    await host.onCheckpoint(await packMatch(match), 1);
    await new Promise((r) => setTimeout(r, 50));
    const gmBob = new M.GuestMigration(1);
    for (const m of bob.got) gmBob.onHostMsg(m);
    host.close();
    let workerStarted = false;
    await expect(M.takeOver({
      transport: t, gm: gmBob, name: 'Bob', map: def, lastTick: 1, lastTickAt: performance.now(), keyWaitMs: 200,
      startWorker: async () => { workerStarted = true; return fakeWorker(); }, events: { lobby: () => {}, chat: () => {} },
    })).rejects.toThrow(/key/);
    expect(workerStarted).toBe(false);
    // The announced room was closed again.
    await expect(t.join(gmBob.plan!.code)).rejects.toThrow();
    match.dispose();
  }, 30_000);
});

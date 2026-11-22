import { describe, expect, test } from 'vitest';
import { InterestManager, INTEREST } from '../../src/net/interest';
import { SnapshotDecoder, SnapshotEncoder } from '../../src/net/snapshotCodec';
import { WireDecoder, WireEncoder } from '../../src/net/wire';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PropPose } from '../../src/sim/props';
import type { PieceState, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

const steel = (id: number): PieceState => ({ id, kind: 'steel', owner: 1, pos: v3(1, 2, 3), rotY: 0.5, hp: 1200 });
function busy(tick: number): Snapshot {
  const players = Array.from({ length: 8 }, (_, i) => newPlayer(i + 1, 'p' + i, true, i, v3(i * 10.123456, 2, 3.333333)));
  return {
    time: tick / 30, tick, players, pieces: Array.from({ length: 60 }, (_, i) => steel(i)), loot: [],
    projectiles: Array.from({ length: 8 }, (_, i) => ({ id: 500 + i, kind: i % 2 ? 'rocket' as const : 'grenade' as const, pos: v3(i * 3.33333, 9.87654, 1.11111), vel: v3(30.123, -1.5, 4.444) })),
    generators: [], genLevels: [], sealed: [], waterY: 0, suddenDeath: false, winner: null, events: [],
  };
}
/** 40 displaced props (an 8-player map's worth) scattered within 60 m. */
const props = (): PropPose[] => Array.from({ length: 40 }, (_, i) => ({ id: i + 1, p: [i * 1.5123, 2.4567, -i * 0.987], q: [0.01234, 0.70711, -0.00123, 0.70701] }));

describe('gameplay props on the wire', () => {
  test('round-trip: displaced props decode quantized (cm / 0.001)', () => {
    const enc = new SnapshotEncoder(), dec = new SnapshotDecoder();
    const s = busy(1);
    s.props = props();
    enc.push(s);
    const out = dec.decode(enc.take(1));
    expect(out.props).toHaveLength(40);
    expect(out.props![3].p[0]).toBeCloseTo(4.5369, 2);
    expect(out.props![3].q[1]).toBeCloseTo(0.70711, 3);
  });

  test('8 players + 40 displaced props, 8 of them tumbling: the binary delta stays under 20 KB/s at 30 Hz', () => {
    const enc = new SnapshotEncoder(), wire = new WireEncoder(), dec = new WireDecoder();
    const s = busy(1);
    s.props = props();
    enc.push(s);
    const full = wire.encode(1, enc.take(1, true));
    expect(full.byteLength).toBeLessThan(6 * 1024);
    dec.decode(full);
    wire.ack(dec.ack);
    for (const p of s.players) { p.pos = v3(p.pos.x + 0.17, p.pos.y, p.pos.z - 0.11); p.vel = v3(5.1, 0, -3.3); p.yaw += 0.05; }
    for (const pr of s.projectiles!) pr.pos = v3(pr.pos.x + 1, pr.pos.y - 0.05, pr.pos.z + 0.15);
    s.props = props().map((x, i) => (i % 5 ? x : { ...x, p: [x.p[0] + 0.21, x.p[1] - 0.13, x.p[2] + 0.07], q: [0.2, 0.69, 0.1, 0.687] }));
    enc.push({ ...s, tick: 2, time: 2 / 30 });
    const delta = wire.encode(2, enc.take(1, true));
    expect(delta.byteLength).toBeLessThan((20 * 1024) / 30);
  });

  test('resting displaced props cost nothing in a delta', () => {
    const enc = new SnapshotEncoder(), wire = new WireEncoder(), dec = new WireDecoder();
    const s = busy(1);
    enc.push(s);
    dec.decode(wire.encode(1, enc.take(1, true)));
    wire.ack(dec.ack);
    enc.push({ ...s, tick: 2 });
    const without = wire.encode(2, enc.take(1, true)).byteLength;
    const w2 = new WireEncoder(), d2 = new WireDecoder(), e2 = new SnapshotEncoder();
    const t = busy(1);
    t.props = props();
    e2.push(t);
    d2.decode(w2.encode(1, e2.take(1, true)));
    w2.ack(d2.ack);
    e2.push({ ...t, tick: 2 });
    expect(w2.encode(2, e2.take(1, true)).byteLength).toBe(without);
  });

  test('interest: far props keep the pose the viewer last got; near ones update', () => {
    const map = buildMap(2);
    const im = new InterestManager(map);
    const enc = new SnapshotEncoder();
    const s = busy(1);
    s.players = [newPlayer(1, 'a', false, 0, v3(0, 2, 0)), newPlayer(2, 'b', false, 1, v3(5, 2, 0))];
    const far = INTEREST.propRange + 20;
    const pose = (id: number, x: number): PropPose => ({ id, p: [x, 2.5, 0], q: [0, 0, 0, 1] });
    s.props = [pose(1, 3), pose(2, 10), pose(3, far)];
    enc.push(s); im.update(s);
    // never-seen far props are left out (the client keeps them at their spawn)
    expect(im.apply(1, enc.take(1)).pr?.map((x) => x.id)).toEqual([1, 2]);
    // all move; prop 2 is now out of range: its update is withheld
    const s2 = { ...s, tick: 2, props: [pose(1, 3.5), pose(2, far + 1), pose(3, far + 2)] };
    enc.push(s2); im.update(s2);
    const b = im.apply(1, enc.take(1));
    expect(b.pr!.map((x) => [x.id, x.p[0]])).toEqual([[1, 3.5], [2, 10]]);
    // back at spawn: unlisted for everyone
    const s3 = { ...s2, tick: 3, props: [] };
    enc.push(s3); im.update(s3);
    expect(im.apply(1, enc.take(1)).pr).toBeUndefined();
  });
});

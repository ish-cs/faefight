import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { BUILD, DT, PIECES } from '../../src/sim/constants';
import { NO_INPUT, type BuildRequest, type PieceKind, type PlayerInput, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, dist2D, forward, right, scale, v3 } from '../../src/sim/vec';

const humans1v1 = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
const inputs = (i: Partial<PlayerInput>) => new Map([[1, { ...NO_INPUT, ...i }]]);
const me = (s: Snapshot) => s.players.find((p) => p.id === 1)!;
const placedTimes = (s: Snapshot) => s.events.filter((e) => e.type === 'placed' && e.data.by === 1).map((e) => e.t);

/** Player 1 standing in the open on their island, facing out, with `n` pieces of `kind`. */
async function setup(kind: PieceKind, n: number) {
  const m = await Match.create(humans1v1);
  const isl = m.map[0];
  const yaw = isl.bunker.facingYaw;
  const stand = add(isl.center, scale(forward(yaw), 10)); // open ground in front of the bunker (clear of vault/shop)
  m.debugTeleport(1, v3(stand.x, isl.groundY, stand.z));
  m.debugGive(1, { pieces: { [kind]: n } });
  m.tick(new Map());
  return { m, isl, yaw, stand: v3(stand.x, isl.groundY, stand.z) };
}

/** A row of free spots 3 m ahead of `from`, side by side (2.2 m apart), then a second layer on top. */
function row(from: Vec3, yaw: number, groundY: number): Vec3[] {
  const ahead = add(from, scale(forward(yaw), 3));
  const out: Vec3[] = [];
  for (const layer of [0, 1.2]) for (const side of [-3.3, -1.1, 1.1, 3.3]) {
    const p = add(ahead, scale(right(yaw), side));
    out.push(v3(p.x, groundY + layer, p.z));
  }
  return out;
}

describe('fast building', () => {
  test('holding place builds again every placeSec (sandbags: 6 in one second)', async () => {
    const { m, isl, yaw, stand } = await setup('sandbags', 10);
    const spots = row(stand, yaw, isl.groundY);
    const times: number[] = [];
    // Held place: every tick sends the spot the ghost now shows (the next free one).
    for (let i = 0; i < 30; i++) {
      const req: BuildRequest = { kind: 'sandbags', pos: spots[times.length], rotY: yaw, free: true };
      times.push(...placedTimes(m.tick(inputs({ build: req, yaw }))));
    }
    const gapTicks = Math.ceil(PIECES.sandbags.placeSec / DT - 1e-9);
    expect(times).toHaveLength(Math.ceil(30 / gapTicks));
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(PIECES.sandbags.placeSec - 1e-9); // host still caps the rate
      expect(times[i] - times[i - 1]).toBeLessThan(PIECES.sandbags.placeSec + DT + 1e-9);
    }
  });

  test('moving, looking and switching slots are not blocked while placing', async () => {
    const { m, yaw } = await setup('wood', 10);
    let s = m.tick(new Map());
    const start = me(s).pos;
    let placed = 0, sawBusy = false, switched = false;
    for (let i = 0; i < 30; i++) {
      const p = me(s);
      const at = add(p.pos, add(scale(right(yaw), 3), scale(forward(yaw), 1)));
      const busy = p.busyUntil > s.time;
      sawBusy ||= busy;
      const look = yaw + Math.sin(i / 5) * 0.3;
      s = m.tick(inputs({ moveZ: 1, yaw: look, build: { kind: 'wood', pos: at, rotY: yaw, free: true }, select: busy ? (i % 2) + 1 : 0 }));
      placed += placedTimes(s).length;
      expect(me(s).yaw).toBe(look);
      if (busy) { expect(me(s).selected).toBe((i % 2) + 1); switched = true; }
    }
    expect(sawBusy && switched).toBe(true);
    expect(placed).toBeGreaterThanOrEqual(4);
    expect(dist2D(me(s).pos, start)).toBeGreaterThan(4.5); // walk speed ~5 m/s, as if not building
  });

  test('a build that arrives while busy is placed when the busy time ends', async () => {
    const { m, isl, yaw, stand } = await setup('sandbags', 3);
    const spots = row(stand, yaw, isl.groundY);
    const t0 = placedTimes(m.tick(inputs({ build: { kind: 'sandbags', pos: spots[0], rotY: yaw, free: true } })))[0];
    expect(t0).toBeDefined();
    let s = m.tick(inputs({ build: { kind: 'sandbags', pos: spots[1], rotY: yaw, free: true } }));
    expect(placedTimes(s)).toEqual([]);
    let t1: number | undefined;
    for (let i = 0; i < 10 && t1 === undefined; i++) { s = m.tick(new Map()); t1 = placedTimes(s)[0]; }
    expect(t1! - t0).toBeGreaterThanOrEqual(PIECES.sandbags.placeSec - 1e-9);
    expect(t1! - t0).toBeLessThan(PIECES.sandbags.placeSec + DT + 1e-9);
    expect(s.pieces).toHaveLength(2);
  });

  test('a held build expires after BUILD.queueSec (steel busy time is longer than that)', async () => {
    expect(PIECES.steel.placeSec).toBeGreaterThan(BUILD.queueSec + DT);
    const { m, isl, yaw, stand } = await setup('steel', 3);
    const spots = row(stand, yaw, isl.groundY);
    m.tick(inputs({ build: { kind: 'steel', pos: spots[0], rotY: yaw, free: true } }));
    m.tick(inputs({ build: { kind: 'steel', pos: spots[1], rotY: yaw, free: true } }));
    let s = m.tick(new Map());
    for (let i = 0; i < 30; i++) s = m.tick(new Map());
    expect(s.pieces).toHaveLength(1);
  });
});

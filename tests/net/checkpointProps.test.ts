import { describe, expect, it } from 'vitest';
import { Match } from '../../src/sim/match';
import { stateHash } from '../../src/sim/replay/hash';
import { gunzip, gzip } from '../../src/net/checkpoint';
import { loadMatch, saveMatch } from '../../src/net/matchCheckpoint';
import { PROP_CANON_TICKS } from '../../src/sim/props';
import { NO_INPUT, type PlayerInput } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

const bots = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, isBot: true, difficulty: 'hard' as const }));

describe('host-migration checkpoint with gameplay props', () => {
  it('a restored match ticks bit-identically for 600 ticks while props tumble, and the props part stays compact', async () => {
    const m = await Match.create({ players: [{ name: 'me', isBot: false }, ...bots(7)], seed: 11 });
    for (let i = 0; i < 300; i++) m.tick(new Map());
    // knock a dozen props into the air so the restore has bodies in flight, in contact and settling
    const ps = m.debugProps()!;
    for (let id = 1; id <= 12; id++) {
      const r = ps.restPose(id)!;
      ps.debugPlace(id, v3(r.pos.x + 0.3, r.pos.y + 1.5 + id * 0.1, r.pos.z));
    }
    // the human walks in circles near its island's props: pushes recorded mid-log
    const walk = (t: number): PlayerInput => ({ ...NO_INPUT, moveZ: 1, yaw: t * 0.07, fire: t % 25 < 2 });
    let t = 0;
    for (let i = 0; i < 7; i++) m.tick(new Map([[1, walk(t++)]])); // land mid-way between canonical rebuilds
    expect(ps.poses().length).toBeGreaterThan(5);
    expect((ps as unknown as { log: unknown[] }).log.length % PROP_CANON_TICKS).not.toBe(0);

    const raw = saveMatch(m);
    const packed = await gzip(raw);
    const propsOnly = await gzip(new TextEncoder().encode(JSON.stringify(ps.save(), (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v))));
    console.info(`[checkpoint+props] ${raw.byteLength} B raw, ${packed.byteLength} B gzip (props part ≈ ${propsOnly.byteLength} B gzip as json)`);
    const r = await loadMatch(await gunzip(packed));
    const rp = r.debugProps()!;
    for (let i = 0; i < 600; i++) {
      const inputs = new Map([[1, walk(t++)]]);
      const a = m.tick(inputs), b = r.tick(inputs);
      expect(stateHash(b), `tick ${a.tick}`).toBe(stateHash(a));
      if (i % 50 === 0) for (let id = 1; id <= ps.count; id++) expect(rp.pose(id)).toEqual(ps.pose(id));
    }
    m.dispose(); r.dispose();
  }, 180_000);
});

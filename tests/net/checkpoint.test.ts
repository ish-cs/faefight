import { describe, expect, it } from 'vitest';
import { Match } from '../../src/sim/match';
import { stateHash } from '../../src/sim/replay/hash';
import { gunzip, gzip, newCheckpointKey, openCheckpoint, sealCheckpoint, type SessionMeta } from '../../src/net/checkpoint';
import { loadMatch, saveMatch } from '../../src/net/matchCheckpoint';
import type { PlayerInput } from '../../src/sim/types';
import { NO_INPUT } from '../../src/sim/types';

const bots = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, isBot: true, difficulty: 'pro' as const }));

/** A human who runs in a circle and keeps shooting: exercises movement, combat and lag compensation. */
const humanInput = (t: number): PlayerInput => ({ ...NO_INPUT, moveZ: 1, yaw: t * 0.05, fire: t % 20 < 3, viewT: undefined });

describe('match checkpoint', () => {
  it('a restored match equals the original and ticks identically (bots, rng, physics, pieces)', async () => {
    const m = await Match.create({ players: [{ name: 'me', isBot: false }, ...bots(5)], seed: 7 });
    for (let i = 0; i < 1500; i++) m.tick(new Map([[1, humanInput(i)]])); // 50 s: bots have bought, built, fought
    const raw = saveMatch(m);
    const packed = await gzip(raw);
    console.info(`[checkpoint] 6 players after 50 s: ${raw.byteLength} B raw, ${packed.byteLength} B gzip`);
    const r = await loadMatch(await gunzip(packed));
    for (let i = 0; i < 900; i++) {
      const inputs = new Map([[1, humanInput(1500 + i)]]);
      const a = m.tick(inputs), b = r.tick(inputs);
      if (i === 0 || i % 30 === 0 || i === 899) expect(stateHash(b), `tick ${a.tick}`).toBe(stateHash(a));
    }
    expect(m.tick(new Map()).pieces.length).toBeGreaterThan(0);
    m.dispose(); r.dispose();
  }, 120_000);

  it('a match with a spectated bot (brain probe on) checkpoints and ticks identically', async () => {
    const m = await Match.create({ players: bots(3), seed: 9 });
    const b = m.botBrain(2) as unknown as { debugBrain(): { id: number } };
    for (let i = 0; i < 300; i++) { m.tick(new Map()); if (i % 8 === 0) b.debugBrain(); }
    const r = await loadMatch(saveMatch(m));
    for (let i = 0; i < 300; i++) {
      const x = m.tick(new Map()), y = r.tick(new Map());
      if (i % 30 === 0) expect(stateHash(y), `tick ${x.tick}`).toBe(stateHash(x));
    }
    expect((r.botBrain(2) as unknown as { debugBrain(): { id: number } }).debugBrain().id).toBe(2);
    m.dispose(); r.dispose();
  }, 60_000);

  it('a restored match is independent of the original', async () => {
    const m = await Match.create({ players: bots(2), seed: 3 });
    for (let i = 0; i < 300; i++) m.tick(new Map());
    const r = await loadMatch(saveMatch(m));
    const ref = await Match.create({ players: bots(2), seed: 3 });
    for (let i = 0; i < 300; i++) ref.tick(new Map());
    for (let i = 0; i < 600; i++) r.tick(new Map());
    for (let i = 0; i < 60; i++) expect(stateHash(m.tick(new Map()))).toBe(stateHash(ref.tick(new Map())));
    m.dispose(); r.dispose(); ref.dispose();
  }, 60_000);

  it('a restored seat can be handed to a bot and back (setBot / setHuman after restore)', async () => {
    const m = await Match.create({ players: [{ name: 'me', isBot: false }, { name: 'you', isBot: false }, ...bots(1)], seed: 5 });
    for (let i = 0; i < 200; i++) m.tick(new Map());
    const r = await loadMatch(saveMatch(m));
    r.setBot(1, 'medium');
    for (let i = 0; i < 120; i++) r.tick(new Map());
    expect(r.humanIds()).toEqual([2]);
    r.setHuman(1);
    expect(r.humanIds()).toEqual([1, 2]);
    m.dispose(); r.dispose();
  }, 60_000);

  it('stays within the bandwidth budget: 8 players, 3 minutes in, under 135 KB gzipped', async () => {
    const m = await Match.create({ players: bots(8), seed: 21 });
    for (let i = 0; i < 30 * 180; i++) m.tick(new Map());
    const t0 = performance.now();
    const raw = saveMatch(m);
    const t1 = performance.now();
    const packed = await gzip(raw);
    const t2 = performance.now();
    const jsonLen = new DataView(raw.buffer).getUint32(4, true), worldLen = new DataView(raw.buffer).getUint32(8, true);
    console.info(`[checkpoint] 8 players after 180 s: ${raw.byteLength} B raw (json ${jsonLen}, rapier ${worldLen}), ${packed.byteLength} B gzip; save ${(t1 - t0).toFixed(1)} ms, gzip ${(t2 - t1).toFixed(1)} ms`);
    // 135 KB: the trained bots' brain state (current plan + steps, dodger) adds ~1.6 KB gzip per bot. A checkpoint goes
    // out once per host migration; 130 KB over a WebRTC data channel is well under a second, far inside the 15 s window.
    expect(packed.byteLength).toBeLessThan(135_000);
    m.dispose();
  }, 180_000);

  it('rejects garbage', async () => {
    await expect(loadMatch(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).rejects.toThrow(/magic/);
  });
});

describe('sealed checkpoint envelope', () => {
  const meta: SessionMeta = { slots: [], seatIds: [1, 2], islands: [0, 1], mapChoice: 'harbor', tokens: [[1, 'tok-123456']], tick: 42 };

  it('round-trips with the right key', async () => {
    const key = await newCheckpointKey();
    const match = new Uint8Array([9, 8, 7, 6, 5]);
    const sealed = await sealCheckpoint({ meta, match }, key);
    const back = await openCheckpoint(sealed, key);
    expect(back.meta).toEqual(meta);
    expect([...back.match]).toEqual([...match]);
  });

  it('cannot be opened (or read) without the key', async () => {
    const sealed = await sealCheckpoint({ meta, match: new Uint8Array(64) }, await newCheckpointKey());
    await expect(openCheckpoint(sealed, await newCheckpointKey())).rejects.toThrow();
    expect(new TextDecoder().decode(sealed)).not.toContain('tok-123456');
    const tampered = new Uint8Array(sealed.slice(0));
    tampered[20] ^= 1;
    const key = await newCheckpointKey();
    await expect(openCheckpoint(tampered.buffer, key)).rejects.toThrow();
  });
});

import { describe, test } from 'vitest';
import { InterestManager } from '../../src/net/interest';
import { SnapshotEncoder } from '../../src/net/snapshotCodec';
import { SnapRate } from '../../src/net/snapRate';
import { WireDecoder, WireEncoder, wireHeader } from '../../src/net/wire';
import { Match } from '../../src/sim/match';
import type { PieceKind, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

// Net/sim measurements, off by default: BENCH=1 npx vitest run tests/net/netBench.test.ts --silent=false
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const KINDS: PieceKind[] = ['wood', 'metal', 'steel', 'sandbags', 'scaffold', 'container'];

/** 8 bots crowded onto one island with `pieces` pieces around them: a firefight. */
export async function firefight(pieces: number, seed = 7) {
  const m = await Match.create({ players: Array.from({ length: 8 }, () => ({ name: '', isBot: true, difficulty: 'hard' as const })), seed });
  const isl = m.map[0];
  m.tick(new Map());
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    m.debugTeleport(i + 1, v3(isl.center.x + Math.cos(a) * 9, isl.groundY, isl.center.z + Math.sin(a) * 9));
    m.debugGive(i + 1, { weapons: { smg: { mag: 30, spare: 900 }, rifle: { mag: 25, spare: 900 } } });
  }
  // Pieces spread over every island (rings), the way a long match fills up.
  for (let i = 0; i < pieces; i++) {
    const il = m.map[i % m.map.length];
    const k = Math.floor(i / m.map.length);
    const a = k * 0.61, r = 6 + (k % 5) * 2.5;
    m.debugPlacePiece(KINDS[i % KINDS.length], v3(il.center.x + Math.cos(a) * r, il.groundY, il.center.z + Math.sin(a) * r), a);
  }
  return m;
}

const q = (xs: number[], k: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * k))] ?? 0; };
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

type Pack = (x: unknown) => ArrayBuffer;

/** Old path: object snapshots at 15 Hz through PeerJS BinaryPack. */
function legacyPipe(map: Match['map'], pack: Pack) {
  const enc = new SnapshotEncoder(), interest = new InterestManager(map);
  let bytes = 0, ms = 0;
  return {
    tick(snap: Snapshot, t: number) {
      const t0 = performance.now();
      enc.push(snap);
      if (t % 2 === 0) {
        interest.update(snap);
        for (let v = 2; v <= 8; v++) bytes += pack({ t: 'snap', s: interest.apply(v, enc.take(v)) }).byteLength;
      }
      ms += performance.now() - t0;
    },
    get bytes() { return bytes; }, get ms() { return ms; },
  };
}

/** New path: binary deltas vs acked baselines (acks `lag` messages late), adaptive 15/30 Hz. */
function wirePipe(map: Match['map'], pack: Pack, lag: number) {
  const enc = new SnapshotEncoder(), interest = new InterestManager(map);
  const clients = Array.from({ length: 7 }, () => ({ wire: new WireEncoder(), rate: new SnapRate(), dec: new WireDecoder(), acks: [] as number[], n: 0 }));
  let bytes = 0, ms = 0, sends = 0, fast = 0;
  return {
    tick(snap: Snapshot, t: number) {
      const t0 = performance.now();
      enc.push(snap);
      let updated = false;
      clients.forEach((c, i) => {
        if (!c.rate.due(t)) return;
        if (!updated) { interest.update(snap); updated = true; }
        const b = c.wire.encode(snap.tick, interest.apply(i + 2, enc.take(i + 2, true)));
        c.rate.sent(b.byteLength, wireHeader(b).baseSeq === 0);
        bytes += pack({ t: 'snap', b }).byteLength;
        sends++;
        if (c.rate.fast) fast++;
        // Client side (not timed as host cost).
        const t1 = performance.now();
        if (!c.dec.decode(b)) throw new Error('bench: undecodable delta');
        c.acks.push(c.dec.ack);
        if (c.acks.length > lag) c.wire.ack(c.acks.shift()!);
        ms -= performance.now() - t1;
      });
      ms += performance.now() - t0;
    },
    get bytes() { return bytes; }, get ms() { return ms; }, get fastShare() { return fast / (sends || 1); }, get sends() { return sends; },
  };
}

describe.runIf(env.BENCH)('net/sim bench', () => {
  for (const pieces of [100, 300]) {
    test(`8 bots, ${pieces} pieces: host tick + snapshot bytes`, async () => {
      const { util } = await import('peerjs');
      const pack = util.pack as Pack;
      const m = await firefight(pieces);
      if (env.NOCLONE) m.cloneSnapshots = false; // as in the worker
      const legacy = legacyPipe(m.map, pack), wire = wirePipe(m.map, pack, 3);
      const tickMs: number[] = [];
      let shots = 0, hits = 0;
      const TICKS = Number(env.TICKS ?? 600);
      let snap: Snapshot | null = null;
      for (let t = 0; t < TICKS; t++) {
        const t0 = performance.now();
        snap = m.tick(new Map());
        tickMs.push(performance.now() - t0);
        for (const e of snap.events) { if (e.type === 'shot') shots++; if (e.type === 'hit') hits++; }
        legacy.tick(snap, t);
        wire.tick(snap, t);
      }
      const secs = TICKS / 30, kbps = (n: number) => (n / 7 / secs / 1024).toFixed(1);
      console.log(`[bench] pieces=${pieces} ticks=${TICKS} shots=${shots} hits=${hits} alive=${snap!.players.filter((p) => p.alive).length}`);
      console.log(`[bench] sim tick ms avg ${avg(tickMs).toFixed(2)} p95 ${q(tickMs, 0.95).toFixed(2)} max ${Math.max(...tickMs).toFixed(2)}`);
      console.log(`[bench] legacy (objects+BinaryPack, 15 Hz): ${kbps(legacy.bytes)} KB/s per client, host ${(legacy.ms / TICKS).toFixed(2)} ms/tick`);
      console.log(`[bench] wire (binary delta, ${(wire.fastShare * 100).toFixed(0)}% of sends at 30 Hz, ${(wire.sends / 7 / secs).toFixed(1)} msg/s): ${kbps(wire.bytes)} KB/s per client, host ${(wire.ms / TICKS).toFixed(2)} ms/tick`);
    }, 300_000);
  }
});

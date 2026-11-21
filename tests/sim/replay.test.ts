import { describe, expect, it } from 'vitest';
import { Match } from '../../src/sim/match';
import type { MoveCmd } from '../../src/sim/movement';
import { decodeReplay, encodeReplay } from '../../src/sim/replay/codec';
import type { Replay, TickInput } from '../../src/sim/replay/format';
import { stateHash } from '../../src/sim/replay/hash';
import { recordHeadlessMatch } from '../../src/sim/replay/headless';
import { Recorder } from '../../src/sim/replay/recorder';
import { ReplayRunner } from '../../src/sim/replay/runner';
import { NO_INPUT, type HotbarItem, type Inventory, type PlayerInput, type Snapshot } from '../../src/sim/types';

const seat = (i: number) => ({ name: `Bot (pro) ${i}`, isBot: true, difficulty: 'pro' as const });

/** A scripted "human" (player 1) that walks, turns, shoots, builds, throws, fires rockets, drinks and shops. */
function humanInput(t: number, snap: Snapshot): PlayerInput {
  const me = snap.players.find((p) => p.id === 1)!;
  const slot = (item: HotbarItem) => { const i = me.hotbar.indexOf(item); return i >= 0 ? i : null; };
  const yaw = 0.7 + Math.sin(t / 37) * 1.3 + t * 1e-3; // non-float32 values on purpose
  const input: PlayerInput = { ...NO_INPUT, yaw, pitch: Math.cos(t / 23) * 0.2, moveZ: t % 200 < 120 ? 1 : 0, moveX: t % 90 < 30 ? -0.7071067811865476 : 0, sprint: t % 300 < 100 };
  const phase = t % 400;
  if (phase < 60) input.select = slot('rocket');
  else if (phase < 120) input.select = slot('smg');
  else if (phase < 160) input.select = slot('wood');
  else if (phase < 200) input.select = slot('grenade');
  else if (phase < 240) input.select = slot('healPotion');
  if (phase === 30 || phase === 90 || (phase > 60 && phase < 120 && phase % 3 === 0)) input.fire = true;
  if (phase === 150) {
    const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    input.build = { kind: 'wood', pos: { x: me.pos.x + f.x * 3, y: me.pos.y, z: me.pos.z + f.z * 3 }, rotY: yaw, free: false };
  }
  if (phase === 190) input.throwGrenade = true;
  if (phase === 230) input.drink = true;
  if (t % 500 === 250) input.shop = { buy: 'wood' };
  if (t % 70 === 0) input.jump = true;
  if (t === 333) input.drop = 'one';
  return input;
}

async function recordScripted(ticks: number, seed: number) {
  const setup = { players: [{ name: 'You', isBot: false }, seat(1), seat(2), seat(3)], seed };
  const m = await Match.create(setup);
  const rec = new Recorder(m, { setup, kind: 'test', localId: 1, recordedAt: 0, id: 'test' });
  const hashes: number[] = [];
  let snap = rec.tick(new Map());
  hashes.push(stateHash(snap));
  const give: Partial<Inventory> = { cash: 400, pieces: { wood: 6 }, grenades: 3, potions: { healPotion: 2 }, weapons: { rocket: { mag: 1, spare: 6 }, smg: { mag: 30, spare: 90 } } };
  m.debugGive(1, give); rec.op({ k: 'give', id: 1, inv: give });
  let seq = 0;
  for (let t = 2; t <= ticks; t++) {
    if (t === 240) { const pos = { ...m.map[0].shop }; m.debugTeleport(1, pos); rec.op({ k: 'teleport', id: 1, pos }); }
    if (t % 45 === 0) {
      const req = { kind: 'wood' as const, pos: { x: snap.players[0].pos.x + 2, y: snap.players[0].pos.y, z: snap.players[0].pos.z }, rotY: 0.3, free: false };
      m.previewBuild(1, req); rec.op({ k: 'preview', id: 1, req });
    }
    const input = humanInput(t, snap);
    // 0, 1 or 2 movement commands per tick (jittery link), their yaw a frame older than the input's.
    const n = t % 11 === 0 ? 0 : t % 13 === 0 ? 2 : 1;
    const cmds: MoveCmd[] = [];
    for (let i = 0; i < n; i++) cmds.push({ seq: ++seq, moveX: input.moveX, moveZ: input.moveZ, yaw: i ? input.yaw : input.yaw - 0.01, jump: input.jump, sprint: input.sprint });
    snap = rec.tick(new Map([[1, input]]), new Map([[1, cmds]]));
    hashes.push(stateHash(snap));
  }
  const out = await rec.finish();
  m.dispose();
  return { ...out, hashes };
}

describe('replay recording', { timeout: 240_000 }, () => {
  it('re-running a recorded vs-bot match reproduces every tick exactly (pieces, explosions, potions, shop, ops)', async () => {
    const { bytes, hashes } = await recordScripted(1800, 21);
    const replay = await decodeReplay(bytes);
    expect(replay.ticks.length).toBe(1800);
    const types = new Set(replay.events.map((e) => e[1]));
    for (const t of ['placed', 'explosion', 'hit', 'bought']) expect(types, t).toContain(t);
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
    for (let i = 0; i < hashes.length; i++) {
      const s = runner.step()!;
      if (stateHash(s) !== hashes[i]) throw new Error(`diverged at tick ${s.tick}`);
    }
    expect(runner.divergedAt).toBeNull();
    expect(runner.step()).toBeNull();
    runner.dispose();
  });

  it('flags a replay that no longer matches (e.g. different code)', async () => {
    const { bytes } = await recordScripted(120, 4);
    const replay = await decodeReplay(bytes);
    replay.hashes[1] ^= 1;
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
    runner.seek(120);
    expect(runner.divergedAt).toBe(60);
    runner.dispose();
  });

  it('seeking (forward, back, across checkpoints) gives the same state as playing to that tick', async () => {
    const { bytes, hashes } = await recordScripted(1300, 9);
    const replay = await decodeReplay(bytes);
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 300 });
    for (const t of [700, 650, 1299, 301, 300, 1, 900, 299, 1300, 2]) {
      const s = runner.seek(t)!;
      expect(s.tick, `seek ${t}`).toBe(t);
      expect(stateHash(s), `seek ${t}`).toBe(hashes[t - 1]);
    }
    expect(runner.seek(0)).toBeNull();
    runner.dispose();
  });

  it('all-bot self-play: recordHeadlessMatch replays identically', async () => {
    const setup = { players: [seat(1), seat(2), seat(3), seat(4)] };
    const seen: number[] = [];
    const r = await recordHeadlessMatch(setup, 77, 1500, { onSnapshot: (s) => seen.push(stateHash(s)) });
    expect(r.footer.ticks).toBe(seen.length);
    const replay = await decodeReplay(r.bytes);
    expect(replay.header.kind).toBe('selfplay');
    expect(replay.ticks.every((t) => t.length === 0)).toBe(true);
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
    for (const h of seen) expect(stateHash(runner.step()!)).toBe(h);
    runner.dispose();
  });

  it('round trip: record a match, encode, decode, replay it: identical final state (every map, all op kinds)', async () => {
    for (const map of ['harbor', 'yard'] as const) {
      // Two humans: one is handed to a bot and back (disconnect + reconnect), debug ops along the way.
      const setup = { players: [{ name: 'You', isBot: false }, { name: 'Friend', isBot: false }, seat(1), seat(2)], seed: 31, map };
      const m = await Match.create(setup);
      const rec = new Recorder(m, { setup, kind: 'test', localId: 1, recordedAt: 0, id: `rt-${map}` });
      let snap = rec.tick(new Map());
      const op = (o: Parameters<Recorder['op']>[0], apply: () => void) => { apply(); rec.op(o); };
      for (let t = 2; t <= 900; t++) {
        if (t === 100) op({ k: 'setBot', id: 2, difficulty: 'hard' }, () => m.setBot(2, 'hard'));
        if (t === 400) op({ k: 'setHuman', id: 2 }, () => m.setHuman(2));
        if (t === 150) {
          const me = snap.players.find((p) => p.id === 1)!;
          const pos = { x: me.pos.x + 4, y: me.pos.y, z: me.pos.z };
          op({ k: 'piece', kind: 'metal', pos, rotY: 0.5 }, () => m.debugPlacePiece('metal', pos, 0.5));
        }
        if (t === 200) op({ k: 'shield', id: 1, shield: 50 }, () => m.debugSetShield(1, 50));
        const inputs = new Map<number, PlayerInput>([[1, humanInput(t, snap)]]);
        if (t < 100 || t >= 400) inputs.set(2, { ...humanInput(t + 77, snap), yaw: -t * 0.01 });
        snap = rec.tick(inputs);
      }
      const final = snap;
      const { bytes } = await rec.finish();
      m.dispose();

      const replay = await decodeReplay(bytes);
      expect(replay.header.setup.map).toBe(map);
      expect(replay.ops.map((o) => o.op.k)).toEqual(['setBot', 'piece', 'shield', 'setHuman']);
      const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
      let last: Snapshot | null = null;
      for (let s = runner.step(); s; s = runner.step()) last = s;
      expect(runner.divergedAt, map).toBeNull();
      expect(last!.tick).toBe(final.tick);
      expect(last, map).toEqual(final);
      runner.dispose();
    }
  });
});

describe('replay codec', () => {
  const sample = (): Replay => {
    const base: PlayerInput = { ...NO_INPUT, yaw: 1.2345678901234, pitch: -0.25, moveZ: 1 };
    const ticks: TickInput[][] = [
      [],
      [{ id: 1, input: base, moves: [] }],
      [{ id: 1, input: { ...base, fire: true, ads: true, select: 3, slot: 'rifle', shop: { buy: 'lock:rifle' } }, moves: [{ seq: 1, moveX: 0, moveZ: 1, yaw: 1.2345678901234, jump: true, sprint: false }] },
        { id: 2, input: { ...base, moveX: -0, build: { kind: 'ramp', pos: { x: 1.5, y: 2, z: -3.25 }, rotY: Math.PI, free: true }, vault: { deposit: { cash: 5 } }, drop: 'stack', moveSlot: { from: 1, to: 8 } } }],
      [{ id: 1, input: { ...base, ...({ crouch: true } as object) } as PlayerInput, moves: [{ seq: 5, moveX: 0.3, moveZ: -1, yaw: 9.87654321e-7, jump: false, sprint: true }, { seq: 6, moveX: 0, moveZ: 1, yaw: 1.2345678901234, jump: false, sprint: false }] }],
      [{ id: 1, input: base }],
    ];
    return {
      header: { format: 1, id: 'x', kind: 'test', recordedAt: 1, build: 'b', setup: { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }], seed: 3 }, localId: 1, players: [], map: [] },
      footer: { ticks: 5, duration: 0.16, winner: null, unfinished: true },
      ticks, ops: [{ tick: 2, op: { k: 'setBot', id: 2, difficulty: 'hard' } }], hashes: [1, 4294967295], events: [[3, 'kill', { victim: 2, killer: 1 }]],
      seconds: [{ t: 1, tick: 30, p: [[1, 0.1, 2, 3, 100, 0, 1, 50, 0, 0, 'fists', 0, 0]], pieces: 0, sealed: [0, 1], waterY: -1 }],
    };
  };

  it('round-trips exactly (floats, -0, nulls, extra input fields, move commands)', async () => {
    const r = sample();
    const back = await decodeReplay(await encodeReplay(r));
    expect(back).toEqual(r);
    expect(Object.is(back.ticks[2][1].input.moveX, -0)).toBe(true);
    expect((back.ticks[3][0].input as unknown as { crouch: boolean }).crouch).toBe(true);
    expect('crouch' in back.ticks[4][0].input).toBe(false);
  });

  it('rejects files that are not replays or are corrupt', async () => {
    await expect(decodeReplay(new Uint8Array([1, 2, 3, 4, 5, 6]))).rejects.toThrow(/not a .faereplay/);
    const bytes = await encodeReplay(sample());
    await expect(decodeReplay(bytes.slice(0, bytes.length >> 1))).rejects.toThrow();
  });

  it('a 15-minute 8-player match with 8 busy humans stays under 3 MB', async () => {
    const ticks: TickInput[][] = [];
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const state = Array.from({ length: 8 }, () => ({ yaw: rnd() * 6, pitch: 0, seq: 0, mx: 0, mz: 1 }));
    for (let t = 0; t < 15 * 60 * 30; t++) {
      ticks.push(state.map((p, i) => {
        // Full-precision aim (float64, as the client sends it); the mouse moves on ~70% of ticks.
        if (rnd() < 0.7) p.yaw = p.yaw + (rnd() - 0.5) * 0.1;
        if (rnd() < 0.3) p.pitch = p.pitch + (rnd() - 0.5) * 0.05;
        if (rnd() < 0.05) { p.mx = [-1, 0, 1][Math.floor(rnd() * 3)]; p.mz = [-1, 0, 1][Math.floor(rnd() * 3)]; }
        const input: PlayerInput = { ...NO_INPUT, yaw: p.yaw, pitch: p.pitch, moveX: p.mx, moveZ: p.mz, fire: rnd() < 0.2, ads: rnd() < 0.3, sprint: p.mz > 0, select: 1 };
        const n = rnd() < 0.1 ? 2 : rnd() < 0.1 ? 0 : 1;
        const moves = Array.from({ length: n }, () => ({ seq: ++p.seq, moveX: p.mx, moveZ: p.mz, yaw: p.yaw, jump: false, sprint: p.mz > 0 }));
        return { id: i + 1, input, moves };
      }));
    }
    const r = sample();
    r.ticks = ticks;
    // Event log + summaries roughly as a real match: ~6000 hits, 900 summaries.
    r.events = Array.from({ length: 6000 }, (_, i) => [i * 4, 'hit', { target: 1 + (i % 8), by: 1 + ((i + 3) % 8), amount: 23.4, shieldAmount: 0, broke: false, part: 'body', weapon: 'smg', pos: { x: 12.3, y: 4.5, z: -6.7 }, dist: 17.25 }]);
    r.seconds = Array.from({ length: 900 }, (_, k) => ({ t: k + 1, tick: (k + 1) * 30, p: state.map((_, i) => [i + 1, rnd() * 100, 2.1, rnd() * 100, 87, 25, 1, 340, 2, 1, 'smg', 0, 0]), pieces: 120, sealed: [0, 0, 0, 0, 0, 0, 0, 0], waterY: -1 }));
    r.hashes = Array.from({ length: 900 }, (_, i) => i * 2654435761 >>> 0);
    const bytes = await encodeReplay(r);
    console.info(`[replay size] 15 min, 8 humans: ${(bytes.length / 1e6).toFixed(2)} MB`);
    expect(bytes.length).toBeLessThan(3e6);
    const back = await decodeReplay(bytes);
    expect(back.ticks[20000]).toEqual(ticks[20000]);
  });
});

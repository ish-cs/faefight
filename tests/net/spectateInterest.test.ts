import { describe, expect, test } from 'vitest';
import { InterestManager, spectateTarget } from '../../src/net/interest';
import { SnapshotDecoder, SnapshotEncoder, type NetSnapshot } from '../../src/net/snapshotCodec';
import { WireDecoder, WireEncoder } from '../../src/net/wire';
import { buildMap } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { BotBrainInfo, PlayerState, Snapshot } from '../../src/sim/types';

const brainOf = (id: number): BotBrainInfo => ({
  id, personality: 'Rusher', difficulty: 'hard', action: 'attack', goal: 'seal', reason: 'p1 is away', steps: ['bridge over', 'plug the door'],
  step: 1, fightOdds: 0.4, thought: 'Goal: seal', target: 1, options: [{ goal: 'seal', score: 1.2 }, { goal: 'shop', score: 0.7 }],
});

function setup() {
  const map = buildMap(3);
  const players = map.map((isl, i) => newPlayer(i + 1, `p${i + 1}`, i === 2, i, isl.center));
  // Player 3 (a bot) carries a rifle, grenades and cash, and is tired.
  const bot = players[2];
  bot.inv.weapons.rifle = { mag: 3, spare: 20 };
  bot.inv.grenades = 2;
  bot.inv.cash = 777;
  bot.hotbar[0] = 'rifle';
  bot.hotbar[1] = 'grenade';
  bot.stamina = 42;
  return { map, players };
}
const snapOf = (players: PlayerState[]): Snapshot => ({
  time: 10, tick: 300, players, pieces: [], loot: [], generators: players.map((p) => ({ island: p.island, stored: 0 })), genLevels: players.map(() => 1),
  sealed: players.map(() => false), waterY: 0, suddenDeath: false, winner: null, events: [], brains: [brainOf(3)],
});

/** HostSession's path: spectateTarget, encoder.take, interest, binary wire, decoder. */
function viewAs(map: ReturnType<typeof buildMap>, snap: Snapshot, viewer: number, follow: number | null) {
  const enc = new SnapshotEncoder(), im = new InterestManager(map);
  enc.push(snap);
  im.update(snap);
  const t = spectateTarget(snap, viewer, follow);
  const net = im.apply(viewer, enc.take(viewer, true, t), t);
  const w = new WireDecoder().decode<NetSnapshot>(new WireEncoder().encode(snap.tick, net))!;
  return { net, out: new SnapshotDecoder().decode(w) };
}

describe('spectator full view (anti-cheat)', () => {
  test('a living player never gets anyone else\'s inventory, hotbar, stamina or brain, even if it asks to follow', () => {
    const { map, players } = setup();
    const snap = snapOf(players);
    expect(spectateTarget(snap, 1, 3)).toBeNull();
    const { net, out } = viewAs(map, snap, 1, 3);
    expect(net.brain).toBeUndefined();
    const p3 = net.players.find((p) => p.id === 3)!;
    expect(p3.inv).toBeUndefined();
    expect(p3.hotbar).toBeUndefined();
    expect(p3.stamina).toBeUndefined();
    expect(out.brains).toBeUndefined();
    expect(out.players.find((p) => p.id === 3)!.inv.cash).toBe(0);
    // Own stamina arrives (inside mv) and is restored by the decoder.
    players[0].mv!.stamina = 63;
    players[0].stamina = 63;
    expect(viewAs(map, snapOf(players), 1, null).out.players[0].stamina).toBe(63);
  });

  test('a dead spectator following a bot gets that bot\'s full HUD state and brain, and nobody else\'s', () => {
    const { map, players } = setup();
    players[0].alive = false;
    players[0].respawnAt = 15;
    players[1].inv.cash = 555;
    const snap = snapOf(players);
    expect(spectateTarget(snap, 1, 3)).toBe(3);
    const { out } = viewAs(map, snap, 1, 3);
    const p3 = out.players.find((p) => p.id === 3)!;
    expect(p3.inv.cash).toBe(777);
    expect(p3.inv.weapons.rifle).toEqual({ mag: 3, spare: 20 });
    expect(p3.hotbar.slice(0, 2)).toEqual(['rifle', 'grenade']);
    expect(p3.stamina).toBe(42);
    expect(out.hidden ?? []).not.toContain(3);
    expect(out.brains).toEqual([brainOf(3)]);
    // The other player stays private.
    expect(out.players.find((p) => p.id === 2)!.inv.cash).toBe(0);
    // Following a human: their kit, but no brain (there is none).
    const h = viewAs(map, snap, 1, 2).out;
    expect(h.players.find((p) => p.id === 2)!.inv.cash).toBe(555);
    expect(h.brains).toBeUndefined();
  });

  test('following yourself, a dead player or nobody yields nothing', () => {
    const { players } = setup();
    players[0].alive = false;
    players[2].alive = false;
    const snap = snapOf(players);
    expect(spectateTarget(snap, 1, 1)).toBeNull();
    expect(spectateTarget(snap, 1, 3)).toBeNull();
    expect(spectateTarget(snap, 1, null)).toBeNull();
    expect(spectateTarget(snap, 1, 99)).toBeNull();
  });

  test('a stray brain is stripped unless it belongs to the vetted follow target', () => {
    const { map, players } = setup();
    const snap = snapOf(players);
    const im = new InterestManager(map);
    im.update(snap);
    const enc = new SnapshotEncoder();
    enc.push(snap);
    const net = { ...enc.take(1, true), brain: brainOf(3) };
    expect(im.apply(1, net, 3).brain).toBeUndefined(); // viewer 1 is alive: 3 isn't a valid target
  });
});

import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { islandAt } from '../../src/sim/bots/nav';
import { preset, type Archetype } from '../../src/sim/bots/personality';
import { PIECES, WEAPONS } from '../../src/sim/constants';
import { overDock } from '../../src/sim/docks';
import type { DockDef } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import type { Difficulty, MatchEvent, PlayerInput, Snapshot, Vec3 } from '../../src/sim/types';
import { add, scale, v3, forward } from '../../src/sim/vec';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
/** Bot seat 1 vs a human seat 2 who stands wherever the test puts them. */
async function duel(difficulty: Difficulty, archetype: Archetype = 'Rusher', seed = 5) {
  let bot: Bot | null = null;
  const m = await Match.create({ players: [{ name: '', isBot: true, difficulty }, { name: 'human', isBot: false }], seed },
    { makeBot: (id, d, rng) => (bot = new Bot(id, d, rng, preset(archetype))) });
  return { m, bot: () => bot! };
}
const top = (d: DockDef): Vec3 => v3(d.center.x, d.center.y + d.half.y, d.center.z);
function place(m: Match, id: number, pos: Vec3) {
  m.debugTeleport(id, pos);
  const p = (m as unknown as { s: { players: Map<number, { invulnUntil: number; spawnProtected?: boolean }> } }).s.players.get(id)!;
  p.invulnUntil = 0;
  p.spawnProtected = false;
}
const run = (m: Match, sec: number, until?: (s: Snapshot, ev: MatchEvent[]) => boolean) => {
  const events: MatchEvent[] = [];
  let s = m.tick(new Map<number, PlayerInput>());
  for (let i = 0; i < sec * 30; i++) {
    s = m.tick(new Map());
    events.push(...s.events);
    if (until?.(s, events)) break;
  }
  return { last: s, events };
};

describe('bots use the piers', () => {
  /**
   * The bot stands at its own island's front with a rocket launcher; the human walks out onto a pier. Every
   * skill but easy should blow the planks out from under them (and the human ends up in the water or dead).
   */
  async function onPier(difficulty: Difficulty, pierIsland: 0 | 1, weapon: 'rocket' | 'grenade', seed = 5) {
    const { m, bot } = await duel(difficulty, 'Rusher', seed);
    const home = m.map[0];
    const docks = m.def.docks!.filter((d) => d.island === pierIsland);
    const target = docks.find((d) => d.row === (pierIsland === 0 ? 3 : 2))!;
    // The bot: on its island, back from the pier (out of its own blast), facing out toward it.
    const spot = add(home.center, scale(forward(home.bunker.facingYaw), pierIsland === 0 ? 12 : home.radius - 1.5));
    place(m, 1, v3(spot.x, home.groundY + 0.05, spot.z));
    place(m, 2, top(target));
    if (weapon === 'rocket') m.debugGive(1, { weapons: { rocket: { mag: WEAPONS.rocket.mag, spare: 4 } } });
    else m.debugGive(1, { grenades: 3 });
    m.debugSetHp(2, 100);
    const r = run(m, 12, (_, ev) => ev.some((e) => e.type === 'dockBroken' && e.data.by === 1));
    const broke = r.events.filter((e) => e.type === 'dockBroken' && e.data.by === 1);
    if (env.DOCK_DEBUG) console.log(difficulty, pierIsland, r.events.filter((e) => ['kill', 'explosion', 'shot', 'dockBroken'].includes(e.type)).slice(0, 12).map((e) => `${e.t.toFixed(1)} ${e.type} ${JSON.stringify(e.data).slice(0, 90)}`).join('\n'));
    return { m, bot: bot(), broke, target };
  }

  test.each(['medium', 'hard', 'pro'] as Difficulty[])('%s: blows out the section of my own pier an attacker is crossing', async (d) => {
    const { broke, m } = await onPier(d, 0, 'rocket');
    expect(broke.length, `${d} never broke a section`).toBeGreaterThan(0);
    expect(m.def.docks!.find((x) => x.id === broke[0].data.id)!.island).toBe(0);
  }, 60_000);

  test('pro: blows the planks out under an enemy on their own pier', async () => {
    const { broke } = await onPier('pro', 1, 'rocket');
    expect(broke.length).toBeGreaterThan(0);
  }, 60_000);

  test('hard: does it with a grenade when it has no rocket', async () => {
    const { broke } = await onPier('hard', 0, 'grenade', 7);
    expect(broke.length).toBeGreaterThan(0);
  }, 60_000);

  test('the brain inspector says what it is doing', async () => {
    const { m, bot } = await duel('pro');
    const home = m.map[0];
    const target = m.def.docks!.find((d) => d.island === 0 && d.row === 3)!;
    const spot = add(home.center, scale(forward(home.bunker.facingYaw), 12));
    place(m, 1, v3(spot.x, home.groundY + 0.05, spot.z));
    place(m, 2, top(target));
    m.debugGive(1, { weapons: { rocket: { mag: WEAPONS.rocket.mag, spare: 4 } } });
    bot().watch(true);
    let step = '';
    run(m, 6, () => { step = bot().debugBrain().step; return step.startsWith('Blowing out'); });
    expect(step).toMatch(/Blowing out my pier under @2/);
  }, 60_000);

  test('pushing over its pier with a section blown out: it decks over the gap and crosses', async () => {
    const { m } = await duel('hard', 'Turtle', 9);
    m.debugGive(1, { weapons: { pistol: { mag: WEAPONS.pistol.mag, spare: 36 } }, pieces: { scaffold: 14, wood: 5 } });
    const hole = m.def.docks!.find((d) => d.island === 0 && d.row === 1)!;
    m.debugExplode('charge', v3(hole.center.x, hole.center.y - 1, hole.center.z));
    let snap = m.tick(new Map());
    expect(snap.docks ?? m.tick(new Map()).docks).toEqual([hole.id]);
    let crossed = false, patched = false;
    for (let i = 0; i < 150 * 30 && !crossed; i++) {
      snap = m.tick(new Map());
      patched ||= snap.pieces.some((p) => p.owner === 1 && p.kind === 'scaffold' && overDock(hole, p.pos, PIECES.scaffold.d / 2));
      const me = snap.players[0].pos;
      crossed = islandAt(m.map, me) === 1 || Math.hypot(me.x, me.z) < 12;
    }
    const decks = snap.pieces.filter((p) => p.owner === 1 && p.kind === 'scaffold').length;
    console.log(`pier gap: patched ${patched}, ${decks} decks, crossed ${crossed}`);
    expect(patched).toBe(true);
    expect(crossed).toBe(true);
  }, 150_000);
});

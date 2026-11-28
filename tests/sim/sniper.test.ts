import { beforeAll, describe, expect, test } from 'vitest';
import { scopeGlint, tryFire, tickReload, type CombatCtx } from '../../src/sim/combat';
import { HEAD, SHIELD_POTIONS, SNIPER_AMMO, WEAPONS } from '../../src/sim/constants';
import { ammoPerBox, ammoPrice, buy } from '../../src/sim/economy';
import { shotDamage, spreadDeg } from '../../src/sim/gunplay';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { Physics } from '../../src/sim/physics';
import { newPlayer } from '../../src/sim/player';
import { decodeReplay } from '../../src/sim/replay/codec';
import { Recorder } from '../../src/sim/replay/recorder';
import { ReplayRunner } from '../../src/sim/replay/runner';
import { bestGun } from '../../src/sim/bots/plans';
import { NO_INPUT, type MatchEvent, type PlayerInput, type PlayerState, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

/** Sniper rifle (2026-11-27): bolt-action, one-shot headshot, two-shot body, scoped accuracy, scarce ammo. */

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const isl = () => map[0];
const yaw = () => isl().bunker.facingYaw;
const spot = (d: number, side = 3): Vec3 => {
  const p = add(add(isl().center, scale(forward(yaw()), d)), scale(right(yaw()), side));
  return v3(p.x, isl().groundY, p.z);
};

async function setup(aAt = 4, bAt = 12) {
  const physics = await Physics.create(map);
  const a = newPlayer(1, 'a', false, 0, spot(aAt));
  const b = newPlayer(2, 'b', false, 0, spot(bAt));
  a.yaw = yaw();
  for (const p of [a, b]) physics.addPlayer(p.id, p.pos);
  let id = 100;
  const ctx: CombatCtx = {
    physics, players: new Map([[1, a], [2, b]]), pieces: new Map(), explosives: [], nextId: () => id++,
    onPieceDestroyed: () => {}, onKill: () => {}, grounded: () => true, onKnockback: () => {},
  };
  a.inv.weapons.sniper = { mag: WEAPONS.sniper.mag, spare: 10 };
  a.equipped = 'sniper';
  return { ctx, a, b };
}

describe('sniper rifle: numbers', () => {
  test('distinct from the rifle: pricier, slower, harder hitting, longer reach, stronger zoom', () => {
    const s = WEAPONS.sniper, r = WEAPONS.rifle;
    expect(s.price).toBeGreaterThan(r.price);
    expect(s.price).toBeGreaterThanOrEqual(600);
    expect(1 / s.rps).toBeGreaterThanOrEqual(1.2);
    expect(1 / s.rps).toBeLessThanOrEqual(1.4);
    expect(s.mag).toBe(5);
    expect(s.dmg).toBeGreaterThanOrEqual(75);
    expect(s.dmg).toBeLessThanOrEqual(85);
    expect(s.range).toBeGreaterThan(r.range);
    expect(s.adsZoom).toBeGreaterThanOrEqual(3);
    expect(s.adsZoom).toBeLessThanOrEqual(4);
    expect(s.adsMove).toBeLessThan(r.adsMove);
  });

  test('headshot kills from full health (and through a small shield); body shot does not, two do', () => {
    const head = shotDamage('sniper', 10, true).amount, body = shotDamage('sniper', 10, false).amount;
    expect(head).toBe(WEAPONS.sniper.dmg * HEAD.mult);
    expect(head).toBeGreaterThanOrEqual(100 + SHIELD_POTIONS.shieldSmall.cap);
    expect(body).toBeLessThan(100);
    expect(2 * body).toBeGreaterThanOrEqual(100);
  });

  test('minimal falloff: full damage to 90 m, 85% floor at 180 m+', () => {
    expect(shotDamage('sniper', 90).amount).toBe(85);
    expect(shotDamage('sniper', 200).amount).toBeCloseTo(85 * 0.85, 5);
    // A rifle round at 150 m is down to its floor; a sniper round still kills with two body shots.
    expect(2 * shotDamage('sniper', 150).amount).toBeGreaterThanOrEqual(100);
  });

  test('scoped and still: pinpoint; hipfire and moving: wide', () => {
    const still = { speed: 0, grounded: true }, walk = { speed: 5, grounded: true };
    const st = (ads: boolean) => ({ ads, bloom: 0, lastShotAt: -1e9 });
    expect(spreadDeg('sniper', st(true), 0, still)).toBeLessThanOrEqual(0.05);
    expect(spreadDeg('sniper', st(false), 0, still)).toBeGreaterThanOrEqual(5);
    expect(spreadDeg('sniper', st(true), 0, walk)).toBeGreaterThan(10 * spreadDeg('sniper', st(true), 0, still));
  });

  test('scarce ammo: 2 spare mags on buy, 1 mag per box at a higher price', () => {
    const p = newPlayer(1, 'a', false, 0, v3());
    p.inv.cash = 2000;
    expect(buy(p, { buy: 'sniper' }).ok).toBe(true);
    expect(p.inv.weapons.sniper).toEqual({ mag: 5, spare: 5 * SNIPER_AMMO.spareMags });
    expect(ammoPerBox('sniper')).toBe(5);
    expect(ammoPrice('sniper')).toBeGreaterThan(ammoPrice('rifle'));
  });
});

describe('sniper rifle: in the sim', () => {
  test('a scoped headshot kills from full health', async () => {
    const { ctx, a, b } = await setup();
    a.ads = true;
    const evs = tryFire(ctx, a, 0);
    expect(evs.find((e) => e.type === 'hit')!.data.part).toBe('head');
    expect(b.hp).toBeLessThanOrEqual(0);
  });

  test('a body shot leaves them standing; the follow-up kills', async () => {
    const { ctx, a, b } = await setup();
    a.ads = true;
    a.pitch = -0.12; // chest
    tryFire(ctx, a, 0);
    expect(b.hp).toBe(100 - 85);
    a.pitch = -0.12; // back down after the recoil
    tryFire(ctx, a, 1 / WEAPONS.sniper.rps + 0.01);
    expect(b.hp).toBeLessThanOrEqual(0);
  });

  test('bolt-action: one shot per 1.33 s however fast the trigger is pulled', async () => {
    const { ctx, a } = await setup(0, 60);
    let shots = 0;
    for (let i = 0; i <= 120; i++) { // 4 s at 30 Hz
      const t = i / 30;
      tickReload(a, t);
      shots += tryFire(ctx, a, t).filter((e: MatchEvent) => e.type === 'shot').length;
      a.pitch = 0;
    }
    expect(shots).toBe(4); // t = 0, 1.33, 2.67, 4.0
  });

  test('scope glint: only a scoped sniper, brightest straight down the barrel', async () => {
    const { a, b } = await setup(4, 60);
    const chest = (p: PlayerState) => v3(p.pos.x, p.pos.y + 1.2, p.pos.z);
    a.ads = false;
    expect(scopeGlint(a, chest(b))).toBe(0);
    a.ads = true;
    a.pitch = Math.atan2(1.2 - 1.6, 56);
    expect(scopeGlint(a, chest(b))).toBeGreaterThan(0.9);
    a.yaw += 0.5; // looking well away
    expect(scopeGlint(a, chest(b))).toBe(0);
    a.yaw -= 0.5; a.equipped = 'rifle';
    expect(scopeGlint(a, chest(b))).toBe(0);
  });

  test('bots: sniper only past the long-range threshold, SMG/pistol close', () => {
    const inv = newPlayer(1, 'a', false, 0, v3()).inv;
    inv.weapons.sniper = { mag: 5, spare: 5 };
    inv.weapons.smg = { mag: 30, spare: 30 };
    expect(bestGun(inv, 60, 8, 40)).toBe('sniper');
    expect(bestGun(inv, 20, 8, 40)).toBe('smg');
    expect(bestGun(inv, 60)).toBe('smg'); // no threshold given: never the sniper
    delete inv.weapons.smg;
    inv.weapons.pistol = { mag: 12, spare: 0 };
    expect(bestGun(inv, 15, 8, 40)).toBe('pistol');
  });
});

describe('sniper rifle: replay', () => {
  test('scope, shoot, reload: recorded, encoded, decoded and replayed to the identical state', async () => {
    const setup = { players: [{ name: 'You', isBot: false }, { name: 'Bot', isBot: true, difficulty: 'easy' as const }], seed: 11 };
    const m = await Match.create(setup);
    const rec = new Recorder(m, { setup, kind: 'test', localId: 1, recordedAt: 0, id: 'sniper-rt' });
    let snap: Snapshot = rec.tick(new Map());
    // (Buying it at the shop is the e2e's job: here it is handed over as a recorded op.)
    const inv = { weapons: { sniper: { mag: 5, spare: 10 } } };
    m.debugGive(1, inv);
    rec.op({ k: 'give', id: 1, inv });
    let shots = 0;
    for (let t = 2; t <= 300; t++) {
      const me = snap.players.find((p) => p.id === 1)!;
      const input: PlayerInput = { ...NO_INPUT, yaw: me.yaw + 0.01, pitch: -0.05 };
      if (t > 10) { input.slot = 'sniper'; input.ads = true; }
      if (t > 40) input.fire = true;
      snap = rec.tick(new Map([[1, input]]));
      shots += snap.events.filter((e) => e.type === 'shot' && e.data.weapon === 'sniper').length;
    }
    expect(snap.players.find((p) => p.id === 1)!.equipped).toBe('sniper');
    expect(shots).toBeGreaterThanOrEqual(5);
    const final = snap;
    const { bytes } = await rec.finish();
    m.dispose();
    const replay = await decodeReplay(bytes);
    const runner = await ReplayRunner.create(replay, { checkpointEvery: 0 });
    let last: Snapshot | null = null;
    for (let s = runner.step(); s; s = runner.step()) last = s;
    expect(runner.divergedAt).toBeNull();
    expect(last).toEqual(final);
    runner.dispose();
  }, 120_000);
});

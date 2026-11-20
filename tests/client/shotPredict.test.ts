import { describe, expect, test } from 'vitest';
import { firePeriodMs, PREDICT_EXPIRE_MS, ShotPredictor } from '../../src/client/shotPredict';
import { newPlayer } from '../../src/sim/player';
import type { MatchEvent, PlayerState, WeaponKind } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

function me(weapon: WeaponKind, mag: number, patch: Partial<PlayerState> = {}): PlayerState {
  const p = newPlayer(1, 'me', false, 0, v3());
  p.equipped = weapon;
  if (weapon !== 'fists') p.inv.weapons[weapon] = { mag, spare: 50 };
  return Object.assign(p, patch);
}
const shot = (by: number): MatchEvent => ({ t: 0, type: 'shot', data: { by } });
const hit = (by: number, target = 2): MatchEvent => ({ t: 0, type: 'hit', data: { by, target, amount: 10 } });

describe('client shot prediction', () => {
  test('fire period follows the sim: 1/rps rounded up to whole 30 Hz ticks', () => {
    expect(firePeriodMs('smg')).toBeCloseTo(100, 6); // 11 rps → 3 ticks
    expect(firePeriodMs('rifle')).toBeCloseTo(166.667, 2); // 6 rps → 5 ticks
    expect(firePeriodMs('pistol')).toBeCloseTo(266.667, 2); // 4 rps → 8 ticks
  });

  test('holding fire predicts at the gun rate, never past the rounds in the magazine', () => {
    const sp = new ShotPredictor();
    const p = me('smg', 3);
    const fired: number[] = [];
    for (let t = 0; t <= 1000; t += 16) if (sp.tryFire(p, t)) fired.push(t);
    expect(fired).toEqual([0, 112, 224]); // 3 rounds, ≥ 100 ms apart, then empty (unconfirmed shots count against the mag)
  });

  test('no prediction while dead, reloading, with fists or an empty gun', () => {
    const sp = new ShotPredictor();
    expect(sp.tryFire(undefined, 0)).toBeNull();
    expect(sp.tryFire(me('rifle', 5, { alive: false }), 0)).toBeNull();
    expect(sp.tryFire(me('rifle', 5, { reloadUntil: 3 }), 0)).toBeNull();
    expect(sp.tryFire(me('fists', 0), 0)).toBeNull();
    expect(sp.tryFire(me('rifle', 0), 0)).toBeNull();
    expect(sp.stats.predicted).toBe(0);
  });

  test('host shots echo predicted ones in order: flagged once, extra host shots play normally', () => {
    const sp = new ShotPredictor();
    sp.tryFire(me('rifle', 10), 0);
    sp.tryFire(me('rifle', 10), 200);
    const evs = [shot(1), shot(2), shot(1), shot(1)];
    sp.reconcile(evs, 1, 300);
    expect(evs.map((e) => !!e.data.echo)).toEqual([true, false, true, false]);
    expect(sp.stats).toMatchObject({ predicted: 2, confirmed: 2, unpredicted: 1 });
    expect(sp.inFlight).toBe(0);
  });

  test('a predicted hitmarker suppresses the host hitmarker for that shot only', () => {
    const sp = new ShotPredictor();
    sp.tryFire(me('rifle', 10), 0);
    sp.markHit();
    sp.tryFire(me('rifle', 10), 200);
    const evs = [shot(1), hit(1), shot(1), hit(1), hit(3, 1)];
    sp.reconcile(evs, 1, 300);
    expect(evs.map((e) => !!e.data.echo)).toEqual([true, true, true, false, false]);
  });

  test('predictions the host never confirms expire (no echo for a much later shot)', () => {
    const sp = new ShotPredictor();
    sp.tryFire(me('rifle', 10), 0);
    const evs = [shot(1)];
    sp.reconcile(evs, 1, PREDICT_EXPIRE_MS + 1);
    expect(evs[0].data.echo).toBeUndefined();
    expect(sp.stats.expired).toBe(1);
  });
});

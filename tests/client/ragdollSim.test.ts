import { beforeEach, describe, expect, test } from 'vitest';
import { deathKick, RAGDOLL, RAGDOLL_MAX, ragdollBudget, RagdollSim, RP, RP_COUNT } from '../../src/client/characters/ragdollSim';

// The rig's standing (Idle) joint positions (public/assets/characters/swat/swat.glb, model faces +Z), in metres.
const STAND: [number, number, number][] = [
  [0.01, 0.86, 0.06], [0, 1.47, 0.08], [0, 1.69, 0.09],
  [0.16, 1.4, 0.09], [0.22, 1.24, 0.03], [0.25, 1.01, 0.03],
  [-0.15, 1.4, 0.09], [-0.22, 1.24, 0.05], [-0.21, 1.02, 0.14],
  [0.12, 0.93, -0.01], [0.22, 0.51, 0.02], [0.12, 0.06, -0.11],
  [-0.1, 0.93, 0.1], [-0.07, 0.53, 0.27], [-0.07, 0.06, 0.25],
];
const FLOOR = 2; // an island top at y = 2
const points = () => STAND.flatMap(([x, y, z]) => [x + 5, y + FLOOR, z - 3]);
const run = (r: RagdollSim, s: number) => { for (let t = 0; t < s; t += 1 / 60) r.update(1 / 60); };
const p = (r: RagdollSim, i: number) => [r.pos[i * 3], r.pos[i * 3 + 1], r.pos[i * 3 + 2]];

beforeEach(() => ragdollBudget.reset());

describe('ragdoll sim', () => {
  test('a body with no push collapses onto the floor and goes to sleep', () => {
    const r = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    run(r, 6);
    expect(r.asleep).toBe(true);
    for (let i = 0; i < RP_COUNT; i++) expect(r.pos[i * 3 + 1]).toBeGreaterThanOrEqual(FLOOR + 0.04);
    expect(p(r, RP.pelvis)[1] - FLOOR).toBeLessThan(0.35); // down, not standing
    expect(p(r, RP.head)[1] - FLOOR).toBeLessThan(0.45);
  });

  test('segments keep their length (no stretching limbs)', () => {
    const r = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    const before = [[RP.shL, RP.elL], [RP.elL, RP.haL], [RP.hipR, RP.knR], [RP.knR, RP.anR], [RP.pelvis, RP.chest], [RP.chest, RP.head]].map(([a, b]) => [a, b, r.dist(a, b)]);
    r.kick(RP.chest, 0, 1, -4);
    run(r, 3);
    for (const [a, b, d] of before) expect(Math.abs(r.dist(a, b) - d) / d).toBeLessThan(0.04);
  });

  test('a push throws the body the way the shot went; an explosion throws it further and up', () => {
    const shot = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    const k = deathKick('shotgun', false);
    for (let i = 0; i < RP_COUNT; i++) shot.kick(i, 0, k.lift, -k.push * (i === RP.chest ? 1 : 0.6));
    const blast = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    const b = deathKick('rocket', true);
    for (let i = 0; i < RP_COUNT; i++) blast.kick(i, 0, b.lift, -b.push);
    let peak = 0;
    for (let t = 0; t < 4; t += 1 / 60) { shot.update(1 / 60); blast.update(1 / 60); peak = Math.max(peak, p(blast, RP.pelvis)[1]); }
    const dz = (r: RagdollSim) => p(r, RP.pelvis)[2] - (-3 + 0.06);
    expect(dz(shot)).toBeLessThan(-0.3); // fell backwards, away from the shooter in front
    expect(dz(blast)).toBeLessThan(dz(shot));
    expect(peak).toBeGreaterThan(FLOOR + 1.1); // lifted off the ground
    expect(Math.abs(dz(blast))).toBeLessThan(3); // but stays near where it died (culling sphere)
  });

  test('knees never bend backwards', () => {
    const r = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    r.kick(RP.chest, 0, 0, 2.5); // pitch forward onto the knees
    for (let t = 0; t < 4; t += 1 / 60) {
      r.update(1 / 60);
      const f = r.facing();
      for (const [h, k, a] of [[RP.hipL, RP.knL, RP.anL], [RP.hipR, RP.knR, RP.anR]]) {
        const H = p(r, h), K = p(r, k), A = p(r, a);
        const d = [0, 1, 2].reduce((s, c) => s + (K[c] - (H[c] + A[c]) / 2) * f[c], 0);
        expect(d).toBeGreaterThan(-0.03);
      }
    }
  });

  test('asleep means frozen; it sleeps within maxAge even if jittering', () => {
    const r = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    run(r, RAGDOLL.maxAge + 0.1);
    expect(r.asleep).toBe(true);
    const snap = Array.from(r.pos);
    expect(r.update(1)).toBe(false);
    expect(Array.from(r.pos)).toEqual(snap);
  });

  test('a long frame takes at most maxSteps steps', () => {
    const r = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    r.update(5);
    expect(r.age).toBeCloseTo(RAGDOLL.step * RAGDOLL.maxSteps, 5);
  });

  test('budget caps simultaneous simulations', () => {
    for (let i = 0; i < RAGDOLL_MAX; i++) expect(ragdollBudget.acquire()).toBe(true);
    expect(ragdollBudget.acquire()).toBe(false);
    ragdollBudget.release();
    expect(ragdollBudget.acquire()).toBe(true);
  });

  test('reports the landing as thuds: a hard one first, never two within thudGap', () => {
    const r = new RagdollSim(points(), { x: 0, z: 1 }, FLOOR);
    r.kick(RP.chest, 0, 0, -2);
    const thuds: { t: number; v: number }[] = [];
    for (let t = 0; t < 4; t += 1 / 60) { r.update(1 / 60); const v = r.takeImpact(); if (v) thuds.push({ t: r.age, v }); }
    expect(thuds.length).toBeGreaterThan(0);
    expect(thuds.length).toBeLessThan(8);
    expect(Math.max(...thuds.map((x) => x.v))).toBeGreaterThan(1.5); // the body slams down
    for (let i = 1; i < thuds.length; i++) expect(thuds[i].t - thuds[i - 1].t).toBeGreaterThanOrEqual(RAGDOLL.thudGap - 1e-6);
    for (const x of thuds) expect(x.v).toBeGreaterThanOrEqual(RAGDOLL.thudSpeed);
  });

  test('rejects a short point list', () => {
    expect(() => new RagdollSim([0, 0, 0], { x: 0, z: 1 }, 0)).toThrow(/ragdoll/);
  });
});

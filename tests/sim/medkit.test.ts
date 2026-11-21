import { describe, expect, test } from 'vitest';
import { MEDKIT, PLAYER } from '../../src/sim/constants';
import { buy, startMedkit, tickHealing, vaultTransfer } from '../../src/sim/economy';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type PlayerInput, type PlayerState } from '../../src/sim/types';
import { add, forward, scale, v3 } from '../../src/sim/vec';

const player = (cash = 0) => {
  const p = newPlayer(1, 'p', false, 0, v3());
  p.inv.cash = cash;
  return p;
};
/** A player holding `n` medkits in slot 0, selected, at `hp`. */
const hurt = (hp: number, n = 1) => {
  const p = player(MEDKIT.price * n);
  for (let i = 0; i < n; i++) expect(buy(p, { buy: 'medkit' }).ok).toBe(true);
  p.selected = p.hotbar.indexOf('medkit');
  p.hp = hp;
  return p;
};

describe('medkit', () => {
  test('costs $75 and goes into the hotbar', () => {
    expect(MEDKIT).toMatchObject({ price: 75, heal: 50, useSec: 2 });
    const p = player(100);
    expect(buy(p, { buy: 'medkit' }).ok).toBe(true);
    expect(p.inv.cash).toBe(25);
    expect(p.inv.medkits).toBe(1);
    expect(p.hotbar[0]).toBe('medkit');
    expect(buy(p, { buy: 'medkit' })).toEqual({ ok: false, reason: 'need $75, carrying $25' });
  });

  test('using one takes 2 s, then heals 50', () => {
    const p = hurt(30);
    expect(startMedkit(p, 10).ok).toBe(true);
    expect(p.inv.medkits).toBe(0);
    expect(p.hotbar[0]).toBeNull(); // last one used: slot frees
    expect(p.busyUntil).toBeCloseTo(12);
    expect(p.healAt).toBeCloseTo(12);
    tickHealing(p, 11.9);
    expect(p.hp).toBe(30);
    tickHealing(p, 12);
    expect(p.hp).toBe(80);
    expect(p.healAt).toBeNull();
  });

  test('healing caps at full HP', () => {
    const p = hurt(80);
    startMedkit(p, 0);
    tickHealing(p, 2);
    expect(p.hp).toBe(PLAYER.hp);
  });

  test('refused at full HP, when busy, when not selected, or with none', () => {
    const full = hurt(PLAYER.hp);
    expect(startMedkit(full, 0)).toEqual({ ok: false, reason: 'already at full health' });
    expect(full.inv.medkits).toBe(1);

    const busy = hurt(50, 2);
    expect(startMedkit(busy, 0).ok).toBe(true);
    expect(startMedkit(busy, 1).ok).toBe(false);
    expect(busy.inv.medkits).toBe(1);
    expect(busy.hotbar).toContain('medkit');

    const notHeld = hurt(50);
    notHeld.selected = 5;
    expect(startMedkit(notHeld, 0).ok).toBe(false);
    expect(notHeld.inv.medkits).toBe(1);

    const none = player();
    none.hp = 10;
    expect(startMedkit(none, 0).ok).toBe(false);
  });

  test('vault round-trip frees and refills the slot', () => {
    const p = hurt(50, 2);
    expect(vaultTransfer(p, { deposit: { medkits: 2 } }).ok).toBe(true);
    expect(p.inv.medkits).toBe(0);
    expect(p.vault.medkits).toBe(2);
    expect(p.hotbar).not.toContain('medkit');
    expect(vaultTransfer(p, { withdraw: { medkits: 1 } }).ok).toBe(true);
    expect(p.inv.medkits).toBe(1);
    expect(p.hotbar[0]).toBe('medkit');
    expect(vaultTransfer(p, { deposit: { medkits: 5 } })).toEqual({ ok: false, reason: 'not enough medkits' });
  });
});

describe('medkit in a match', () => {
  const inputs = (i: Partial<PlayerInput>) => new Map([[1, { ...NO_INPUT, ...i }]]);
  const humans1v1 = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };

  test('select + click heals after 2 s; Q drops one; death drops the rest', async () => {
    const m = await Match.create(humans1v1);
    m.debugTeleport(1, add(m.map[0].center, scale(forward(m.map[0].bunker.facingYaw), 6)));
    m.debugGive(1, { medkits: 3 });
    m.debugSetHp(1, 20);
    let snap = m.tick(inputs({ select: 0, useMedkit: true }));
    expect(snap.players[0].inv.medkits).toBe(2);
    expect(snap.players[0].healAt).not.toBeNull();
    for (let i = 0; i < 30; i++) snap = m.tick(inputs({ select: 0 }));
    expect(snap.players[0].hp).toBe(20);
    for (let i = 0; i < 31; i++) snap = m.tick(inputs({ select: 0 }));
    expect(snap.players[0].hp).toBe(70);

    snap = m.tick(inputs({ select: 0, drop: 'one' }));
    expect(snap.players[0].inv.medkits).toBe(1);
    expect(snap.loot.find((b) => b.inv.medkits === 1)).toBeDefined();

    m.debugKill(1);
    snap = m.tick(new Map());
    expect(snap.players[0].inv.medkits).toBe(0);
    expect(snap.players[0].healAt).toBeNull();
    expect(snap.loot.some((b) => b.inv.medkits === 1 && !b.noPickup)).toBe(true);
  });

  test('a click with the medkit not selected does nothing', async () => {
    const m = await Match.create(humans1v1);
    m.debugGive(1, { medkits: 1, grenades: 1 });
    m.debugSetHp(1, 20);
    let snap = m.tick(inputs({ select: 0, useMedkit: true }));
    expect(snap.players[0].hotbar.slice(0, 2)).toEqual(['grenade', 'medkit']);
    expect(snap.players[0].inv.medkits).toBe(1);
    expect(snap.players[0].inv.grenades).toBe(1);
    snap = m.tick(inputs({ select: 1, useMedkit: true }));
    expect(snap.players[0].inv.medkits).toBe(0);
  });
});

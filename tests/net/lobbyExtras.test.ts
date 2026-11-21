import { describe, expect, test } from 'vitest';
import { Lobby, seatColors } from '../../src/net/lobby';
import { sanitizeClientMsg, sanitizeSettings } from '../../src/net/sanitize';
import { DEFAULT_SETTINGS } from '../../src/sim/settings';

const lobbyOf3 = () => {
  const l = new Lobby('Host', 'h');
  l.addHuman('Bob', 'b');
  l.addHuman('Cat', 'c');
  return l;
};

describe('lobby ready state', () => {
  test('guests toggle ready; host and unknown peers cannot; bots always ready', () => {
    const l = lobbyOf3();
    l.addSeat();
    l.setSeat(3, { kind: 'bot', difficulty: 'hard' });
    expect(l.notReady()).toBe(2);
    expect(l.setReady('b', true)).toBe(true);
    expect(l.notReady()).toBe(1);
    expect(l.slots()[1]).toMatchObject({ ready: true });
    expect(l.setReady('h', true)).toBe(false);
    expect(l.setReady('nobody', true)).toBe(false);
    l.setReady('b', false);
    expect(l.slots()[1]).not.toHaveProperty('ready');
    l.setReady('b', true); l.setReady('c', true);
    expect(l.notReady()).toBe(0);
    l.resetReady();
    expect(l.notReady()).toBe(2);
  });
});

describe('lobby colours', () => {
  test('a picked colour is unique per lobby', () => {
    const l = lobbyOf3();
    expect(l.setColor(1, 4)).toBe(true);
    expect(l.setColor(2, 4)).toBe(false); // Bob has it
    expect(l.setColor(0, 4)).toBe(false);
    expect(l.setColor(2, 5)).toBe(true);
    expect(l.setColor(1, 5)).toBe(false);
    expect(l.setColor(1, 8)).toBe(false);
    expect(l.setColor(1, -1)).toBe(false);
    expect(l.setColor(1, 1.5)).toBe(false);
    expect(l.setColor(1, 2)).toBe(true); // switching frees 4
    expect(l.setColor(0, 4)).toBe(true);
  });

  test('bots and non-pickers fill the free colours; the setup carries the picks', () => {
    const l = lobbyOf3();
    l.addSeat();
    l.setSeat(3, { kind: 'bot', difficulty: 'easy' });
    expect(seatColors(l.slots())).toEqual([0, 1, 2, 3]); // nobody picked: today's colours
    l.setColor(1, 0);
    expect(seatColors(l.slots())).toEqual([1, 0, 2, 3]);
    const setup = l.toMatchSetup();
    expect(setup.players.map((p) => p.color)).toEqual([undefined, 0, undefined, undefined]);
    expect(new Set(seatColors(l.slots())).size).toBe(4);
  });

  test('a spectating host has no colour', () => {
    const l = lobbyOf3();
    l.setHostSpectator(true);
    expect(seatColors(l.slots())).toEqual([null, 0, 1]);
  });

  test('a seat that leaves frees its colour', () => {
    const l = lobbyOf3();
    l.setColor(1, 6);
    l.removePeer('b');
    expect(l.setColor(2, 6)).toBe(true);
  });
});

describe('sanitize: lobby messages and settings', () => {
  test('ready / color messages', () => {
    expect(sanitizeClientMsg({ t: 'ready', ready: true })).toEqual({ t: 'ready', ready: true });
    expect(sanitizeClientMsg({ t: 'ready', ready: 'yes' })).toBeNull();
    expect(sanitizeClientMsg({ t: 'color', color: 3 })).toEqual({ t: 'color', color: 3 });
    for (const color of [8, -1, 2.5, '3', null, NaN]) expect(sanitizeClientMsg({ t: 'color', color })).toBeNull();
  });

  test('settings are clamped, junk falls back to defaults', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ startCash: -10, suddenDeathSec: 99999, genMult: 0.1 })).toEqual({ startCash: 0, suddenDeathSec: 1500, genMult: 0.5 });
    expect(sanitizeSettings({ startCash: '500' })).toEqual(DEFAULT_SETTINGS);
  });
});

import { describe, expect, test } from 'vitest';
import { MAX_CMDS_PER_MSG, sanitizeClientMsg, sanitizeInput } from '../../src/net/sanitize';
import { NO_INPUT } from '../../src/sim/types';

describe('sanitizeInput', () => {
  test('passes a normal input through', () => {
    const i = { ...NO_INPUT, moveZ: 1, yaw: 0.5, fire: true };
    expect(sanitizeInput(i)).toEqual(i);
  });
  test('clamps movement and drops non-finite angles', () => {
    const r = sanitizeInput({ ...NO_INPUT, moveX: 50, moveZ: -9, yaw: NaN, pitch: Infinity })!;
    expect(r.moveX).toBe(1);
    expect(r.moveZ).toBe(-1);
    expect(r.yaw).toBe(0);
    expect(r.pitch).toBe(0);
  });
  test('rejects bad enums and junk', () => {
    expect(sanitizeInput(null)).toBeNull();
    expect(sanitizeInput('hi')).toBeNull();
    const r = sanitizeInput({ ...NO_INPUT, slot: 'bazooka', shop: { buy: 'tank' }, build: { kind: 'castle', pos: { x: 0, y: 0, z: 0 }, rotY: 0, free: false } })!;
    expect(r.slot).toBeNull();
    expect(r.shop).toBeNull();
    expect(r.build).toBeNull();
  });
  test('build with non-finite position is dropped', () => {
    const r = sanitizeInput({ ...NO_INPUT, build: { kind: 'steel', pos: { x: NaN, y: 0, z: 0 }, rotY: 0, free: false } })!;
    expect(r.build).toBeNull();
  });
  test('vault amounts must be non-negative finite numbers', () => {
    const r = sanitizeInput({ ...NO_INPUT, vault: { deposit: { cash: -5 } } })!;
    expect(r.vault).toBeNull();
    const ok = sanitizeInput({ ...NO_INPUT, vault: { withdraw: { cash: 20, pieces: { steel: 1 } } } })!;
    expect(ok.vault).toEqual({ withdraw: { cash: 20, pieces: { steel: 1 } } });
  });
  test('hotbar select must be a slot index 0-8', () => {
    expect(sanitizeInput({ ...NO_INPUT, select: 4 })!.select).toBe(4);
    expect(sanitizeInput({ ...NO_INPUT, select: 0 })!.select).toBe(0);
    for (const bad of [9, -1, 2.5, NaN, Infinity, '3', null, {}, [1]])
      expect(sanitizeInput({ ...NO_INPUT, select: bad })!.select).toBeNull();
  });
  test('drop is one, stack, or nothing', () => {
    expect(sanitizeInput({ ...NO_INPUT, drop: 'one' })!.drop).toBe('one');
    expect(sanitizeInput({ ...NO_INPUT, drop: 'stack' })!.drop).toBe('stack');
    for (const bad of ['all', true, 1, {}, null]) expect(sanitizeInput({ ...NO_INPUT, drop: bad })!.drop).toBeNull();
  });
  test('moveSlot needs two in-range slot indices', () => {
    expect(sanitizeInput({ ...NO_INPUT, moveSlot: { from: 0, to: 8 } })!.moveSlot).toEqual({ from: 0, to: 8 });
    for (const bad of [{ from: 0, to: 9 }, { from: -1, to: 2 }, { from: 1.5, to: 2 }, { from: '1', to: 2 }, { from: 1 }, [0, 1], 'x', 7])
      expect(sanitizeInput({ ...NO_INPUT, moveSlot: bad })!.moveSlot).toBeNull();
    const extra = sanitizeInput({ ...NO_INPUT, moveSlot: { from: 2, to: 3, evil: 'x' } })!.moveSlot;
    expect(extra).toEqual({ from: 2, to: 3 });
  });
  test('useMedkit is a strict boolean; vault medkits must be counts', () => {
    expect(sanitizeInput({ ...NO_INPUT, useMedkit: true })!.useMedkit).toBe(true);
    for (const bad of ['yes', 1, {}, null, undefined]) expect(sanitizeInput({ ...NO_INPUT, useMedkit: bad })!.useMedkit).toBe(false);
    expect(sanitizeInput({ ...NO_INPUT, vault: { deposit: { medkits: 2 } } })!.vault).toEqual({ deposit: { medkits: 2 } });
    expect(sanitizeInput({ ...NO_INPUT, vault: { deposit: { medkits: -1 } } })!.vault).toBeNull();
    expect(sanitizeInput({ ...NO_INPUT, vault: { withdraw: { medkits: 'lots' } } })!.vault).toBeNull();
    expect(sanitizeInput({ ...NO_INPUT, shop: { buy: 'medkit' } })!.shop).toEqual({ buy: 'medkit' });
  });
  test('shop accepts generator upgrades and gun locks only in their exact forms', () => {
    expect(sanitizeInput({ ...NO_INPUT, shop: { buy: 'genUpgrade' } })!.shop).toEqual({ buy: 'genUpgrade' });
    for (const g of ['pistol', 'smg', 'shotgun', 'rifle'])
      expect(sanitizeInput({ ...NO_INPUT, shop: { buy: `lock:${g}` } })!.shop).toEqual({ buy: `lock:${g}` });
    for (const bad of ['lock:fists', 'lock:', 'lock:tank', 'lock:pistol ', 'LOCK:pistol', 'genUpgrade2', { lock: 'pistol' }, 'lock:__proto__'])
      expect(sanitizeInput({ ...NO_INPUT, shop: { buy: bad } })!.shop).toBeNull();
  });
  test('drink is a strict boolean; potions are shop items and vault counts', () => {
    expect(sanitizeInput({ ...NO_INPUT, drink: true })!.drink).toBe(true);
    for (const bad of ['yes', 1, {}, null, undefined]) expect(sanitizeInput({ ...NO_INPUT, drink: bad })!.drink).toBe(false);
    for (const k of ['shieldSmall', 'shieldBig', 'healPotion', 'speedPotion'])
      expect(sanitizeInput({ ...NO_INPUT, shop: { buy: k } })!.shop).toEqual({ buy: k });
    expect(sanitizeInput({ ...NO_INPUT, shop: { buy: 'shieldHuge' } })!.shop).toBeNull();
    expect(sanitizeInput({ ...NO_INPUT, vault: { deposit: { potions: { shieldBig: 2 } } } })!.vault).toEqual({ deposit: { potions: { shieldBig: 2 } } });
    expect(sanitizeInput({ ...NO_INPUT, vault: { deposit: { potions: { shieldBig: -1 } } } })!.vault).toBeNull();
    expect(sanitizeInput({ ...NO_INPUT, vault: { deposit: { potions: { nectar: 1 } } } })!.vault).toBeNull();
    expect(sanitizeInput({ ...NO_INPUT, vault: { withdraw: { potions: 'all' } } })!.vault).toBeNull();
  });
  test('booleans are coerced strictly', () => {
    expect(sanitizeInput({ ...NO_INPUT, fire: 'yes' })!.fire).toBe(false);
  });
});

describe('sanitizeClientMsg', () => {
  test('hello needs a name and version', () => {
    expect(sanitizeClientMsg({ t: 'hello', name: '  Ish  ', version: 1 })).toEqual({ t: 'hello', name: 'Ish', version: 1 });
    expect(sanitizeClientMsg({ t: 'hello', name: 'x'.repeat(100), version: 1 })).toEqual({ t: 'hello', name: 'x'.repeat(16), version: 1 });
    expect(sanitizeClientMsg({ t: 'hello', version: 1 })).toBeNull();
  });
  test('chat text must be a string, length capped later by chat cleaning', () => {
    expect(sanitizeClientMsg({ t: 'chat', text: 'gg' })).toEqual({ t: 'chat', text: 'gg' });
    expect(sanitizeClientMsg({ t: 'chat', text: 5 })).toBeNull();
    expect(sanitizeClientMsg({ t: 'chat', text: 'x'.repeat(10_000) })).toBeNull();
  });
  test('preview needs a valid build request and integer key', () => {
    const req = { kind: 'wood', pos: { x: 1, y: 2, z: 3 }, rotY: 0, free: true };
    expect(sanitizeClientMsg({ t: 'preview', req, key: 3 })).toEqual({ t: 'preview', req, key: 3 });
    expect(sanitizeClientMsg({ t: 'preview', req: { ...req, kind: 'x' }, key: 3 })).toBeNull();
  });
  test('input carries numbered movement commands, sanitized', () => {
    const cmd = { seq: 5, moveX: 3, moveZ: -1, yaw: 0.25, jump: 1, sprint: true, extra: 'x' };
    const r = sanitizeClientMsg({ t: 'input', input: NO_INPUT, cmds: [cmd] });
    expect(r).toEqual({ t: 'input', input: NO_INPUT, cmds: [{ seq: 5, moveX: 1, moveZ: -1, yaw: 0.25, jump: false, sprint: true }] });
    // Missing cmds (older shape) → empty list; bad seq / yaw / too many → whole message dropped.
    expect(sanitizeClientMsg({ t: 'input', input: NO_INPUT })).toEqual({ t: 'input', input: NO_INPUT, cmds: [] });
    expect(sanitizeClientMsg({ t: 'input', input: NO_INPUT, cmds: [{ ...cmd, seq: 1.5 }] })).toBeNull();
    expect(sanitizeClientMsg({ t: 'input', input: NO_INPUT, cmds: [{ ...cmd, seq: 0 }] })).toBeNull();
    expect(sanitizeClientMsg({ t: 'input', input: NO_INPUT, cmds: [{ ...cmd, yaw: NaN }] })).toBeNull();
    expect(sanitizeClientMsg({ t: 'input', input: NO_INPUT, cmds: Array(MAX_CMDS_PER_MSG + 1).fill(cmd) })).toBeNull();
    expect(sanitizeClientMsg({ t: 'input', input: NO_INPUT, cmds: 'lots' })).toBeNull();
  });
  test('unknown types are dropped', () => {
    expect(sanitizeClientMsg({ t: 'admin', cmd: 'win' })).toBeNull();
  });
});

describe('lag compensation and ack fields', () => {
  test('viewT survives only as a finite number', () => {
    expect(sanitizeInput({ viewT: 12.5 })!.viewT).toBe(12.5);
    expect('viewT' in sanitizeInput({ viewT: NaN })!).toBe(false);
    expect('viewT' in sanitizeInput({ viewT: '1' })!).toBe(false);
  });
  test('snapshot acks are positive integers or dropped', () => {
    expect(sanitizeClientMsg({ t: 'input', input: {}, cmds: [], ack: 42 })).toMatchObject({ ack: 42 });
    expect(sanitizeClientMsg({ t: 'input', input: {}, cmds: [], ack: -1 })).not.toHaveProperty('ack');
    expect(sanitizeClientMsg({ t: 'input', input: {}, cmds: [], ack: 1.5 })).not.toHaveProperty('ack');
  });
});

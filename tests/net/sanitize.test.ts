import { describe, expect, test } from 'vitest';
import { sanitizeClientMsg, sanitizeInput } from '../../src/net/sanitize';
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
  test('unknown types are dropped', () => {
    expect(sanitizeClientMsg({ t: 'admin', cmd: 'win' })).toBeNull();
  });
});

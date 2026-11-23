import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTION_IDS, bindingLabel, conflictsFor, defaultKeymap, findConflicts, isAction, isHeld, keyLabel, rebind, resetAction,
  sanitizeKeymap, setActiveKeymap, setKeymapSuspended, slotForCode, unbind,
} from '../../src/client/keymap';

afterEach(() => { setActiveKeymap(defaultKeymap()); setKeymapSuspended(false); });

describe('keymap defaults', () => {
  it('binds every action, with the hotbar and the usual keys', () => {
    const km = defaultKeymap();
    for (const id of ACTION_IDS) expect(km[id].length, id).toBeGreaterThan(0);
    expect(km.forward).toEqual(['KeyW']);
    expect(km.jump).toEqual(['Space']);
    expect(km.sprint).toEqual(['ShiftLeft', 'ShiftRight']);
    expect(km.drop).toEqual(['KeyQ']);
    expect(km.rotateLeft).toEqual(['KeyZ']);
    expect(km.rotateRight).toEqual(['KeyX']);
    expect(km.inventory).toEqual(['KeyI']);
    expect(km.scoreboard).toEqual(['Tab']);
    for (let i = 1; i <= 9; i++) expect(km[`slot${i}` as 'slot1']).toEqual([`Digit${i}`]);
  });

  it('has no conflicts', () => {
    expect(findConflicts(defaultKeymap())).toEqual([]);
  });

  it('returns a fresh copy each time', () => {
    const a = defaultKeymap();
    a.jump.push('KeyJ');
    expect(defaultKeymap().jump).toEqual(['Space']);
  });
});

describe('rebind / conflicts', () => {
  it('rebinds one action without touching others', () => {
    const km = rebind(defaultKeymap(), 'jump', 'KeyJ');
    expect(km.jump).toEqual(['KeyJ']);
    expect(km.forward).toEqual(['KeyW']);
    expect(defaultKeymap().jump).toEqual(['Space']);
  });

  it('detects a conflict and names both actions', () => {
    const km = rebind(defaultKeymap(), 'jump', 'KeyW');
    expect(findConflicts(km)).toEqual([{ code: 'KeyW', actions: ['forward', 'jump'] }]);
    expect(conflictsFor(km, 'jump', 'KeyW')).toEqual(['forward']);
    expect(conflictsFor(defaultKeymap(), 'jump', 'KeyJ')).toEqual([]);
  });

  it('refuses reserved / junk codes', () => {
    expect(() => rebind(defaultKeymap(), 'jump', 'Escape')).toThrow(/cannot be bound/);
    expect(() => rebind(defaultKeymap(), 'jump', '')).toThrow();
    expect(() => rebind(defaultKeymap(), 'nope' as 'jump', 'KeyJ')).toThrow(/unknown action/);
  });

  it('unbinds and resets', () => {
    let km = unbind(defaultKeymap(), 'mute');
    expect(km.mute).toEqual([]);
    expect(bindingLabel(km, 'mute')).toBe('—');
    km = resetAction(km, 'mute');
    expect(km.mute).toEqual(['KeyM']);
  });
});

describe('sanitize (persistence)', () => {
  it('fills missing actions and drops junk', () => {
    const km = sanitizeKeymap({ jump: ['KeyJ'], forward: 'KeyW', bogus: ['KeyB'], reload: [42, 'Escape', 'KeyT', 'KeyT', 'KeyY', 'KeyU'] });
    expect(km.jump).toEqual(['KeyJ']);
    expect(km.forward).toEqual(['KeyW']); // not an array → default
    expect(km.reload).toEqual(['KeyT', 'KeyY']); // deduped, reserved/non-string dropped, max 2
    expect((km as Record<string, unknown>).bogus).toBeUndefined();
    expect(sanitizeKeymap(null)).toEqual(defaultKeymap());
    expect(sanitizeKeymap('garbage')).toEqual(defaultKeymap());
  });

  it('round-trips through JSON', () => {
    const km = rebind(defaultKeymap(), 'camera', 'KeyC');
    expect(sanitizeKeymap(JSON.parse(JSON.stringify(km)))).toEqual(km);
  });
});

describe('live queries', () => {
  it('match the active map and stop while suspended', () => {
    expect(isAction('jump', 'Space')).toBe(true);
    setActiveKeymap(rebind(defaultKeymap(), 'jump', 'KeyJ'));
    expect(isAction('jump', 'Space')).toBe(false);
    expect(isAction('jump', 'KeyJ')).toBe(true);
    expect(isHeld('sprint', new Set(['ShiftRight']))).toBe(true);
    expect(slotForCode('Digit3')).toBe(2);
    expect(slotForCode('KeyJ')).toBe(-1);
    setKeymapSuspended(true);
    expect(isAction('jump', 'KeyJ')).toBe(false);
    expect(isHeld('sprint', new Set(['ShiftRight']))).toBe(false);
    expect(slotForCode('Digit3')).toBe(-1);
  });

  it('labels keys', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Numpad4')).toBe('Num 4');
    expect(bindingLabel(defaultKeymap(), 'sprint')).toBe('Shift');
    expect(bindingLabel(defaultKeymap(), 'chat')).toBe('Enter / Num Enter');
  });
});

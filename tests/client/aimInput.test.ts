import { afterEach, describe, expect, it } from 'vitest';
import { AimLatch, type AimMode, effectiveButton, isMacPlatform } from '../../src/client/aimInput';
import { defaultKeymap, isAction, isHeld, sanitizeKeymap, setActiveKeymap } from '../../src/client/keymap';
import { sanitizeSettings } from '../../src/client/settings/store';

afterEach(() => setActiveKeymap(defaultKeymap()));

describe('Ctrl aims', () => {
  it('either Ctrl key held = aim, as well as right mouse', () => {
    expect(isHeld('aim', new Set(['ControlLeft']))).toBe(true);
    expect(isHeld('aim', new Set(['ControlRight']))).toBe(true);
    expect(isHeld('aim', new Set(['Mouse2']))).toBe(true);
    expect(isHeld('aim', new Set(['KeyW']))).toBe(false);
    expect(isAction('aim', 'ControlLeft')).toBe(true);
  });

  it('old saved maps (aim = right mouse only) gain Ctrl, unless Ctrl is bound elsewhere', () => {
    expect(sanitizeKeymap({ aim: ['Mouse2'] }).aim).toEqual(['Mouse2', 'ControlLeft', 'ControlRight']);
    expect(sanitizeKeymap({ aim: ['Mouse2'], drop: ['ControlLeft'] }).aim).toEqual(['Mouse2']);
    expect(sanitizeKeymap({ aim: ['KeyF'] }).aim).toEqual(['KeyF']);
  });
});

describe('Mac Ctrl+click while aiming with Ctrl', () => {
  it('a button-2 press with ctrlKey on a Mac while Ctrl is held is a left click (fire), not aim', () => {
    expect(effectiveButton(2, true, true, true)).toBe(0);
  });
  it('a real right click still aims: no Ctrl held, not a Mac, or no ctrlKey', () => {
    expect(effectiveButton(2, false, false, true)).toBe(2);
    expect(effectiveButton(2, true, true, false)).toBe(2); // Windows/Linux: Ctrl+right click stays a right click
    expect(effectiveButton(2, false, true, true)).toBe(2);
    expect(effectiveButton(2, true, false, true)).toBe(2); // Ctrl not held as an aim key
  });
  it('left clicks are untouched', () => {
    expect(effectiveButton(0, true, true, true)).toBe(0);
    expect(effectiveButton(0, false, false, false)).toBe(0);
  });
  it('detects macOS', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });
});

describe('aim mode', () => {
  it('hold: aiming only while held', () => {
    const a = new AimLatch(() => 'hold');
    a.press();
    expect(a.active(true)).toBe(true);
    expect(a.active(false)).toBe(false);
  });
  it('toggle: each press flips it, held state ignored; reset ends it', () => {
    let mode: AimMode = 'toggle';
    const a = new AimLatch(() => mode);
    expect(a.active(true)).toBe(false);
    a.press();
    expect(a.active(false)).toBe(true);
    a.press();
    expect(a.active(true)).toBe(false);
    a.press();
    a.reset();
    expect(a.active(false)).toBe(false);
    mode = 'hold';
    expect(a.active(true)).toBe(true);
  });
  it('setting defaults to hold and rejects junk', () => {
    expect(sanitizeSettings({}).controls.aimMode).toBe('hold');
    expect(sanitizeSettings({ controls: { aimMode: 'toggle' } }).controls.aimMode).toBe('toggle');
    expect(sanitizeSettings({ controls: { aimMode: 'x' } }).controls.aimMode).toBe('hold');
  });
});

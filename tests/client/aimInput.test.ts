import { afterEach, describe, expect, it } from 'vitest';
import { AimLatch, type AimMode, ctrlAimDefault, effectiveButton, isMacPlatform, platformNav } from '../../src/client/aimInput';
import { defaultKeymap, setActiveKeymap } from '../../src/client/keymap';
import { sanitizeSettings } from '../../src/client/settings/store';

afterEach(() => setActiveKeymap(defaultKeymap()));

describe('Ctrl aims: on by default on macOS only', () => {
  it('per OS', () => {
    expect(ctrlAimDefault({ userAgentData: { platform: 'macOS' } })).toBe(true);
    expect(ctrlAimDefault({ platform: 'MacIntel' })).toBe(true);
    expect(ctrlAimDefault({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true);
    expect(ctrlAimDefault({ userAgentData: { platform: 'Windows' }, platform: 'Win32' })).toBe(false);
    expect(ctrlAimDefault({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false);
    expect(ctrlAimDefault({ userAgentData: { platform: 'Chrome OS' } })).toBe(false);
    expect(ctrlAimDefault(undefined)).toBe(false);
  });
  it('the setting keeps a stored choice and rejects junk', () => {
    expect(sanitizeSettings({ controls: { ctrlAim: true } }).controls.ctrlAim).toBe(true);
    expect(sanitizeSettings({ controls: { ctrlAim: false } }).controls.ctrlAim).toBe(false);
    expect(sanitizeSettings({ controls: { ctrlAim: 'yes' } }).controls.ctrlAim).toBe(ctrlAimDefault(platformNav())); // default for this platform
  });
  it('right mouse stays the aim key in the keymap (Ctrl is the setting, not a binding)', () => {
    expect(defaultKeymap().aim).toEqual(['Mouse2']);
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
    expect(effectiveButton(2, true, false, true)).toBe(2); // Ctrl not aiming (setting off)
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

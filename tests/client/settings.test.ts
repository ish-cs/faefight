import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeKeymap, defaultKeymap, isAction, rebind, setActiveKeymap } from '../../src/client/keymap';
import {
  defaultSettings, LEGACY_KEYS, loadSettings, sanitizeSettings, saveSettings, SETTINGS_KEY, SettingsStore,
} from '../../src/client/settings/store';

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

afterEach(() => setActiveKeymap(defaultKeymap()));

describe('settings load / save', () => {
  it('defaults when nothing is stored, and writes the versioned key', () => {
    const s = mem();
    expect(loadSettings(s)).toEqual(defaultSettings());
    expect(JSON.parse(s.m.get(SETTINGS_KEY)!)).toEqual(defaultSettings());
    expect(loadSettings(null)).toEqual(defaultSettings());
  });

  it('migrates the old scattered keys once', () => {
    const s = mem({
      [LEGACY_KEYS.sensitivity]: '1.75', [LEGACY_KEYS.quality]: 'low', [LEGACY_KEYS.volume]: '0.3',
      [LEGACY_KEYS.muted]: '1', [LEGACY_KEYS.cameraMode]: 'first',
    });
    const got = loadSettings(s);
    expect(got.controls.sensitivity).toBe(1.75);
    expect(got.video.quality).toBe('low');
    expect(got.audio.master).toBe(0.3);
    expect(got.audio.muted).toBe(true);
    expect(got.gameplay.cameraMode).toBe('first');
    expect(JSON.parse(s.m.get(SETTINGS_KEY)!).controls.sensitivity).toBe(1.75);
    // The versioned key wins from now on.
    s.m.set(LEGACY_KEYS.sensitivity, '0.5');
    expect(loadSettings(s).controls.sensitivity).toBe(1.75);
  });

  it('ignores junk legacy values', () => {
    const got = loadSettings(mem({ [LEGACY_KEYS.sensitivity]: 'abc', [LEGACY_KEYS.quality]: 'ultra-mega', [LEGACY_KEYS.volume]: '7' }));
    expect(got.controls.sensitivity).toBe(1);
    expect(got.video.quality).toBe('high');
    expect(got.audio.master).toBe(1); // clamped
  });

  it('survives corrupt JSON and blocked storage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadSettings(mem({ [SETTINGS_KEY]: '{oops' }))).toEqual(defaultSettings());
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadSettings(boom)).toEqual(defaultSettings());
    expect(() => saveSettings(defaultSettings(), boom)).not.toThrow();
    warn.mockRestore();
  });

  it('sanitizes ranges and enums', () => {
    const s = sanitizeSettings({
      controls: { sensitivity: 99, invertY: 'yes' },
      video: { quality: 'potato', fovThird: 10, fovFirst: 200, resolutionScale: 0.1, frameCap: 45, showFps: false },
      audio: { master: -1, effects: 0.5, ambience: '0.25' },
      gameplay: { crosshair: 'dot', crosshairColor: 'red', damageNumbers: false },
    });
    expect(s.controls.sensitivity).toBe(3);
    expect(s.controls.invertY).toBe(false);
    expect(s.video).toMatchObject({ quality: 'high', fovThird: 55, fovFirst: 110, resolutionScale: 0.5, frameCap: 0, showFps: false });
    expect(s.audio).toMatchObject({ master: 0, effects: 0.5, ambience: 0.25 });
    // Older saves without the music/interface buses get the modest defaults; bad values clamp.
    expect(s.audio).toMatchObject({ music: 0.4, musicOn: true, ui: 0.8 });
    expect(sanitizeSettings({ audio: { music: 3, musicOn: 'no', ui: -2 } }).audio).toMatchObject({ music: 1, musicOn: true, ui: 0 });
    expect(sanitizeSettings({ audio: { musicOn: false } }).audio.musicOn).toBe(false);
    expect(s.gameplay).toMatchObject({ crosshair: 'dot', crosshairColor: '#ffffff', damageNumbers: false });
  });
});

describe('SettingsStore', () => {
  it('persists updates, notifies listeners, and drives the live keymap', () => {
    const s = mem();
    const store = new SettingsStore(s);
    const seen: number[] = [];
    store.subscribe((n) => seen.push(n.controls.sensitivity));
    store.update((d) => { d.controls.sensitivity = 2; });
    store.update((d) => { d.controls.sensitivity = 2; }); // no change → no notify
    expect(seen).toEqual([2]);
    expect(JSON.parse(s.m.get(SETTINGS_KEY)!).controls.sensitivity).toBe(2);

    store.update((d) => { d.controls.keys = rebind(d.controls.keys, 'jump', 'KeyJ'); });
    expect(activeKeymap().jump).toEqual(['KeyJ']);
    expect(isAction('jump', 'KeyJ')).toBe(true);
    // A fresh store (next page load) reads the rebinding back.
    new SettingsStore(s);
    expect(activeKeymap().jump).toEqual(['KeyJ']);
  });

  it('resets one section', () => {
    const store = new SettingsStore(mem());
    store.update((d) => { d.audio.master = 0.1; d.video.fovThird = 90; });
    store.reset('audio');
    expect(store.get().audio.master).toBe(defaultSettings().audio.master);
    expect(store.get().video.fovThird).toBe(90);
  });

  it('FPS counter is on by default and on F3', () => {
    expect(defaultSettings().video.showFps).toBe(true);
    expect(defaultKeymap().fps).toEqual(['F3', 'Backquote']); // ` too: F3 is Mission Control on a Mac
  });

  it('v1 settings migrate to v2 with the FPS counter on; a v2 choice to hide it sticks', () => {
    const v1 = { ...defaultSettings(), v: 1, video: { ...defaultSettings().video, showFps: false, quality: 'low' } };
    const s = mem({ [SETTINGS_KEY]: JSON.stringify(v1) });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const got = loadSettings(s);
    info.mockRestore();
    expect(got.v).toBe(2);
    expect(got.video.showFps).toBe(true);
    expect(got.video.quality).toBe('low'); // everything else kept
    expect(JSON.parse(s.m.get(SETTINGS_KEY)!).v).toBe(2); // migrated once, persisted

    const store = new SettingsStore(s);
    store.update((d) => { d.video.showFps = false; });
    expect(loadSettings(s).video.showFps).toBe(false);
  });

  it('a throwing listener does not block others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new SettingsStore(mem());
    let ok = false;
    store.subscribe(() => { throw new Error('bad'); });
    store.subscribe(() => { ok = true; });
    store.update((d) => { d.video.showFps = false; });
    expect(ok).toBe(true);
    err.mockRestore();
  });
});

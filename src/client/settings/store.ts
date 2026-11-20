import type { Quality } from '../world/sky';
import { type Keymap, sanitizeKeymap, setActiveKeymap } from '../keymap';

/**
 * Every user setting, persisted under one versioned localStorage key. On first run the old scattered
 * keys (sensitivity, quality, volume, muted, cameraMode) are migrated in. Listeners apply changes live.
 * No DOM / three.js here, so the menu can load it without the heavy game chunks.
 */

export const SETTINGS_KEY = 'faefight.settings.v1';
export const LEGACY_KEYS = {
  sensitivity: 'faefight.sensitivity',
  quality: 'faefight.quality',
  volume: 'faefight.volume',
  muted: 'faefight.muted',
  cameraMode: 'faefight.cameraMode',
} as const;

/** Exhaustive over the world's Quality type: adding a preset there fails typecheck until it's listed here. */
const QUALITY_SET: Record<Quality, true> = { low: true, high: true, ultra: true };
export const QUALITIES = Object.keys(QUALITY_SET) as Quality[];

export const CROSSHAIRS = ['cross', 'dot', 'circle', 'cross-dot'] as const;
export type Crosshair = (typeof CROSSHAIRS)[number];
export const CROSSHAIR_COLORS = ['#ffffff', '#3ddc84', '#ffd166', '#4dd2ff', '#ff5fd2', '#ff4d4d'] as const;
export const FRAME_CAPS = [0, 30, 60, 120] as const;
export type FrameCap = (typeof FRAME_CAPS)[number];
export type CameraMode = 'third' | 'first';

export type Settings = {
  v: 1;
  controls: { sensitivity: number; invertY: boolean; keys: Keymap };
  video: { quality: Quality; fovThird: number; fovFirst: number; showFps: boolean; resolutionScale: number; frameCap: FrameCap };
  audio: { master: number; effects: number; ambience: number; muted: boolean };
  gameplay: { crosshair: Crosshair; crosshairColor: string; damageNumbers: boolean; cameraMode: CameraMode };
};

export const LIMITS = {
  sensitivity: [0.2, 3],
  fovThird: [55, 100],
  fovFirst: [60, 110],
  resolutionScale: [0.5, 2],
} as const;

export function defaultSettings(): Settings {
  return {
    v: 1,
    controls: { sensitivity: 1, invertY: false, keys: sanitizeKeymap(null) },
    video: { quality: 'high', fovThird: 70, fovFirst: 75, showFps: true, resolutionScale: 1, frameCap: 0 },
    audio: { master: 0.8, effects: 1, ambience: 1, muted: false },
    gameplay: { crosshair: 'cross', crosshairColor: '#ffffff', damageNumbers: true, cameraMode: 'third' },
  };
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): KV | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
const oneOf = <T>(v: unknown, list: readonly T[], dflt: T): T => (list.includes(v as T) ? (v as T) : dflt);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const HEX = /^#[0-9a-f]{6}$/i;

/** Anything (parsed JSON, partial, wrong types) → a complete valid Settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = obj(raw), c = obj(r.controls), v = obj(r.video), a = obj(r.audio), g = obj(r.gameplay);
  return {
    v: 1,
    controls: {
      sensitivity: num(c.sensitivity, LIMITS.sensitivity[0], LIMITS.sensitivity[1], d.controls.sensitivity),
      invertY: bool(c.invertY, d.controls.invertY),
      keys: sanitizeKeymap(c.keys),
    },
    video: {
      quality: oneOf(v.quality, QUALITIES, d.video.quality),
      fovThird: Math.round(num(v.fovThird, LIMITS.fovThird[0], LIMITS.fovThird[1], d.video.fovThird)),
      fovFirst: Math.round(num(v.fovFirst, LIMITS.fovFirst[0], LIMITS.fovFirst[1], d.video.fovFirst)),
      showFps: bool(v.showFps, d.video.showFps),
      resolutionScale: num(v.resolutionScale, LIMITS.resolutionScale[0], LIMITS.resolutionScale[1], d.video.resolutionScale),
      frameCap: oneOf(v.frameCap, FRAME_CAPS, d.video.frameCap),
    },
    audio: {
      master: num(a.master, 0, 1, d.audio.master),
      effects: num(a.effects, 0, 1, d.audio.effects),
      ambience: num(a.ambience, 0, 1, d.audio.ambience),
      muted: bool(a.muted, d.audio.muted),
    },
    gameplay: {
      crosshair: oneOf(g.crosshair, CROSSHAIRS, d.gameplay.crosshair),
      crosshairColor: typeof g.crosshairColor === 'string' && HEX.test(g.crosshairColor) ? g.crosshairColor.toLowerCase() : d.gameplay.crosshairColor,
      damageNumbers: bool(g.damageNumbers, d.gameplay.damageNumbers),
      cameraMode: oneOf(g.cameraMode, ['third', 'first'] as const, d.gameplay.cameraMode),
    },
  };
}

/** Settings from the pre-v1 scattered keys (only the ones present override defaults). */
export function migrateLegacy(store: KV): Settings {
  const get = (k: string) => { try { return store.getItem(k); } catch { return null; } };
  const s = defaultSettings();
  const sens = get(LEGACY_KEYS.sensitivity), q = get(LEGACY_KEYS.quality), vol = get(LEGACY_KEYS.volume);
  const muted = get(LEGACY_KEYS.muted), cam = get(LEGACY_KEYS.cameraMode);
  if (sens !== null && Number(sens) > 0) s.controls.sensitivity = Number(sens);
  if (q !== null) s.video.quality = q as Quality;
  if (vol !== null) s.audio.master = Number(vol);
  if (muted !== null) s.audio.muted = muted === '1';
  if (cam !== null) s.gameplay.cameraMode = cam as CameraMode;
  return sanitizeSettings(s);
}

export function loadSettings(store: KV | null = defaultStore()): Settings {
  if (!store) return defaultSettings();
  let raw: string | null = null;
  try { raw = store.getItem(SETTINGS_KEY); } catch { return defaultSettings(); }
  if (raw === null) {
    const migrated = migrateLegacy(store);
    saveSettings(migrated, store);
    return migrated;
  }
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch (err) {
    console.warn('[settings] stored settings are corrupt; using defaults', err);
    return defaultSettings();
  }
}

export function saveSettings(s: Settings, store: KV | null = defaultStore()) {
  try { store?.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (err) { console.warn('[settings] could not persist settings', err); }
}

/** Live settings: get(), update(mutator) → sanitize, persist, notify. */
export class SettingsStore {
  private s: Settings;
  private listeners = new Set<(s: Settings, prev: Settings) => void>();

  constructor(private store: KV | null = defaultStore()) {
    this.s = loadSettings(store);
    setActiveKeymap(this.s.controls.keys);
  }

  get(): Settings { return this.s; }

  update(mutate: (draft: Settings) => void) {
    const prev = this.s;
    const draft = structuredClone(prev);
    mutate(draft);
    const next = sanitizeSettings(draft);
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.s = next;
    setActiveKeymap(next.controls.keys);
    saveSettings(next, this.store);
    for (const fn of [...this.listeners]) {
      try { fn(next, prev); } catch (err) { console.error('[settings] listener failed', err); }
    }
  }

  /** Reset one section (or everything) to defaults. */
  reset(section?: Exclude<keyof Settings, 'v'>) {
    const d = defaultSettings();
    this.update((s) => { if (section) (s as Record<string, unknown>)[section] = d[section]; else Object.assign(s, d); });
  }

  subscribe(fn: (s: Settings, prev: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** The app-wide store. */
export const settings = new SettingsStore();

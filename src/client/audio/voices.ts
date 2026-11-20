// Pure audio math + voice limiting. No Web Audio here so it can be unit-tested in node.

import type { Vec3 } from '../../sim/types';

export const REF_DISTANCE = 5;
export const MAX_DISTANCE = 120;
export const ROLLOFF = 1;

/**
 * Gain from distance, matching PannerNode's 'inverse' model (refDistance 5, rolloff 1) but
 * reaching 0 past MAX_DISTANCE (the panner itself only clamps there; we cull instead).
 */
export function distanceGain(d: number, ref = REF_DISTANCE, max = MAX_DISTANCE, rolloff = ROLLOFF): number {
  if (!(d >= 0)) return 1;
  if (d > max) return 0;
  return ref / (ref + rolloff * (Math.max(d, ref) - ref));
}

/** Air absorption: far sounds lose their top end. 18 kHz up close → ~2 kHz at max range. */
export function distanceCutoff(d: number): number {
  const t = Math.min(1, Math.max(0, (d - 10) / (MAX_DISTANCE - 10)));
  return 18000 * Math.pow(2000 / 18000, t);
}

/** Send level into the distant-echo bus: nothing up close, rising with distance. */
export function echoSend(d: number): number {
  return Math.min(1, Math.max(0, (d - 15) / 60)) * 0.6;
}

/** Low-health muffle: full range at/above 30 HP, closing to ~600 Hz near death. */
export function muffleCutoff(hp: number, alive = true): number {
  if (!alive || hp >= 30) return 20000;
  return 600 + (Math.max(0, hp) / 30) * 1400;
}

/** Seconds between heartbeats while low: ~0.95 s at 29 HP → ~0.55 s near death. */
export function heartbeatInterval(hp: number): number {
  return 0.55 + (Math.min(30, Math.max(0, hp)) / 30) * 0.4;
}

/** Wave loudness by distance to the shoreline: 1 at the waterline → 0.2 inland/far out. */
export function waveLevel(shoreDist: number): number {
  return 0.2 + 0.8 * Math.exp(-Math.max(0, shoreDist) / 10);
}

/** Subtle per-play pitch/timing variation. `r` in [0,1). */
export function jitter(r: number, spread: number): number {
  return 1 + (r * 2 - 1) * spread;
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** How loud a cue will be at the listener (0..~1.5): base gain × distance falloff; 2D cues skip falloff. */
export function audibility(gain: number, pos: Vec3 | null, listener: Vec3): number {
  return pos ? gain * distanceGain(dist(pos, listener)) : gain;
}

export type Admit = { ok: false; reason: 'quiet' | 'frame-cap' | 'full' } | { ok: true; id: number; evict: number | null };

type Active = { id: number; key: string; level: number; endsAt: number };

export type LimiterOptions = {
  maxVoices: number;
  /** Max starts of one sound key per frame (default for keys not listed). */
  perFrame: number;
  perFrameByKey?: Record<string, number>;
  /** Cues quieter than this at the listener are dropped outright. */
  minLevel: number;
};

export const DEFAULT_LIMITS: LimiterOptions = {
  maxVoices: 24,
  perFrame: 2,
  perFrameByKey: { footstep: 3, impact: 3, hitmarker: 1, coin: 1, tick: 1 },
  minLevel: 0.02,
};

/**
 * Caps simultaneous voices. When full, a louder cue steals the quietest playing voice; a cue no
 * louder than everything playing is dropped. Per-frame caps stop e.g. 8 SMGs stacking 8 identical
 * starts in one frame.
 */
export class VoiceLimiter {
  private active: Active[] = [];
  private frameCounts = new Map<string, number>();
  private nextId = 1;
  dropped = 0;

  constructor(private opts: LimiterOptions = DEFAULT_LIMITS) {}

  beginFrame(): void {
    this.frameCounts.clear();
  }

  get count(): number {
    return this.active.length;
  }

  admit(key: string, level: number, now: number, duration: number): Admit {
    this.expire(now);
    if (level < this.opts.minLevel) { this.dropped++; return { ok: false, reason: 'quiet' }; }
    const cap = this.opts.perFrameByKey?.[key] ?? this.opts.perFrame;
    const n = this.frameCounts.get(key) ?? 0;
    if (n >= cap) { this.dropped++; return { ok: false, reason: 'frame-cap' }; }
    let evict: number | null = null;
    if (this.active.length >= this.opts.maxVoices) {
      let qi = 0;
      for (let i = 1; i < this.active.length; i++) if (this.active[i].level < this.active[qi].level) qi = i;
      if (this.active[qi].level >= level) { this.dropped++; return { ok: false, reason: 'full' }; }
      evict = this.active[qi].id;
      this.active.splice(qi, 1);
    }
    this.frameCounts.set(key, n + 1);
    const id = this.nextId++;
    this.active.push({ id, key, level, endsAt: now + duration });
    return { ok: true, id, evict };
  }

  release(id: number): void {
    const i = this.active.findIndex((a) => a.id === id);
    if (i >= 0) this.active.splice(i, 1);
  }

  private expire(now: number) {
    if (this.active.length && this.active.some((a) => a.endsAt <= now)) this.active = this.active.filter((a) => a.endsAt > now);
  }
}

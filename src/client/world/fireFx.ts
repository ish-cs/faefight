import * as THREE from 'three/webgpu';
import { PIECES } from '../../sim/constants';
import type { FirePatch, PieceState, Vec3 } from '../../sim/types';
import type { Particles } from './particles';
import type { PieceLayer } from './pieces';
import type { Quality } from './sky';

/**
 * Fire visuals, driven by snapshot state (`burning` pieces, `fires` patches) so online guests see the same thing:
 * flame tongues (own additive instanced pool), smoke columns and embers (shared pools), charring that blackens a
 * burning piece, and one shared flickering light on the fire nearest the camera. No per-fire meshes or lights.
 */

type Source = {
  key: string; kind: 'piece' | FirePatch['kind']; pos: Vec3; rotY: number; w: number; h: number; d: number;
  /** Fractional particles owed (spawn rates are per second). */
  acc: [number, number, number];
};

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();
const RATE: Record<Quality, number> = { low: 0.45, high: 1, ultra: 1.3 };
/** Beyond this (m) from the camera a fire spawns nothing; past NEAR it spawns at half rate. */
const FAR = 110, NEAR = 45;
/** Seconds of burning to char a piece black. */
const CHAR_SEC = 9;
const _cam = new THREE.Vector3();

export class FireFx {
  private sources: Source[] = [];
  readonly light = new THREE.PointLight(0xff7a2a, 0, 16, 2);
  private quality: Quality = 'high';
  private charAcc = 0;
  private t = 0;

  constructor(private particles: Particles, private pieces: PieceLayer) {
    this.light.castShadow = false;
    this.light.name = 'fireLight';
  }

  setQuality(q: Quality) { this.quality = q; }

  /** Latest snapshot state. */
  sync(pieces: readonly PieceState[], fires: readonly FirePatch[] = []) {
    const keep = new Map(this.sources.map((s) => [s.key, s]));
    const next: Source[] = [];
    for (const p of pieces) {
      if (!p.burning) continue;
      const s = PIECES[p.kind], key = `p${p.id}`;
      const old = keep.get(key);
      next.push({ key, kind: 'piece', pos: p.pos, rotY: p.rotY, w: s.w, h: s.h, d: s.d, acc: old?.acc ?? [0, 0, 0] });
    }
    for (const f of fires) {
      const key = `f${f.id}`;
      const size = f.kind === 'grass' ? [2.4, 0.5, 2.4] : f.kind === 'crate' ? [0.9, 0.8, 0.9] : [0.5, 6.5, 0.5];
      next.push({ key, kind: f.kind, pos: f.pos, rotY: 0, w: size[0], h: size[1], d: size[2], acc: keep.get(key)?.acc ?? [0, 0, 0] });
    }
    this.sources = next;
  }

  /** Burning things now, for the crackle audio: [key, position]. */
  burning(): { id: string; pos: Vec3 }[] {
    return this.sources.map((s) => ({ id: s.key, pos: { x: s.pos.x, y: s.pos.y + Math.min(1.2, s.h / 2), z: s.pos.z } }));
  }

  get count() { return this.sources.length; }

  update(dt: number, camera: THREE.Camera) {
    this.t += dt;
    camera.getWorldPosition(_cam);
    const q = RATE[this.quality];
    const { flames, dust, sparks } = this.particles;
    let nearest: Source | null = null, nearD = Infinity;
    for (const s of this.sources) {
      const dx = s.pos.x - _cam.x, dz = s.pos.z - _cam.z, dist = Math.hypot(dx, dz);
      if (dist < nearD) { nearD = dist; nearest = s; }
      if (dist > FAR) continue;
      const k = q * (dist > NEAR ? 0.5 : 1);
      const area = Math.max(0.5, Math.min(1.6, (s.w * s.h) / 4));
      const piece = s.kind === 'piece';
      const fRate = (s.kind === 'grass' ? 34 : s.kind === 'palm' ? 34 : piece ? 40 * area : 20) * k;
      s.acc[0] += fRate * dt; s.acc[1] += (piece ? 5 : 3) * k * dt; s.acc[2] += (piece ? 4 : 2.5) * k * dt;
      const c = Math.cos(s.rotY), sn = Math.sin(s.rotY);
      const at = (lx: number, ly: number, lz: number, out: number[]) => {
        out[0] = s.pos.x + lx * c + lz * sn; out[1] = s.pos.y + ly; out[2] = s.pos.z - lx * sn + lz * c;
        return out;
      };
      const p = [0, 0, 0];
      for (; s.acc[0] >= 1; s.acc[0]--) {
        this.spot(s, p, at);
        const big = s.kind === 'grass' ? 0.8 : 1;
        const warm = rr(0.38, 0.62);
        flames.spawn(p[0], p[1], p[2], rr(-0.25, 0.25), rr(1.0, 2.2), rr(-0.25, 0.25), rr(0.5, 0.95), rr(0.6, 1.0) * big, 0.18, 1, warm, warm * 0.25, 0.9, -2.4, 1);
      }
      for (; s.acc[1] >= 1; s.acc[1]--) {
        const top = s.kind === 'palm' ? s.h : s.h * rr(0.7, 1);
        at(rr(-s.w / 3, s.w / 3), top, rr(-s.d / 3, s.d / 3), p);
        const g = rr(0.13, 0.22);
        dust.spawn(p[0], p[1], p[2], rr(-0.2, 0.2), rr(1, 1.6), rr(-0.2, 0.2), rr(3, 4.5), rr(0.6, 0.9), rr(2.4, 3.4), g, g * 0.95, g * 0.9, 0.62, -0.35, 0.6);
      }
      for (; s.acc[2] >= 1; s.acc[2]--) {
        this.spot(s, p, at);
        sparks.spawn(p[0], p[1], p[2], rr(-0.6, 0.6), rr(1.5, 3.2), rr(-0.6, 0.6), rr(1.2, 2.2), rr(0.03, 0.05), 0.01, 1, rr(0.45, 0.6), 0.15, 1, -0.3, 0.6);
      }
    }
    // One light on the nearest fire: flickers, off on low quality or when nothing burns close by.
    if (nearest && nearD < 50 && this.quality !== 'low') {
      this.light.position.set(nearest.pos.x, nearest.pos.y + Math.min(1.4, nearest.h * 0.6), nearest.pos.z);
      const n = Math.sin(this.t * 23) * 0.5 + Math.sin(this.t * 37 + 1.3) * 0.3 + Math.sin(this.t * 61 + 2.1) * 0.2;
      this.light.intensity = 26 * (0.8 + 0.2 * n);
    } else this.light.intensity = 0;
    // Char what's burning (throttled: colour uploads 4×/s).
    this.charAcc += dt;
    if (this.charAcc >= 0.25) {
      for (const s of this.sources) if (s.kind === 'piece') {
        const id = Number(s.key.slice(1));
        this.pieces.setChar(id, this.pieces.charOf(id) + this.charAcc / CHAR_SEC);
      }
      this.charAcc = 0;
    }
  }

  /** A random point on a source where flames lick: a piece's faces (low-biased), a grass disc, a crate, a palm trunk/crown. */
  private spot(s: Source, out: number[], at: (lx: number, ly: number, lz: number, out: number[]) => number[]) {
    if (s.kind === 'grass') { const a = R() * Math.PI * 2, r = Math.sqrt(R()) * s.w / 2; return at(Math.cos(a) * r, rr(0, 0.15), Math.sin(a) * r, out); }
    if (s.kind === 'palm') {
      if (R() < 0.45) { const a = R() * Math.PI * 2; return at(Math.cos(a) * rr(0.3, 1.6), s.h + rr(-0.4, 0.6), Math.sin(a) * rr(0.3, 1.6), out); }
      return at(rr(-0.15, 0.15), rr(0, s.h), rr(-0.15, 0.15), out);
    }
    if (s.kind === 'piece' && s.d > s.w) {
      // Decks and ramps burn along their top (a ramp rises along local +Z).
      const lz = rr(-s.d / 2, s.d / 2);
      return at(rr(-s.w / 2, s.w / 2), s.h < 0.5 ? s.h : s.h * (lz / s.d + 0.5), lz, out);
    }
    const y = s.h * Math.pow(R(), 1.4) * 0.95;
    const face = R() < 0.5 ? -1 : 1;
    return s.d < s.w ? at(rr(-s.w / 2, s.w / 2), y, face * (s.d / 2 + 0.04), out) : at(face * (s.w / 2 + 0.04), y, rr(-s.d / 2, s.d / 2), out);
  }
}

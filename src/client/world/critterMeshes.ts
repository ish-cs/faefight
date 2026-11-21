/**
 * Low-poly wildlife meshes built in code (no assets), one per species, facing -Z, feet at y = 0. Every vertex
 * carries `limb` = (kind, amount) for the shared procedural animation in critters.ts:
 *   1 / 2  legs, two phases (diagonal pairs)   amount = stride at the foot (m)
 *   3      wing: flaps with the gait, folds when it's 0   amount = beat height per metre of span
 *   4      tail / fin: wags                    amount = sweep (m)
 *   5      head: dips with the pose (sniff, peck, nap, claw wave)   amount = dip (m)
 *   6      pulse (jellyfish bell, tentacles)   amount = radial swell
 */
import * as THREE from 'three/webgpu';

type P = { pos: number[]; col: number[]; limb: number[]; idx: number[] };
const C = (hex: number) => new THREE.Color(hex);
const EYE = 0x040404;

class Builder {
  private p: P = { pos: [], col: [], limb: [], idx: [] };

  /** Low-poly ellipsoid (8 × 5 by default). `w(y)` → per-vertex limb amount weight (default 1). */
  ell(x: number, y: number, z: number, rx: number, ry: number, rz: number, col: number, kind = 0, amt = 0, seg = 8, rings = 5) {
    const base = this.p.pos.length / 3, c = C(col);
    for (let i = 0; i <= rings; i++) {
      const v = (i / rings) * Math.PI, sy = Math.cos(v), sr = Math.sin(v);
      for (let k = 0; k < seg; k++) {
        const u = (k / seg) * Math.PI * 2;
        this.v(x + Math.cos(u) * sr * rx, y + sy * ry, z + Math.sin(u) * sr * rz, c, kind, amt);
      }
    }
    for (let i = 0; i < rings; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * seg + k, b = base + i * seg + ((k + 1) % seg), cc = a + seg, d = b + seg;
      this.p.idx.push(a, cc, b, b, cc, d);
    }
    return this;
  }

  /** Box from (x0, y0, z0) to (x1, y1, z1); legs (kind 1/2) weight the amount by depth below the top (hip). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: number, kind = 0, amt = 0) {
    const base = this.p.pos.length / 3, c = C(col);
    const leg = kind === 1 || kind === 2;
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) {
      this.v(x, y, z, c, kind, leg ? amt * (y === y0 ? 1 : 0) : amt);
    }
    const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    for (const i of f) this.p.idx.push(base + i);
    return this;
  }

  /** A pair of glossy eyes (near-black: the coat shader makes them shiny) at (±x, y, z), riding with the head. */
  eyes(x: number, y: number, z: number, r: number, headAmt = 0) {
    return this.ell(-x, y, z, r, r, r, EYE, 5, headAmt, 6, 4).ell(x, y, z, r, r, r, EYE, 5, headAmt, 6, 4);
  }

  /** Thin leg from hip (x, y, z) straight down to the ground. */
  leg(x: number, y: number, z: number, t: number, col: number, kind: 1 | 2, amt: number) {
    return this.box(x - t, 0, z - t, x + t, y, z + t, col, kind, amt);
  }

  /** Double-sided triangle. */
  tri(a: number[], b: number[], c: number[], col: number, kind = 0, amt = 0) {
    const base = this.p.pos.length / 3, cc = C(col);
    for (const q of [a, b, c]) this.v(q[0], q[1], q[2], cc, kind, kind === 3 ? amt * Math.abs(q[0]) : amt);
    this.p.idx.push(base, base + 1, base + 2, base, base + 2, base + 1);
    return this;
  }

  /** A wing pair: span `s` from the shoulder at (±x, y, z), chord `c`. */
  wings(x: number, y: number, z: number, s: number, c: number, col: number, tip = col) {
    for (const sx of [-1, 1]) {
      this.tri([sx * x, y, z - c * 0.5], [sx * (x + s), y + 0.02, z + c * 0.2], [sx * x, y, z + c * 0.5], col, 3, 1);
      this.tri([sx * (x + s * 0.6), y + 0.01, z - c * 0.1], [sx * (x + s), y + 0.02, z + c * 0.2], [sx * (x + s * 0.7), y + 0.01, z + c * 0.4], tip, 3, 1);
    }
    return this;
  }

  private v(x: number, y: number, z: number, c: THREE.Color, kind: number, amt: number) {
    this.p.pos.push(x, y, z); this.p.col.push(c.r, c.g, c.b); this.p.limb.push(kind, amt);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.p.col, 3));
    g.setAttribute('limb', new THREE.Float32BufferAttribute(this.p.limb, 2));
    g.setIndex(this.p.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const quad = (b: Builder, hipY: number, hx: number, hz: number, t: number, col: number, amt: number) =>
  b.leg(-hx, hipY, -hz, t, col, 1, amt).leg(hx, hipY, hz, t, col, 1, amt).leg(hx, hipY, -hz, t, col, 2, amt).leg(-hx, hipY, hz, t, col, 2, amt);

const BUILD: Record<string, () => THREE.BufferGeometry> = {
  rat: () => quad(new Builder(), 0.035, 0.03, 0.05, 0.007, 0xb89a8a, 0.03)
    .ell(0, 0.055, 0, 0.042, 0.036, 0.085, 0x6a5d52).ell(0, 0.06, -0.1, 0.026, 0.024, 0.04, 0x6f6256, 5, 0.015)
    .ell(-0.018, 0.085, -0.095, 0.012, 0.014, 0.004, 0xc9a0a0).ell(0.018, 0.085, -0.095, 0.012, 0.014, 0.004, 0xc9a0a0)
    .box(-0.004, 0.035, 0.08, 0.004, 0.043, 0.25, 0xb08f86, 4, 0.04).eyes(0.017, 0.07, -0.122, 0.006, 0.015).build(),
  pigeon: () => new Builder().leg(-0.02, 0.06, 0, 0.005, 0xc0504a, 1, 0.03).leg(0.02, 0.06, 0, 0.005, 0xc0504a, 2, 0.03)
    .ell(0, 0.12, 0, 0.055, 0.055, 0.1, 0x8d93a0).ell(0, 0.19, -0.075, 0.032, 0.035, 0.034, 0x5c6f78, 5, 0.07)
    .ell(0, 0.185, -0.11, 0.008, 0.008, 0.016, 0x2a2a2a, 5, 0.07).box(-0.03, 0.11, 0.08, 0.03, 0.125, 0.17, 0x4c5058)
    .wings(0.045, 0.14, 0, 0.22, 0.12, 0x9aa0ac, 0x3c4048).eyes(0.024, 0.2, -0.09, 0.006, 0.07).build(),
  gull: () => new Builder().leg(-0.03, 0.09, 0, 0.007, 0xe0a040, 1, 0.04).leg(0.03, 0.09, 0, 0.007, 0xe0a040, 2, 0.04)
    .ell(0, 0.19, 0, 0.08, 0.08, 0.17, 0xf2f2ee).ell(0, 0.29, -0.13, 0.05, 0.05, 0.055, 0xf6f6f2, 5, 0.09)
    .box(-0.008, 0.27, -0.27, 0.008, 0.29, -0.17, 0xe8c030, 5, 0.09).box(-0.05, 0.17, 0.12, 0.05, 0.2, 0.27, 0x222222)
    .wings(0.07, 0.22, 0, 0.42, 0.18, 0x9aa2ac, 0x181818).eyes(0.035, 0.305, -0.15, 0.007, 0.09).build(),
  crow: () => new Builder().leg(-0.025, 0.07, 0, 0.006, 0x202020, 1, 0.03).leg(0.025, 0.07, 0, 0.006, 0x202020, 2, 0.03)
    .ell(0, 0.15, 0, 0.065, 0.065, 0.13, 0x16161a).ell(0, 0.23, -0.1, 0.04, 0.042, 0.045, 0x1c1c22, 5, 0.03)
    .ell(0, 0.225, -0.155, 0.012, 0.011, 0.03, 0x111111, 5, 0.03).box(-0.04, 0.14, 0.1, 0.04, 0.155, 0.24, 0x121216)
    .wings(0.05, 0.17, 0, 0.32, 0.16, 0x1a1a20).eyes(0.03, 0.24, -0.125, 0.007, 0.03).build(),
  dog: () => quad(new Builder(), 0.3, 0.08, 0.2, 0.025, 0xc9a074, 0.12)
    .ell(0, 0.36, 0, 0.11, 0.11, 0.3, 0xc9a074).ell(0, 0.47, -0.32, 0.085, 0.085, 0.1, 0xc59a6c, 5, 0.08)
    .ell(0, 0.44, -0.42, 0.045, 0.04, 0.07, 0x8a6a4a, 5, 0.08).ell(0, 0.455, -0.49, 0.015, 0.015, 0.012, 0x151515, 5, 0.08)
    .ell(-0.07, 0.48, -0.3, 0.02, 0.06, 0.03, 0x7a5a3a, 5, 0.08).ell(0.07, 0.48, -0.3, 0.02, 0.06, 0.03, 0x7a5a3a, 5, 0.08)
    .box(-0.015, 0.4, 0.27, 0.015, 0.55, 0.31, 0xb89060, 4, 0.12).eyes(0.045, 0.5, -0.4, 0.012, 0.08).build(),
  crab: () => {
    const b = new Builder();
    for (let i = 0; i < 4; i++) for (const sx of [-1, 1]) {
      const z = -0.03 + i * 0.022, k = ((i + (sx > 0 ? 1 : 0)) % 2 ? 1 : 2) as 1 | 2;
      b.tri([sx * 0.05, 0.035, z], [sx * 0.11, 0.0, z + 0.01], [sx * 0.05, 0.03, z + 0.008], 0xb8402a, k, 0.02);
    }
    return b.ell(0, 0.035, 0, 0.07, 0.025, 0.05, 0xd0502e).ell(-0.05, 0.04, -0.07, 0.025, 0.014, 0.02, 0xe06038, 5, -0.02)
      .ell(0.05, 0.04, -0.07, 0.025, 0.014, 0.02, 0xe06038, 5, -0.02).ell(-0.018, 0.065, -0.04, 0.006, 0.012, 0.006, EYE).ell(0.018, 0.065, -0.04, 0.006, 0.012, 0.006, EYE).build();
  },
  hermit: () => new Builder().ell(0, 0.035, 0.01, 0.035, 0.035, 0.045, 0xd8c3a0).ell(0, 0.06, 0.03, 0.02, 0.022, 0.025, 0xc4ab88)
    .ell(0, 0.02, -0.035, 0.018, 0.012, 0.015, 0xc8503a, 5, 0.008).leg(-0.02, 0.02, -0.03, 0.004, 0xb8402a, 1, 0.01).leg(0.02, 0.02, -0.03, 0.004, 0xb8402a, 2, 0.01).build(),
  turtle: () => quad(new Builder(), 0.07, 0.24, 0.24, 0.05, 0x7a8a5a, 0.08)
    .ell(0, 0.13, 0, 0.3, 0.12, 0.38, 0x5a5236, 0, 0, 8, 4).ell(0, 0.08, 0, 0.32, 0.05, 0.4, 0x8a8a62, 0, 0, 8, 3)
    .ell(0, 0.1, -0.45, 0.07, 0.06, 0.1, 0x7a8a5a, 5, 0.04).eyes(0.045, 0.12, -0.52, 0.01, 0.04).build(),
  starfish: () => {
    const b = new Builder();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2, a1 = a + 0.4, a2 = a - 0.4;
      b.tri([0, 0.02, 0], [Math.cos(a1) * 0.04, 0.012, Math.sin(a1) * 0.04], [Math.cos(a) * 0.13, 0.008, Math.sin(a) * 0.13], 0xe0703a);
      b.tri([0, 0.02, 0], [Math.cos(a) * 0.13, 0.008, Math.sin(a) * 0.13], [Math.cos(a2) * 0.04, 0.012, Math.sin(a2) * 0.04], 0xd0602e);
    }
    return b.build();
  },
  heron: () => new Builder().leg(-0.04, 0.55, 0, 0.008, 0x8a8070, 1, 0.12).leg(0.04, 0.55, 0, 0.008, 0x8a8070, 2, 0.12)
    .ell(0, 0.65, 0.02, 0.09, 0.1, 0.2, 0x8a98a8).box(-0.018, 0.68, -0.2, 0.018, 1.0, -0.15, 0xb8c0c8, 5, 0.12)
    .ell(0, 1.02, -0.2, 0.035, 0.035, 0.05, 0xdde0e4, 5, 0.12).box(-0.008, 1.0, -0.42, 0.008, 1.02, -0.24, 0xd8b030, 5, 0.12)
    .wings(0.07, 0.7, 0.02, 0.75, 0.3, 0x7a8898, 0x303840).eyes(0.025, 1.03, -0.22, 0.007, 0.12).build(),
  pelican: () => new Builder().leg(-0.06, 0.12, 0, 0.012, 0xc89a40, 1, 0.05).leg(0.06, 0.12, 0, 0.012, 0xc89a40, 2, 0.05)
    .ell(0, 0.3, 0.02, 0.17, 0.17, 0.32, 0xe6e2da).ell(0, 0.55, -0.22, 0.08, 0.08, 0.09, 0xeeeae2, 5, 0.06)
    .box(-0.035, 0.46, -0.65, 0.035, 0.54, -0.26, 0xe8b850, 5, 0.06).box(-0.04, 0.41, -0.6, 0.04, 0.47, -0.3, 0xd89a60, 5, 0.06)
    .wings(0.13, 0.36, 0.02, 1.0, 0.42, 0xd8d4cc, 0x2a2a2a).eyes(0.055, 0.58, -0.26, 0.01, 0.06).build(),
  cormorant: () => new Builder().leg(-0.04, 0.1, 0, 0.01, 0x202020, 1, 0.04).leg(0.04, 0.1, 0, 0.01, 0x202020, 2, 0.04)
    .ell(0, 0.28, 0.02, 0.09, 0.15, 0.13, 0x18191c).box(-0.025, 0.38, -0.1, 0.025, 0.58, -0.05, 0x1c1d22, 5, 0.05)
    .ell(0, 0.6, -0.09, 0.04, 0.04, 0.06, 0x1e2026, 5, 0.05).box(-0.01, 0.585, -0.24, 0.01, 0.6, -0.12, 0xd0a030, 5, 0.05)
    .wings(0.08, 0.32, 0.02, 0.55, 0.28, 0x16171a).eyes(0.03, 0.615, -0.12, 0.008, 0.05).build(),
  parrot: () => new Builder().leg(-0.02, 0.05, 0, 0.005, 0x606060, 1, 0.02).leg(0.02, 0.05, 0, 0.005, 0x606060, 2, 0.02)
    .ell(0, 0.13, 0, 0.055, 0.08, 0.06, 0xffffff).ell(0, 0.23, -0.025, 0.04, 0.04, 0.042, 0xffffff, 5, 0.03)
    .ell(0, 0.215, -0.07, 0.016, 0.02, 0.02, 0xf0e8d0, 5, 0.03).box(-0.02, 0.0, 0.03, 0.02, 0.09, 0.05, 0xd8d8d8)
    .wings(0.045, 0.16, 0, 0.24, 0.12, 0xe8e8e8, 0x2a40a0).eyes(0.028, 0.24, -0.045, 0.006, 0.03).build(),
  lizard: () => quad(new Builder(), 0.015, 0.03, 0.04, 0.004, 0x6a7a3a, 0.025)
    .ell(0, 0.016, 0, 0.018, 0.011, 0.06, 0x7a8a42).ell(0, 0.018, -0.07, 0.013, 0.009, 0.022, 0x7f8f48, 5, 0.006)
    .box(-0.005, 0.01, 0.05, 0.005, 0.018, 0.17, 0x6a7a38, 4, 0.04).eyes(0.009, 0.025, -0.078, 0.003, 0.006).build(),
  gecko: () => quad(new Builder(), 0.01, 0.022, 0.03, 0.003, 0xd8c8a8, 0.02)
    .ell(0, 0.011, 0, 0.013, 0.008, 0.042, 0xe0d0b0).ell(0, 0.012, -0.05, 0.012, 0.007, 0.016, 0xe4d4b4, 5, 0.004)
    .box(-0.004, 0.007, 0.035, 0.004, 0.013, 0.1, 0xd0c0a0, 4, 0.03).eyes(0.009, 0.017, -0.055, 0.003, 0.004).build(),
  iguana: () => {
    const b = quad(new Builder(), 0.06, 0.1, 0.14, 0.014, 0x4a7a3a, 0.06)
      .ell(0, 0.08, 0, 0.08, 0.06, 0.22, 0x5a8a42).ell(0, 0.09, -0.27, 0.05, 0.045, 0.08, 0x62924a, 5, 0.03)
      .box(-0.015, 0.05, 0.2, 0.015, 0.08, 0.75, 0x4f7f3c, 4, 0.12);
    for (let k = 0; k < 6; k++) b.tri([0, 0.13, -0.18 + k * 0.07], [0, 0.17, -0.15 + k * 0.07], [0, 0.13, -0.12 + k * 0.07], 0x3a6a2a);
    return b.eyes(0.035, 0.12, -0.3, 0.008, 0.03).build();
  },
  jelly: () => {
    const b = new Builder().ell(0, 0.05, 0, 0.14, 0.09, 0.14, 0xf0a8d8, 6, 0.25, 8, 3);
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; b.box(Math.cos(a) * 0.07 - 0.004, -0.3, Math.sin(a) * 0.07 - 0.004, Math.cos(a) * 0.07 + 0.004, 0.0, Math.sin(a) * 0.07 + 0.004, 0xe8c0e0, 6, 0.4); }
    return b.build();
  },
  fish: () => new Builder().ell(0, 0, 0, 0.03, 0.06, 0.17, 0x8aa8c0).tri([0, 0, 0.15], [0, 0.07, 0.28], [0, -0.07, 0.28], 0x6a88a0, 4, 0.06)
    .tri([0, 0.05, -0.02], [0, 0.1, 0.06], [0, 0.05, 0.08], 0x6a88a0).eyes(0.022, 0.015, -0.12, 0.007).build(),
  // swarms
  fly: () => new Builder().ell(0, 0, 0, 0.004, 0.004, 0.007, 0x151515, 0, 0, 4, 2).tri([0, 0.003, 0], [0.012, 0.004, 0.004], [0, 0.003, 0.006], 0x9aa0a8, 3, 1).tri([0, 0.003, 0], [-0.012, 0.004, 0.004], [0, 0.003, 0.006], 0x9aa0a8, 3, 1).build(),
  butterfly: () => new Builder().box(-0.003, -0.003, -0.02, 0.003, 0.003, 0.02, 0x202020)
    .tri([0, 0, -0.02], [0.05, 0.002, -0.035], [0.045, 0.002, 0.01], 0xffffff, 3, 6).tri([0, 0, 0.0], [0.035, 0.002, 0.01], [0.02, 0.002, 0.04], 0xffffff, 3, 6)
    .tri([0, 0, -0.02], [-0.05, 0.002, -0.035], [-0.045, 0.002, 0.01], 0xffffff, 3, 6).tri([0, 0, 0.0], [-0.035, 0.002, 0.01], [-0.02, 0.002, 0.04], 0xffffff, 3, 6).build(),
  dragonfly: () => new Builder().box(-0.004, -0.004, -0.02, 0.004, 0.004, 0.07, 0x2a6aa0).ell(0, 0, -0.025, 0.008, 0.007, 0.008, 0x20a080)
    .tri([0, 0.002, -0.015], [0.06, 0.003, -0.01], [0, 0.002, -0.005], 0xd8e8f0, 3, 0.3).tri([0, 0.002, -0.015], [-0.06, 0.003, -0.01], [0, 0.002, -0.005], 0xd8e8f0, 3, 0.3)
    .tri([0, 0.002, 0.0], [0.055, 0.003, 0.008], [0, 0.002, 0.01], 0xd8e8f0, 3, 0.3).tri([0, 0.002, 0.0], [-0.055, 0.003, 0.008], [0, 0.002, 0.01], 0xd8e8f0, 3, 0.3).build(),
  bee: () => new Builder().ell(0, 0, 0, 0.007, 0.007, 0.011, 0xe0b020, 0, 0, 5, 3).ell(0, 0.001, 0.006, 0.0072, 0.0072, 0.003, 0x1a1a1a, 0, 0, 5, 2)
    .tri([0, 0.006, -0.002], [0.014, 0.008, 0.002], [0, 0.006, 0.004], 0xe8f0f8, 3, 1).tri([0, 0.006, -0.002], [-0.014, 0.008, 0.002], [0, 0.006, 0.004], 0xe8f0f8, 3, 1).build(),
  school: () => new Builder().ell(0, 0, 0, 0.015, 0.03, 0.08, 0x9ab0c0, 0, 0, 5, 3).tri([0, 0, 0.07], [0, 0.03, 0.12], [0, -0.03, 0.12], 0x7a90a0, 4, 0.03).build(),
};

const cache = new Map<string, THREE.BufferGeometry>();
export function critterGeometry(name: string): THREE.BufferGeometry {
  let g = cache.get(name);
  if (!g) {
    const b = BUILD[name];
    if (!b) throw new Error(`[critters] no mesh builder for species "${name}"`);
    g = b();
    cache.set(name, g);
  }
  return g;
}

/** Per-instance colour variety (multiplies the vertex colours). */
export const TINTS: Record<string, number[]> = {
  rat: [0xffffff, 0xb8bec8, 0xd8c4b0, 0x8a8480],
  crab: [0xffffff, 0xffd0b8, 0xe8a8a0],
  dog: [0xffffff, 0x8a7060, 0xf0e0c8, 0x505050],
  parrot: [0x30c040, 0xe03030, 0x3070e0, 0xf0c020],
  butterfly: [0xf0a020, 0xf0f0f0, 0x60a0f0, 0xf06040, 0xf0e040],
  pigeon: [0xffffff, 0xd8d8e0, 0xa8a8b0, 0xf0e8e0],
};

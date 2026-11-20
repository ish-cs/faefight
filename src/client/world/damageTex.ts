import * as THREE from 'three/webgpu';
import { canvasTex, makeRng } from './textures';

/**
 * Textures for visible piece damage. All are generated once, deterministically, and cached.
 *
 * damageTex (RGBA8 data texture, tileable, ≈2.5 m per tile, sampled by box projection of piece-local position):
 *   R = crack intensity (1 = crack core, ~0.3 = dark halo around it, 0 = none)
 *   G = "damage order" field, histogram-equalised to uniform 0..1: a pixel is damaged once
 *       damage ≥ G (so damage d affects exactly fraction d of the surface; holes open in the lowest G first)
 *   B = vertical streak noise (rust / soot runs)
 *   A = dent height (0 flat .. 1 deepest)
 */
export const DAMAGE_TILE_M = 2.5;
const N = 512;

let dmg: THREE.DataTexture | null = null;
export function damageTex(): THREE.DataTexture {
  if (dmg) return dmg;
  const t0 = performance.now();
  const { rnd, rr } = makeRng(4242);

  // --- R: crack trees drawn on a canvas (halo pass, then core pass), tiled by drawing at 3×3 offsets
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('[world/damageTex] 2D canvas context unavailable');
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.globalCompositeOperation = 'lighten';
  type Seg = [number, number, number, number, number];
  const segs: Seg[] = [];
  const walk = (x: number, y: number, a: number, steps: number, width: number, depth: number) => {
    for (let s = 0; s < steps; s++) {
      const len = rr(9, 18);
      const nx = x + Math.cos(a) * len, ny = y + Math.sin(a) * len;
      const w = width * (1 - (s / steps) * 0.65);
      segs.push([x, y, nx, ny, w]);
      if (depth < 2 && rnd() < 0.16) walk(nx, ny, a + (rnd() < 0.5 ? -1 : 1) * rr(0.5, 1.1), Math.floor(steps * rr(0.3, 0.6)), w * 0.7, depth + 1);
      x = nx; y = ny; a += rr(-0.55, 0.55);
    }
  };
  for (let k = 0; k < 16; k++) {
    const x = rnd() * N, y = rnd() * N;
    const arms = 3 + Math.floor(rnd() * 3);
    for (let a = 0; a < arms; a++) walk(x, y, (a / arms) * Math.PI * 2 + rr(-0.4, 0.4), 6 + Math.floor(rnd() * 10), rr(3, 4.2), 0);
  }
  const strokeAll = (style: string, widthMul: number, add: number) => {
    g.strokeStyle = style;
    for (const [x0, y0, x1, y1, w] of segs) {
      g.lineWidth = w * widthMul + add;
      for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
        g.beginPath(); g.moveTo(x0 + ox, y0 + oy); g.lineTo(x1 + ox, y1 + oy); g.stroke();
      }
    }
  };
  strokeAll('rgb(70,70,70)', 3.2, 3);
  strokeAll('rgb(150,150,150)', 1.6, 1);
  strokeAll('rgb(255,255,255)', 0.75, 0);
  const crack = g.getImageData(0, 0, N, N).data;

  // --- periodic value noise helpers
  const lattice = (p: number, s: number) => {
    const h = new Float32Array(p * p);
    const r = makeRng(s);
    for (let i = 0; i < h.length; i++) h[i] = r.rnd();
    return h;
  };
  const sm = (t: number) => t * t * (3 - 2 * t);
  const vnoise = (x: number, y: number, px: number, py: number, h: Float32Array) => {
    // x in [0,px), y in [0,py) lattice units; periodic
    const xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py, x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const a = h[y0 * px + x0], b = h[y0 * px + x1], cc = h[y1 * px + x0], d = h[y1 * px + x1];
    return a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
  };
  const octs = [4, 8, 16, 32].map((p, i) => ({ p, h: lattice(p * p, 100 + i), amp: [1, 0.55, 0.3, 0.15][i] }));
  const streakH = lattice(64 * 4, 200);
  const streakH2 = lattice(24 * 2, 201);

  // --- G: fbm, then histogram-equalised; B: vertical streaks
  const field = new Float32Array(N * N);
  const streak = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    let f = 0;
    for (const o of octs) f += o.amp * vnoise(u * o.p, v * o.p, o.p, o.p, o.h);
    field[y * N + x] = f;
    streak[y * N + x] = 0.65 * vnoise(u * 64, v * 4, 64, 4, streakH) + 0.35 * vnoise(u * 24, v * 2, 24, 2, streakH2);
  }
  const order = new Uint32Array(N * N);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => field[a] - field[b]);
  const eq = new Float32Array(N * N);
  for (let r = 0; r < order.length; r++) eq[order[r]] = r / (order.length - 1);

  // --- A: dents (smooth bowls, wrapped)
  const dent = new Float32Array(N * N);
  const dr = makeRng(303);
  for (let k = 0; k < 70; k++) {
    const cx = dr.rnd() * N, cy = dr.rnd() * N, rad = dr.rr(10, 42), amp = dr.rr(0.35, 1);
    const r0 = Math.ceil(rad);
    for (let oy = -r0; oy <= r0; oy++) for (let ox = -r0; ox <= r0; ox++) {
      const q = (ox * ox + oy * oy) / (rad * rad);
      if (q >= 1) continue;
      const x = ((Math.floor(cx) + ox) % N + N) % N, y = ((Math.floor(cy) + oy) % N + N) % N;
      const b = (1 - q) * (1 - q) * amp;
      const i = y * N + x;
      dent[i] = Math.max(dent[i], b);
    }
  }

  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = crack[i * 4];
    data[i * 4 + 1] = Math.round(eq[i] * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, streak[i])) * 255);
    data[i * 4 + 3] = Math.round(Math.min(1, dent[i]) * 255);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  dmg = t;
  console.info(`[world/damageTex] generated ${N}² damage texture in ${Math.round(performance.now() - t0)} ms`);
  return t;
}

/** Decal atlas, 2×2 cells: 0 wood hole, 1 sheet-metal hole, 2 steel ding, 3 sandbag hole. */
export const DECAL_WOOD = 0, DECAL_METAL = 1, DECAL_STEEL = 2, DECAL_SAND = 3;
let atlas: THREE.CanvasTexture | null = null;
export function decalAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const { rnd, rr } = makeRng(77);
  atlas = canvasTex(512, 512, (g) => {
    g.clearRect(0, 0, 512, 512);
    const S = 256;
    const cell = (i: number, draw: (cx: number, cy: number, R: number) => void) => {
      const x = (i % 2) * S, y = Math.floor(i / 2) * S;
      g.save();
      g.beginPath(); g.rect(x, y, S, S); g.clip();
      draw(x + S / 2, y + S / 2, S / 2);
      g.restore();
    };
    const radial = (cx: number, cy: number, r: number, stops: [number, string][]) => {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      for (const [o, c] of stops) gr.addColorStop(o, c);
      g.fillStyle = gr;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    };
    const jag = (cx: number, cy: number, r0: number, r1: number, n: number, fill: string) => {
      g.fillStyle = fill;
      g.beginPath();
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        const r = k % 2 ? rr(r0, r1) : rr(r0 * 0.7, r0);
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      g.fill();
    };
    // 0: wood — torn splinters of fresh wood around a dark hole
    cell(DECAL_WOOD, (cx, cy, R) => {
      radial(cx, cy, R * 0.95, [[0, 'rgba(40,24,10,0.55)'], [1, 'rgba(40,24,10,0)']]);
      jag(cx, cy, R * 0.42, R * 0.8, 22, 'rgba(236,198,140,1)');
      g.strokeStyle = 'rgba(120,80,40,0.8)'; g.lineWidth = 3;
      for (let k = 0; k < 9; k++) { const a = rnd() * Math.PI * 2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R * rr(0.4, 0.75), cy + Math.sin(a) * R * rr(0.4, 0.75)); g.stroke(); }
      jag(cx, cy, R * 0.3, R * 0.38, 14, 'rgba(12,7,3,1)');
    });
    // 1: sheet metal — punched hole, bright torn lip, soot ring
    cell(DECAL_METAL, (cx, cy, R) => {
      radial(cx, cy, R * 0.98, [[0, 'rgba(15,14,12,0.85)'], [0.55, 'rgba(25,22,20,0.45)'], [1, 'rgba(25,22,20,0)']]);
      jag(cx, cy, R * 0.4, R * 0.5, 16, 'rgba(235,235,232,1)');
      jag(cx, cy, R * 0.26, R * 0.32, 12, 'rgba(5,5,5,1)');
    });
    // 2: steel — shiny crater (no through-hole), radial scratches, soot halo
    cell(DECAL_STEEL, (cx, cy, R) => {
      radial(cx, cy, R * 0.98, [[0, 'rgba(20,18,16,0.7)'], [0.6, 'rgba(30,28,26,0.35)'], [1, 'rgba(30,28,26,0)']]);
      radial(cx, cy, R * 0.5, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(210,212,215,1)'], [0.8, 'rgba(120,122,126,1)'], [1, 'rgba(90,92,95,0)']]);
      g.strokeStyle = 'rgba(245,245,245,0.9)'; g.lineWidth = 2.5;
      for (let k = 0; k < 10; k++) { const a = rnd() * Math.PI * 2, r0 = R * 0.3; g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * R * rr(0.55, 0.8), cy + Math.sin(a) * R * rr(0.55, 0.8)); g.stroke(); }
      radial(cx, cy, R * 0.16, [[0, 'rgba(60,60,62,1)'], [1, 'rgba(160,160,165,1)']]);
    });
    // 3: sandbag — frayed tear with sand spilling down out of it
    cell(DECAL_SAND, (cx, cy, R) => {
      g.fillStyle = 'rgba(232,206,150,1)';
      g.beginPath(); g.moveTo(cx - R * 0.3, cy); g.quadraticCurveTo(cx - R * 0.15, cy + R * 0.95, cx, cy + R * 0.98); g.quadraticCurveTo(cx + R * 0.15, cy + R * 0.95, cx + R * 0.3, cy); g.fill();
      jag(cx, cy, R * 0.38, R * 0.62, 26, 'rgba(110,86,52,0.95)');
      jag(cx, cy, R * 0.26, R * 0.36, 16, 'rgba(25,18,10,1)');
      radial(cx, cy + R * 0.2, R * 0.2, [[0, 'rgba(240,215,160,1)'], [1, 'rgba(240,215,160,0)']]);
    });
  });
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
  return atlas;
}

/** Soft round puff for particles (white, alpha falloff). */
let puff: THREE.CanvasTexture | null = null;
export function puffTex(): THREE.CanvasTexture {
  if (puff) return puff;
  puff = canvasTex(64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  puff.wrapS = puff.wrapT = THREE.ClampToEdgeWrapping;
  return puff;
}

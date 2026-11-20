import * as THREE from 'three/webgpu';
import type { Ellipse, IslandDecor } from './decor';

/** Deterministic PRNG so every client draws identical textures/props. */
export function makeRng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const rr = (a: number, b: number) => a + (b - a) * rnd();
  return { rnd, rr };
}
const { rnd, rr } = makeRng(1337);

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

export function canvasTex(w: number, h: number, draw: Draw, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('[world/textures] 2D canvas context unavailable');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function speckle(g: CanvasRenderingContext2D, w: number, h: number, amp: number) {
  const d = g.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    const n = (rnd() - 0.5) * amp;
    d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n;
  }
  g.putImageData(d, 0, 0);
}

function blotches(g: CanvasRenderingContext2D, w: number, h: number, n: number, rgb: string, rmin: number, rmax: number, amax: number) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = rr(rmin, rmax);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${rr(0, amax)})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}

const cache = new Map<string, THREE.Texture>();
function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = cache.get(key) as T | undefined;
  if (!t) { t = make(); cache.set(key, t); }
  return t;
}

/** Quay wall: v=0 bottom (deep, dark) → v=1 top (sunlit coping). Algae/tide band set by the caller's UV. */
export const seawallTex = () => cached('seawall', () => canvasTex(256, 1024, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  // top of canvas = top of wall
  gr.addColorStop(0, '#b3ab9c'); gr.addColorStop(0.03, '#a39b8c'); gr.addColorStop(0.06, '#9a9284');
  gr.addColorStop(0.105, '#867e70'); gr.addColorStop(0.125, '#5d6248'); gr.addColorStop(0.15, '#3a4130');
  gr.addColorStop(0.3, '#262c22'); gr.addColorStop(1, '#151a15');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(40,40,36,0.5)'; g.fillRect(0, 0.028 * h, w, 3); // coping joint
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(60,55,45,${rr(0.05, 0.2)})`; g.fillRect(rnd() * w, 0.03 * h, rr(1, 4), rr(20, 110)); }
  g.fillStyle = 'rgba(30,30,28,0.35)'; g.fillRect(0, 0, 2, h); // panel joint
  speckle(g, w, h, 18);
}));

export const frondTex = () => cached('frond', () => canvasTex(128, 512, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  const cx = w / 2;
  for (let y = 10; y < h - 4; y += 5) {
    const t = y / h, L = (w / 2 - 4) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.6) * (1 - 0.25 * t);
    for (const side of [-1, 1]) {
      g.strokeStyle = `rgb(${rr(40, 85) | 0},${rr(95, 135) | 0},${rr(30, 50) | 0})`;
      g.lineWidth = rr(2.5, 4);
      g.beginPath(); g.moveTo(cx, y); g.quadraticCurveTo(cx + side * L * 0.5, y + 6, cx + side * L, y + rr(16, 26)); g.stroke();
    }
  }
  g.strokeStyle = '#7d7a3a'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke();
}));

export const barkTex = () => cached('bark', () => canvasTex(64, 256, (g, w, h) => {
  g.fillStyle = '#8f7f66'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 6) { g.fillStyle = `rgba(60,48,35,${rr(0.3, 0.6)})`; g.fillRect(0, y, w, 2); }
  speckle(g, w, h, 30);
}));

export const leafBlobTex = () => cached('leafBlob', () => canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    const v = rr(70, 255) | 0;
    g.fillStyle = `rgb(${v},${v},${(v * 0.9) | 0})`;
    g.beginPath(); g.ellipse(rnd() * w, rnd() * h, rr(3, 8), rr(1.5, 3), rnd() * 3, 0, 7); g.fill();
  }
}));

export const awningTex = () => cached('awning', () => canvasTex(256, 64, (g, w, h) => {
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f2efe6' : '#c8382c'; g.fillRect(i * 32, 0, 32, h); }
  speckle(g, w, h, 12);
}));

export function signTex(text: string, bg = '#1d4a6e', fg = '#f4f1e8') {
  return cached(`sign:${text}:${bg}`, () => canvasTex(1024, 128, (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg; g.font = 'bold 72px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 4);
    speckle(g, w, h, 14);
  }));
}

/**
 * Top-down island surface layers in island-local space: canvas x = local X, canvas y = local Z, both spanning
 * [-R, R]. Local -Z faces the enemy (front), +Z is the back where the bunker sits.
 *  - `overlay` (sRGB RGBA): paint, joints, stains, drains, cracks, litter over the PBR concrete (alpha = coverage)
 *  - `mask` (linear RGB): R = sand, G = grass, B = standing water; `maskData` is the same pixels for CPU scatter.
 *  - `gravel` (linear R): crushed-stone patches; sand and grass sit on top of it.
 */
export function islandSurface(R: number, d: IslandDecor) {
  return cachedSurface(`islandSurface:${R}`, () => {
    const MS = 512;
    let maskData: ImageData | null = null;
    const ms = MS / (2 * R);
    const MP = (m: number) => (m + R) * ms;
    const ell = (g: CanvasRenderingContext2D, P: (m: number) => number, s: number, e: Ellipse, fill: string, soft: number, wob = 0.16) => {
      g.save(); g.translate(P(e.x), P(e.z));
      g.filter = soft > 0 ? `blur(${soft}px)` : 'none';
      g.fillStyle = fill; g.beginPath();
      const ph = rnd() * 6;
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const r = 1 + wob * Math.sin(a * 3 + ph) + wob * 0.45 * Math.sin(a * 7 + ph * 2) + rr(-0.03, 0.03);
        const x = Math.cos(a) * e.rx * s * r, y = Math.sin(a) * e.rz * s * r;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.fill(); g.filter = 'none'; g.restore();
    };
    const mask = canvasTex(MS, MS, (g, w, h) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      for (const e of d.sandBeds) ell(g, MP, ms, e, 'rgb(255,0,0)', 3);
      for (const e of d.grassBeds) ell(g, MP, ms, e, 'rgb(0,255,0)', 2, 0.22);
      for (const e of d.puddles) ell(g, MP, ms, e, 'rgb(0,0,255)', 2, 0.25);
      g.globalCompositeOperation = 'source-over';
      maskData = g.getImageData(0, 0, w, h);
    }, false);
    mask.generateMipmaps = true;
    let gravelData: ImageData | null = null;
    const gravel = canvasTex(MS, MS, (g, w, h) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      for (const e of d.gravel) ell(g, MP, ms, e, 'rgb(255,0,0)', 2.5, 0.22);
      g.globalCompositeOperation = 'source-over';
      gravelData = g.getImageData(0, 0, w, h);
    }, false);

    const overlay = canvasTex(2048, 2048, (g, w, h) => {
      const s = w / (2 * R); // px per metre
      const P = (m: number) => (m + R) * s;
      g.clearRect(0, 0, w, h);
      // weathering: faint dirt drifts + sun-bleached patches
      blotches(g, w, h, 160, '70,64,52', 20, 140, 0.09);
      blotches(g, w, h, 60, '240,236,226', 20, 100, 0.07);
      // saw-cut slab joints every 4.5 m (dark line + lighter chipped edge)
      for (let m = -R; m <= R; m += 4.5) {
        g.strokeStyle = 'rgba(48,44,38,0.55)'; g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(P(m), 0); g.lineTo(P(m), h); g.stroke();
        g.beginPath(); g.moveTo(0, P(m)); g.lineTo(w, P(m)); g.stroke();
        g.strokeStyle = 'rgba(230,226,215,0.25)'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(P(m) + 2, 0); g.lineTo(P(m) + 2, h); g.stroke();
        g.beginPath(); g.moveTo(0, P(m) + 2); g.lineTo(w, P(m) + 2); g.stroke();
      }
      // hairline cracks, often starting at joints
      g.lineCap = 'round';
      for (let c = 0; c < 70; c++) {
        let x = rnd() * w, y = rnd() * h, a = rnd() * 7;
        g.strokeStyle = `rgba(38,34,30,${rr(0.25, 0.55)})`;
        const n = Math.floor(rr(5, 18));
        for (let k = 0; k < n; k++) {
          g.lineWidth = rr(0.8, 1.8) * (1 - k / (n + 4));
          const nx = x + Math.cos(a) * rr(6, 16), ny = y + Math.sin(a) * rr(6, 16);
          g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
          if (rnd() < 0.15) { g.beginPath(); g.moveTo(nx, ny); g.lineTo(nx + rr(-14, 14), ny + rr(-14, 14)); g.stroke(); }
          x = nx; y = ny; a += rr(-0.6, 0.6);
        }
      }
      // oil stains: dark soft core + faint rainbow-free halo
      for (const e of d.oilStains) {
        ell(g, P, s, { ...e, rx: e.rx * 1.5, rz: e.rz * 1.5 }, 'rgba(40,36,30,0.18)', 18, 0.3);
        ell(g, P, s, e, 'rgba(22,20,18,0.55)', 10, 0.3);
        for (let k = 0; k < 5; k++) ell(g, P, s, { x: e.x + rr(-e.rx, e.rx), z: e.z + rr(-e.rz, e.rz), rx: rr(0.1, 0.3), rz: rr(0.08, 0.2) }, 'rgba(15,14,12,0.5)', 4, 0.3);
      }
      // damp rings around puddles
      for (const e of d.puddles) ell(g, P, s, { ...e, rx: e.rx + 0.35, rz: e.rz + 0.3 }, 'rgba(60,56,48,0.35)', 14, 0.25);
      // tyre marks
      g.strokeStyle = 'rgba(30,28,26,0.1)'; g.lineWidth = 9;
      for (let i = 0; i < 9; i++) {
        g.beginPath(); const x = P(rr(-14, 14)), y = P(rr(-14, 10));
        const dx = rr(-300, 300), dy = rr(-300, 300);
        for (const off of [0, 22]) {
          g.moveTo(x + off, y); g.bezierCurveTo(x + off + dx * 0.4, y + dy * 0.4, x + off + dx * 0.8, y + dy * 0.6, x + off + dx * 1.3, y + dy * 1.3);
        }
        g.stroke();
      }
      // sand spill fringe around the sand beds (grains on concrete)
      for (const e of d.sandBeds) for (let k = 0; k < 900; k++) {
        const a = rnd() * 7, r = 0.9 + 0.5 * Math.sqrt(rnd());
        g.fillStyle = `rgba(${rnd() < 0.5 ? '190,170,128' : '150,132,100'},${rr(0.3, 0.7)})`;
        g.fillRect(P(e.x + Math.cos(a) * e.rx * r), P(e.z + Math.sin(a) * e.rz * r), rr(1, 3), rr(1, 3));
      }
      // drain grates (with rust bleed) + manhole covers
      for (const [x, z] of [[-6, -4], [6, -4], [0, -12], [-10, 2], [10, 2]]) {
        const gx = P(x), gz = P(z);
        const gr = g.createRadialGradient(gx, gz + 20, 4, gx, gz + 20, 70);
        gr.addColorStop(0, 'rgba(110,62,30,0.35)'); gr.addColorStop(1, 'rgba(110,62,30,0)');
        g.fillStyle = gr; g.fillRect(gx - 70, gz - 50, 140, 140);
        g.fillStyle = '#5a5a56'; g.fillRect(gx - 16, gz - 28, 32, 56);
        g.fillStyle = '#2c2b29'; g.fillRect(gx - 14, gz - 26, 28, 52);
        g.fillStyle = '#0d0d0c'; for (let k = -22; k < 24; k += 5) g.fillRect(gx - 11, gz + k, 22, 2.6);
      }
      for (const [x, z] of [[-3, -8], [4, 1]]) {
        g.fillStyle = '#4c4a46'; g.beginPath(); g.arc(P(x), P(z), 0.45 * s, 0, 7); g.fill();
        g.strokeStyle = '#2a2927'; g.lineWidth = 3; g.beginPath(); g.arc(P(x), P(z), 0.38 * s, 0, 7); g.stroke();
        g.strokeStyle = 'rgba(30,30,28,0.6)'; g.lineWidth = 2;
        for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(P(x) - 0.3 * s, P(z) + k * 0.08 * s); g.lineTo(P(x) + 0.3 * s, P(z) + k * 0.08 * s); g.stroke(); }
      }
      // litter: cigarette butts, bottle caps, paper scraps
      for (const c of d.clutter) {
        if (c.kind !== 'litter') continue;
        for (let k = 0; k < 9; k++) {
          const x = P(c.x + rr(-1, 1)), y = P(c.z + rr(-1, 1));
          g.save(); g.translate(x, y); g.rotate(rnd() * 7);
          const t = rnd();
          // cigarette butts, bottle caps, a crumpled wrapper — sun-faded
          g.fillStyle = t < 0.5 ? 'rgba(214,206,186,0.85)' : t < 0.75 ? 'rgba(150,110,60,0.8)' : t < 0.9 ? 'rgba(130,60,50,0.75)' : 'rgba(120,130,140,0.7)';
          if (t < 0.5) g.fillRect(-1.8, -0.6, 3.6, 1.2); else if (t < 0.9) { g.beginPath(); g.arc(0, 0, 1.2, 0, 7); g.fill(); } else g.fillRect(-3, -2, 6, 4);
          g.restore();
        }
      }
      // hatched no-build zone in front of the bunker door (+Z side), worn paint
      g.save(); g.translate(P(0), P(R - 7 - 2.3 - 1.4)); g.beginPath(); g.rect(-1.1 * s, -1 * s, 2.2 * s, 2 * s); g.clip();
      g.strokeStyle = 'rgba(232,184,28,0.8)'; g.lineWidth = 0.18 * s;
      for (let k = -4; k <= 4; k++) { g.beginPath(); g.moveTo(k * 0.6 * s - 2 * s, -2 * s); g.lineTo(k * 0.6 * s + 2 * s, 2 * s); g.stroke(); }
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 120; k++) { g.fillStyle = `rgba(0,0,0,${rr(0.2, 0.7)})`; g.fillRect(rr(-1.1, 1.1) * s, rr(-1, 1) * s, rr(2, 9), rr(2, 9)); }
      g.restore();
      // coping band + yellow safety line around the rim (paint chipped)
      const cx = w / 2;
      g.strokeStyle = 'rgba(214,208,196,0.85)'; g.lineWidth = 0.55 * s;
      g.beginPath(); g.arc(cx, cx, (R - 0.28) * s, 0, 7); g.stroke();
      g.strokeStyle = 'rgba(50,46,40,0.7)'; g.lineWidth = 2.5;
      g.beginPath(); g.arc(cx, cx, (R - 0.56) * s, 0, 7); g.stroke();
      g.strokeStyle = 'rgba(232,184,28,0.92)'; g.lineWidth = 0.17 * s;
      g.beginPath(); g.arc(cx, cx, (R - 0.95) * s, 0, 7); g.stroke();
      g.save(); g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 900; k++) {
        const a = rnd() * 7, r = (R - 0.95 + rr(-0.1, 0.1)) * s;
        g.fillStyle = `rgba(0,0,0,${rr(0.3, 0.9)})`; g.fillRect(cx + Math.cos(a) * r, cx + Math.sin(a) * r, rr(1, 6), rr(1, 6));
      }
      g.restore();
      // rust bleed under the rim bollards (14 around the coping, see islands.ts)
      for (let k = 0; k < 14; k++) {
        const a = ((k + 0.5) / 14) * Math.PI * 2;
        const x = cx + Math.sin(a) * (R - 0.45) * s, y = cx + Math.cos(a) * (R - 0.45) * s;
        const gr = g.createRadialGradient(x, y, 6, x, y, 32);
        gr.addColorStop(0, 'rgba(96,52,26,0.5)'); gr.addColorStop(1, 'rgba(96,52,26,0)');
        g.fillStyle = gr; g.fillRect(x - 32, y - 32, 64, 64);
      }
      // salt / tide crust right at the edge
      g.strokeStyle = 'rgba(236,234,226,0.3)'; g.lineWidth = 0.12 * s;
      g.beginPath(); g.arc(cx, cx, (R - 0.06) * s, 0, 7); g.stroke();
    });
    if (!maskData || !gravelData) throw new Error('[world/textures] island mask not drawn');
    return { overlay, mask, gravel, maskData: maskData as ImageData, maskSize: MS };
  });
}

const surfCache = new Map<string, unknown>();
function cachedSurface<T>(key: string, make: () => T): T {
  let v = surfCache.get(key) as T | undefined;
  if (!v) { v = make(); surfCache.set(key, v); }
  return v;
}

/** Island-local footprint of a built-in cover box (container bay markings on the yard top). */
export type Footprint = { x: number; z: number; hx: number; hz: number };

/**
 * Container Yard island top (same frame as islandTopTex: canvas x = local X, canvas y = local Z, ±R):
 * patched asphalt, a concrete coping band, painted lanes, yellow container bays under the cover stacks.
 */
export function yardTopTex(R: number, bays: Footprint[]) {
  const key = `yardTop:${R}:${bays.map((b) => `${b.x.toFixed(1)},${b.z.toFixed(1)}`).join(';')}`;
  return cached(key, () => canvasTex(2048, 2048, (g, w, h) => {
    const r = makeRng(9001);
    const s = w / (2 * R);
    const P = (m: number) => (m + R) * s;
    g.fillStyle = '#6c6a64'; g.fillRect(0, 0, w, h);
    blotches(g, w, h, 300, '40,40,38', 20, 160, 0.18);
    blotches(g, w, h, 120, '150,146,136', 20, 120, 0.12);
    // resurfaced asphalt patches (rectangular, slightly darker or lighter, crisp edges)
    for (let i = 0; i < 9; i++) {
      const x = r.rr(-R * 0.7, R * 0.7), z = r.rr(-R * 0.7, R * 0.7), pw = r.rr(2, 6), ph = r.rr(2, 5);
      g.fillStyle = `rgba(${r.rnd() < 0.5 ? '44,44,42' : '120,116,108'},${r.rr(0.25, 0.45)})`;
      g.fillRect(P(x), P(z), pw * s, ph * s);
    }
    // expansion joints every 6 m
    g.strokeStyle = 'rgba(30,30,28,0.35)'; g.lineWidth = 2;
    for (let m = -R; m <= R; m += 6) {
      g.beginPath(); g.moveTo(P(m), 0); g.lineTo(P(m), h); g.stroke();
      g.beginPath(); g.moveTo(0, P(m)); g.lineTo(w, P(m)); g.stroke();
    }
    // lane lines: dashed white along local Z, solid edge lines
    g.strokeStyle = 'rgba(236,234,226,0.82)'; g.lineWidth = 0.14 * s;
    g.setLineDash([2.2 * s, 1.6 * s]);
    for (const x of [-5.2, 5.2]) { g.beginPath(); g.moveTo(P(x), P(-R + 2)); g.lineTo(P(x), P(R - 9)); g.stroke(); }
    g.setLineDash([]);
    g.strokeStyle = 'rgba(236,234,226,0.6)'; g.lineWidth = 0.1 * s;
    for (const x of [-12.5, 12.5]) { g.beginPath(); g.moveTo(P(x), P(-R + 6)); g.lineTo(P(x), P(R - 6)); g.stroke(); }
    // painted direction arrows in the lanes
    g.fillStyle = 'rgba(236,234,226,0.8)';
    for (const [x, z, dir] of [[-8.6, -6, -1], [8.6, -6, 1], [-8.6, 6, -1], [8.6, 6, 1], [0, -4, -1]] as const) {
      g.save(); g.translate(P(x), P(z)); g.scale(s, s * dir);
      g.beginPath(); g.moveTo(-0.2, 1.4); g.lineTo(-0.2, -0.2); g.lineTo(-0.55, -0.2); g.lineTo(0, -1.1); g.lineTo(0.55, -0.2); g.lineTo(0.2, -0.2); g.lineTo(0.2, 1.4); g.closePath(); g.fill();
      g.restore();
    }
    // zebra crossing across the front lane
    g.fillStyle = 'rgba(236,234,226,0.7)';
    for (let k = -4; k <= 4; k++) g.fillRect(P(k * 1.1 - 0.3), P(-11.5), 0.6 * s, 2.2 * s);
    // container bays: yellow outlines + corner ticks + stencilled numbers
    bays.forEach((b, i) => {
      const pad = 0.35;
      g.strokeStyle = 'rgba(232,184,28,0.9)'; g.lineWidth = 0.16 * s;
      g.strokeRect(P(b.x - b.hx - pad), P(b.z - b.hz - pad), (b.hx + pad) * 2 * s, (b.hz + pad) * 2 * s);
      g.lineWidth = 0.3 * s;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const cx = P(b.x + sx * (b.hx + pad)), cz = P(b.z + sz * (b.hz + pad));
        g.beginPath(); g.moveTo(cx - sx * 0.9 * s, cz); g.lineTo(cx, cz); g.lineTo(cx, cz - sz * 0.9 * s); g.stroke();
      }
      g.fillStyle = 'rgba(232,184,28,0.85)';
      g.font = `bold ${Math.round(0.9 * s)}px "Helvetica Neue", Arial, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const tz = b.hz > b.hx ? b.z - b.hz - pad - 0.9 : b.z + b.hz + pad + 0.8;
      g.fillText(`B${String(i + 1).padStart(2, '0')}`, P(b.x), P(tz));
    });
    // hatched no-build zone in front of the bunker door (+Z side), as on the harbor top
    g.save(); g.translate(P(0), P(R - 7 - 2.3 - 1.4)); g.beginPath(); g.rect(-1.1 * s, -1 * s, 2.2 * s, 2 * s); g.clip();
    g.strokeStyle = 'rgba(232,184,28,0.75)'; g.lineWidth = 0.18 * s;
    for (let k = -4; k <= 4; k++) { g.beginPath(); g.moveTo(k * 0.6 * s - 2 * s, -2 * s); g.lineTo(k * 0.6 * s + 2 * s, 2 * s); g.stroke(); }
    g.restore();
    // oil stains + tyre marks
    blotches(g, w, h, 50, '24,24,22', 10, 60, 0.28);
    g.strokeStyle = 'rgba(28,28,26,0.1)'; g.lineWidth = 9;
    for (let i = 0; i < 10; i++) {
      g.beginPath(); const x = P(r.rr(-14, 14)), y = P(r.rr(-14, 10));
      g.moveTo(x, y); g.bezierCurveTo(x + r.rr(-200, 200), y + r.rr(-200, 200), x + r.rr(-300, 300), y + r.rr(-300, 300), x + r.rr(-400, 400), y + r.rr(-400, 400)); g.stroke();
    }
    // drain grates
    for (const [x, z] of [[-5.2, -14], [5.2, -14], [0, 2], [-12, -2], [12, -2]]) {
      g.fillStyle = '#2e2e2c'; g.fillRect(P(x) - 26, P(z) - 14, 52, 28);
      g.fillStyle = '#151515'; for (let k = -22; k < 24; k += 6) g.fillRect(P(x) + k, P(z) - 11, 3, 22);
    }
    // concrete coping band + yellow safety line around the rim
    const cx = w / 2;
    g.strokeStyle = '#b9b2a4'; g.lineWidth = 1.1 * s;
    g.beginPath(); g.arc(cx, cx, (R - 0.55) * s, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(40,38,34,0.6)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cx, (R - 1.1) * s, 0, 7); g.stroke();
    g.strokeStyle = '#e8b81c'; g.lineWidth = 0.17 * s;
    g.beginPath(); g.arc(cx, cx, (R - 1.45) * s, 0, 7); g.stroke();
    speckle(g, w, h, 22);
  }));
}

/**
 * Center island top in world XZ (canvas x = X, canvas y = Z, ±R; the mesh is not rotated).
 * Harbor: radial concrete paving; yard: asphalt with a painted roundabout. Both mark the shield well
 * and a hatched pad under each station.
 */
export function centerTopTex(R: number, template: 'harbor' | 'yard', stations: { x: number; z: number }[], wellR: number) {
  return cached(`centerTop:${template}:${R}`, () => canvasTex(1024, 1024, (g, w, h) => {
    const r = makeRng(777);
    const s = w / (2 * R);
    const P = (m: number) => (m + R) * s;
    const cx = w / 2;
    const yard = template === 'yard';
    g.fillStyle = yard ? '#6c6a64' : '#aaa395'; g.fillRect(0, 0, w, h);
    blotches(g, w, h, 160, yard ? '40,40,38' : '86,80,68', 10, 80, 0.16);
    blotches(g, w, h, 60, yard ? '150,146,136' : '236,232,220', 10, 60, 0.12);
    if (yard) {
      g.strokeStyle = 'rgba(30,30,28,0.35)'; g.lineWidth = 2;
      for (let m = -R; m <= R; m += 6) {
        g.beginPath(); g.moveTo(P(m), 0); g.lineTo(P(m), h); g.stroke();
        g.beginPath(); g.moveTo(0, P(m)); g.lineTo(w, P(m)); g.stroke();
      }
      // roundabout lane around the well
      g.strokeStyle = 'rgba(236,234,226,0.75)'; g.lineWidth = 0.14 * s;
      g.setLineDash([1.6 * s, 1.2 * s]);
      g.beginPath(); g.arc(cx, cx, 7.3 * s, 0, 7); g.stroke();
      g.setLineDash([]);
    } else {
      // radial paving: rings + spokes
      g.strokeStyle = 'rgba(70,64,55,0.35)'; g.lineWidth = 1.5;
      for (let k = 1; k * 2.2 < R; k++) { g.beginPath(); g.arc(cx, cx, k * 2.2 * s, 0, 7); g.stroke(); }
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * 2.2 * s, cx + Math.sin(a) * 2.2 * s); g.lineTo(cx + Math.cos(a) * R * s, cx + Math.sin(a) * R * s); g.stroke();
      }
    }
    // shield well: dark disc with cyan rings (the glowing ring itself is geometry)
    g.fillStyle = yard ? '#3a3d40' : '#5d6266'; g.beginPath(); g.arc(cx, cx, (wellR + 0.45) * s, 0, 7); g.fill();
    g.strokeStyle = 'rgba(110,220,255,0.75)'; g.lineWidth = 0.12 * s;
    for (const k of [wellR + 0.3, wellR + 0.95]) { g.beginPath(); g.arc(cx, cx, k * s, 0, 7); g.stroke(); }
    g.setLineDash([0.5 * s, 0.4 * s]);
    g.beginPath(); g.arc(cx, cx, (wellR + 1.5) * s, 0, 7); g.stroke();
    g.setLineDash([]);
    // station pads: hatched yellow squares
    for (const st of stations) {
      g.save(); g.translate(P(st.x), P(st.z)); g.rotate(Math.atan2(st.z, st.x));
      g.beginPath(); g.rect(-1.1 * s, -1.1 * s, 2.2 * s, 2.2 * s); g.save(); g.clip();
      g.strokeStyle = 'rgba(214,170,40,0.32)'; g.lineWidth = 0.14 * s;
      for (let k = -6; k <= 6; k++) { g.beginPath(); g.moveTo(k * 0.5 * s - 2 * s, -2 * s); g.lineTo(k * 0.5 * s + 2 * s, 2 * s); g.stroke(); }
      g.restore();
      g.strokeStyle = 'rgba(224,178,36,0.75)'; g.lineWidth = 0.1 * s; g.strokeRect(-1.1 * s, -1.1 * s, 2.2 * s, 2.2 * s);
      g.restore();
    }
    blotches(g, w, h, 20, '30,28,26', 8, 30, 0.2);
    for (let i = 0; i < 4; i++) {
      g.strokeStyle = 'rgba(28,28,26,0.08)'; g.lineWidth = 6;
      g.beginPath(); const a = r.rr(0, 6), rr0 = r.rr(3, R - 2);
      g.arc(cx, cx, rr0 * s, a, a + r.rr(0.5, 2)); g.stroke();
    }
    // coping band + yellow safety line
    g.strokeStyle = yard ? '#b9b2a4' : '#c9c2b4'; g.lineWidth = 0.55 * s;
    g.beginPath(); g.arc(cx, cx, (R - 0.28) * s, 0, 7); g.stroke();
    g.strokeStyle = '#e8b81c'; g.lineWidth = 0.17 * s;
    g.beginPath(); g.arc(cx, cx, (R - 0.95) * s, 0, 7); g.stroke();
    speckle(g, w, h, 20);
  }));
}

/** Chain-link mesh (alpha-tested), one tile ≈ 0.5 m. */
export const chainTex = () => cached('chain', () => canvasTex(64, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#d8dcdf'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();
}));

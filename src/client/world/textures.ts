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
        for (let k = 0; k < 14; k++) {
          const x = P(c.x + rr(-0.8, 0.8)), y = P(c.z + rr(-0.8, 0.8));
          g.save(); g.translate(x, y); g.rotate(rnd() * 7);
          const t = rnd();
          g.fillStyle = t < 0.4 ? 'rgba(235,228,210,0.9)' : t < 0.6 ? 'rgba(200,120,40,0.9)' : t < 0.8 ? 'rgba(170,30,30,0.85)' : 'rgba(60,90,140,0.85)';
          if (t < 0.4) g.fillRect(-4, -1.2, 8, 2.4); else if (t < 0.8) { g.beginPath(); g.arc(0, 0, 1.8, 0, 7); g.fill(); } else g.fillRect(-6, -4, 12, 8);
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
    if (!maskData) throw new Error('[world/textures] island mask not drawn');
    return { overlay, mask, maskData: maskData as ImageData, maskSize: MS };
  });
}

const surfCache = new Map<string, unknown>();
function cachedSurface<T>(key: string, make: () => T): T {
  let v = surfCache.get(key) as T | undefined;
  if (!v) { v = make(); surfCache.set(key, v); }
  return v;
}

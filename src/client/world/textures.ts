import * as THREE from 'three/webgpu';

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

/** Tileable weathered concrete (≈3 m per tile). */
export const concreteTex = () => cached('concrete', () => canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#b0a99b'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 140, '84,78,66', 8, 50, 0.1);
  blotches(g, w, h, 40, '232,228,216', 8, 40, 0.08);
  for (let i = 0; i < 6; i++) { // formwork tie holes in a grid
    for (let j = 0; j < 6; j++) { g.fillStyle = 'rgba(60,56,50,0.5)'; g.beginPath(); g.arc(40 + i * 86, 40 + j * 86, 3, 0, 7); g.fill(); }
  }
  g.fillStyle = 'rgba(70,64,56,0.25)'; g.fillRect(0, 255, w, 2); // pour line
  for (let i = 0; i < 10; i++) { g.fillStyle = `rgba(80,74,64,${rr(0.04, 0.12)})`; g.fillRect(rnd() * w, 0, rr(2, 6), rr(40, 220)); }
  speckle(g, w, h, 24);
}));

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

/** Corrugated steel albedo (grayscale, tint with material/vertex colour). Ribs run along v. */
export const RIBS = 28;
export const corrTex = () => cached('corr', () => canvasTex(512, 256, (g, w, h) => {
  for (let x = 0; x < w; x++) {
    const s = 0.86 + 0.14 * Math.sin((x / w) * RIBS * Math.PI * 2);
    const v = Math.round(228 * s);
    g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, h);
  }
  for (let i = 0; i < 26; i++) {
    const x = rnd() * w, len = rr(40, 200);
    const gr = g.createLinearGradient(0, 0, 0, len);
    gr.addColorStop(0, 'rgba(110,60,30,0.5)'); gr.addColorStop(1, 'rgba(110,60,30,0)');
    g.fillStyle = gr; g.fillRect(x, 0, rr(1, 3), len);
  }
  blotches(g, w, h, 30, '70,60,50', 8, 40, 0.22);
  speckle(g, w, h, 16);
}));

export const corrNormal = () => cached('corrN', () => canvasTex(512, 4, (g, w, h) => {
  const d = g.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const s = Math.cos((x / w) * RIBS * Math.PI * 2) * 0.8, len = Math.hypot(s, 1);
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      d.data[i] = 128 + 127 * (s / len); d.data[i + 1] = 128; d.data[i + 2] = 255 / len; d.data[i + 3] = 255;
    }
  }
  g.putImageData(d, 0, 0);
}, false));

/** Weathered planks running along u (horizontal), 8 boards per tile. */
export const woodTex = () => cached('wood', () => canvasTex(512, 256, (g, w, h) => {
  const n = 8, bh = h / n;
  for (let i = 0; i < n; i++) {
    const b = rr(0.78, 1.1);
    g.fillStyle = `rgb(${(152 * b) | 0},${(114 * b) | 0},${(74 * b) | 0})`; g.fillRect(0, i * bh, w, bh);
    for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(70,45,25,${rr(0.05, 0.22)})`; g.fillRect(0, i * bh + rnd() * bh, w, 1); }
    for (let k = 0; k < 3; k++) { g.fillStyle = 'rgba(60,38,20,0.35)'; g.beginPath(); g.ellipse(rnd() * w, i * bh + rr(4, bh - 4), rr(3, 8), rr(1.5, 3), 0, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(28,18,10,0.85)'; g.fillRect(0, i * bh, w, 2);
    g.fillStyle = 'rgba(40,40,40,0.9)';
    for (const x of [12, w / 2, w - 14]) { g.fillRect(x, i * bh + 6, 3, 3); g.fillRect(x, i * bh + bh - 9, 3, 3); }
  }
  speckle(g, w, h, 20);
}));

export const burlapTex = () => cached('burlap', () => canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = '#c0aa7c'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 2) { g.fillStyle = 'rgba(90,72,45,0.28)'; g.fillRect(0, y, w, 1); }
  for (let x = 0; x < w; x += 2) { g.fillStyle = 'rgba(90,72,45,0.2)'; g.fillRect(x, 0, 1, h); }
  blotches(g, w, h, 10, '90,70,40', 6, 24, 0.3);
  speckle(g, w, h, 30);
}));

export const steelTex = () => cached('steel', () => canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#727a80'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 14, '125,70,38', 10, 50, 0.28);
  blotches(g, w, h, 30, '90,96,100', 10, 60, 0.25);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(205,210,215,${rr(0.05, 0.22)})`;
    g.beginPath(); const x = rnd() * w, y = rnd() * h; g.moveTo(x, y); g.lineTo(x + rr(-30, 30), y + rr(-8, 8)); g.stroke();
  }
  speckle(g, w, h, 14);
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

/** Crack mask: R = crack "rank" (0 = none). A crack pixel shows once damage ≥ 1 - rank. */
export const crackTex = () => cached('crack', () => canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.lineCap = 'round';
  for (let c = 0; c < 22; c++) {
    const rank = rr(0.15, 1);
    let x = rnd() * w, y = rnd() * h, a = rnd() * Math.PI * 2;
    const v = Math.round(rank * 255);
    g.strokeStyle = `rgb(${v},${v},${v})`;
    for (let s = 0; s < 14; s++) {
      g.lineWidth = rr(1, 2.6) * (1 - s / 18);
      const nx = x + Math.cos(a) * rr(6, 14), ny = y + Math.sin(a) * rr(6, 14);
      g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
      x = nx; y = ny; a += rr(-0.7, 0.7);
    }
  }
}, false));

/** Fine concrete grain for close-up detail (multiplied on top of large painted maps). ~0.5 avg. */
export const grainTex = () => cached('grain', () => canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 40, '60,60,60', 6, 30, 0.25);
  blotches(g, w, h, 40, '200,200,200', 6, 30, 0.2);
  speckle(g, w, h, 40);
}, false));

/**
 * Top-down painted island surface in island-local space: canvas x = local X, canvas y = local Z, both
 * spanning [-R, R]. Local -Z faces the enemy (front), +Z is the back where the bunker sits.
 */
export function islandTopTex(R: number) {
  return cached(`islandTop:${R}`, () => canvasTex(2048, 2048, (g, w, h) => {
    const s = w / (2 * R); // px per metre
    const P = (m: number) => (m + R) * s;
    // base concrete
    g.fillStyle = '#a7a092'; g.fillRect(0, 0, w, h);
    blotches(g, w, h, 260, '86,80,68', 20, 140, 0.16);
    blotches(g, w, h, 120, '236,232,220', 20, 100, 0.12);
    // slab joints every 4.5 m
    g.strokeStyle = 'rgba(70,64,55,0.32)'; g.lineWidth = 1.6;
    for (let m = -R; m <= R; m += 4.5) {
      g.beginPath(); g.moveTo(P(m), 0); g.lineTo(P(m), h); g.stroke();
      g.beginPath(); g.moveTo(0, P(m)); g.lineTo(w, P(m)); g.stroke();
    }
    // sand + grass beds in the back corners (flat, purely visual)
    // sand + grass beds in the back corners (flat, purely visual): noisy outlines, soft edges, grain
    const blob = (cx: number, cz: number, rx: number, rz: number, fill: string, soft: number) => {
      g.save(); g.translate(P(cx), P(cz));
      g.filter = `blur(${soft}px)`;
      g.fillStyle = fill; g.beginPath();
      const ph = rnd() * 6;
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const r = 1 + 0.16 * Math.sin(a * 3 + ph) + 0.07 * Math.sin(a * 7 + ph * 2) + rr(-0.03, 0.03);
        const x = Math.cos(a) * rx * s * r, y = Math.sin(a) * rz * s * r;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.fill(); g.filter = 'none'; g.restore();
    };
    for (const sx of [-1, 1]) {
      blob(sx * 13, 9, 4.6, 3.4, 'rgba(214,196,150,0.95)', 10);
      for (let k = 0; k < 400; k++) { // sand grain + pebbles
        const a = rnd() * 7, r = Math.sqrt(rnd());
        g.fillStyle = `rgba(${rnd() < 0.5 ? '120,105,80' : '245,235,205'},${rr(0.2, 0.5)})`;
        g.fillRect(P(sx * 13 + Math.cos(a) * 3.8 * r), P(9 + Math.sin(a) * 2.8 * r), rr(1, 3), rr(1, 3));
      }
      blob(sx * 12.6, 9.4, 2.7, 2.0, 'rgba(98,128,58,0.9)', 6);
      for (let k = 0; k < 1500; k++) { // grass blades
        const a = rnd() * 7, r = Math.sqrt(rnd());
        const x = P(sx * 12.6 + Math.cos(a) * 2.4 * r), y = P(9.4 + Math.sin(a) * 1.75 * r);
        g.strokeStyle = `rgba(${rr(60, 120) | 0},${rr(110, 160) | 0},${rr(40, 70) | 0},0.7)`;
        g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + rr(-3, 3), y + rr(-5, -1)); g.stroke();
      }
    }
    blob(0, 5.2, 3.2, 1.5, 'rgba(206,190,146,0.85)', 9);
    // oil stains / tyre marks
    blotches(g, w, h, 40, '40,38,34', 10, 50, 0.22);
    g.strokeStyle = 'rgba(40,38,34,0.07)'; g.lineWidth = 7;
    for (let i = 0; i < 8; i++) {
      g.beginPath(); const x = P(rr(-14, 14)), y = P(rr(-14, 10));
      g.moveTo(x, y); g.bezierCurveTo(x + rr(-200, 200), y + rr(-200, 200), x + rr(-300, 300), y + rr(-300, 300), x + rr(-400, 400), y + rr(-400, 400)); g.stroke();
    }
    // drain grates + manhole covers
    for (const [x, z] of [[-6, -4], [6, -4], [0, -12], [-10, 2], [10, 2]]) {
      g.fillStyle = '#3b3b3a'; g.fillRect(P(x) - 14, P(z) - 26, 28, 52);
      g.fillStyle = '#1e1e1e'; for (let k = -22; k < 24; k += 6) g.fillRect(P(x) - 11, P(z) + k, 22, 3);
    }
    for (const [x, z] of [[-3, -8], [4, 1]]) {
      g.fillStyle = '#4a4946'; g.beginPath(); g.arc(P(x), P(z), 0.45 * s, 0, 7); g.fill();
      g.strokeStyle = '#2e2d2b'; g.lineWidth = 3; g.beginPath(); g.arc(P(x), P(z), 0.38 * s, 0, 7); g.stroke();
    }
    // hatched no-build zone in front of the bunker door (+Z side) is just paint
    g.save(); g.translate(P(0), P(R - 7 - 2.3 - 1.4)); g.beginPath(); g.rect(-1.1 * s, -1 * s, 2.2 * s, 2 * s); g.clip();
    g.strokeStyle = 'rgba(232,184,28,0.75)'; g.lineWidth = 0.18 * s;
    for (let k = -4; k <= 4; k++) { g.beginPath(); g.moveTo(k * 0.6 * s - 2 * s, -2 * s); g.lineTo(k * 0.6 * s + 2 * s, 2 * s); g.stroke(); }
    g.restore();
    // coping band + yellow safety line around the rim
    const cx = w / 2;
    g.strokeStyle = '#c9c2b4'; g.lineWidth = 0.55 * s;
    g.beginPath(); g.arc(cx, cx, (R - 0.28) * s, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(60,55,48,0.6)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cx, (R - 0.56) * s, 0, 7); g.stroke();
    g.strokeStyle = '#e8b81c'; g.lineWidth = 0.17 * s;
    g.beginPath(); g.arc(cx, cx, (R - 0.95) * s, 0, 7); g.stroke();
    speckle(g, w, h, 20);
  }));
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

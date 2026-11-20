// FAEFight v1 look-target concept shot. Procedural only (plus MIT waternormals.jpg).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const Y_UP = V(0, 1, 0);
let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const rr = (a, b) => a + (b - a) * rnd();

// ---------- renderer / scene ----------
const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
window.__gl = renderer.getContext().getParameter(renderer.getContext().VERSION);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xa8c8de, 0.0021);
const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 3000);

// ---------- sun / sky ----------
const sunElev = 34, sunAz = 58;
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - sunElev), THREE.MathUtils.degToRad(sunAz));
const sky = new Sky();
sky.scale.setScalar(10000);
const su = sky.material.uniforms;
su.turbidity.value = 6; su.rayleigh.value = 1.6; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.85;
su.sunPosition.value.copy(sunDir);
su.cloudCoverage.value = 0.35; su.cloudDensity.value = 0.5; su.cloudScale.value = 0.00025; su.time.value = 40;
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const sky2 = new Sky(); sky2.scale.setScalar(10000);
Object.assign(sky2.material.uniforms.sunPosition.value, sunDir);
for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) sky2.material.uniforms[k].value = su[k].value;
sky2.material.uniforms.cloudCoverage.value = 0;
envScene.add(sky2);
scene.environment = pmrem.fromScene(envScene).texture;
scene.environmentIntensity = 0.28;

const sun = new THREE.DirectionalLight(0xffe6c2, 5.0);
const shadowCenter = V(0, 0, -30);
sun.position.copy(shadowCenter).addScaledVector(sunDir, 160);
sun.target.position.copy(shadowCenter);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 400 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x8a7a58, 0.28));
if (location.search.includes('dbg')) { scene.environmentIntensity = 0; scene.children.at(-1).intensity = 0; }

// ---------- canvas textures ----------
function canvasTex(w, h, draw, { srgb = true, repeat = [1, 1] } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function speckle(g, w, h, amp) {
  const d = g.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) { const n = (rnd() - 0.5) * amp; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; }
  g.putImageData(d, 0, 0);
}
function blotches(g, w, h, n, rgb, rmin, rmax, amax) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = rr(rmin, rmax);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${rr(0, amax)})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}
const clone = (t, rx, ry) => { const c = t.clone(); c.repeat.set(rx, ry); c.needsUpdate = true; return c; };

const concreteTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#aba496'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 90, '80,74,62', 20, 90, 0.25);
  blotches(g, w, h, 30, '230,226,215', 20, 70, 0.15);
  speckle(g, w, h, 26);
  g.strokeStyle = 'rgba(60,55,48,0.45)'; g.lineWidth = 2;
  g.strokeRect(1, 1, w - 2, h - 2); g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
});
const plainConcrete = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#aaa396'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 70, '80,74,64', 15, 80, 0.28); speckle(g, w, h, 22);
  for (let i = 0; i < 12; i++) { g.fillStyle = `rgba(80,74,64,${rr(0.05, 0.15)})`; g.fillRect(rnd() * w, 0, rr(2, 6), rr(40, 200)); }
});
const seawallTex = canvasTex(256, 512, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#9d9587'); gr.addColorStop(0.18, '#857d70'); gr.addColorStop(0.24, '#4f5a44'); gr.addColorStop(0.3, '#2d3328'); gr.addColorStop(1, '#1e231d');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(60,55,45,${rr(0.05, 0.2)})`; g.fillRect(rnd() * w, 0, rr(1, 4), rr(30, 120)); }
  speckle(g, w, h, 20);
});
// corrugated steel: grayscale albedo (tinted per material) + matching normal map
const RIBS = 28;
const corrTex = canvasTex(512, 256, (g, w, h) => {
  for (let x = 0; x < w; x++) { const s = 0.86 + 0.14 * Math.sin((x / w) * RIBS * Math.PI * 2); const v = Math.round(225 * s); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, h); }
  for (let i = 0; i < 26; i++) { const x = rnd() * w; const gr = g.createLinearGradient(0, 0, 0, rr(40, 200)); gr.addColorStop(0, 'rgba(90,50,25,0.55)'); gr.addColorStop(1, 'rgba(90,50,25,0)'); g.fillStyle = gr; g.fillRect(x, 0, rr(1, 3), 220); }
  blotches(g, w, h, 30, '70,60,50', 8, 40, 0.25);
  g.fillStyle = 'rgba(40,40,40,0.55)'; g.fillRect(0, 0, w, 8); g.fillRect(0, h - 10, w, 10); g.fillRect(0, 0, 8, h); g.fillRect(w - 8, 0, 8, h);
  speckle(g, w, h, 18);
});
const corrNormal = canvasTex(512, 4, (g, w, h) => {
  const d = g.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const s = Math.cos((x / w) * RIBS * Math.PI * 2) * 0.75; const len = Math.hypot(s, 1);
    for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; d.data[i] = 128 + 127 * (s / len); d.data[i + 1] = 128; d.data[i + 2] = 255 * (1 / len); d.data[i + 3] = 255; }
  }
  g.putImageData(d, 0, 0);
}, { srgb: false });
const woodTex = canvasTex(256, 512, (g, w, h) => {
  const n = 8, bw = w / n;
  for (let i = 0; i < n; i++) {
    const b = rr(0.8, 1.1); g.fillStyle = `rgb(${150 * b | 0},${112 * b | 0},${72 * b | 0})`; g.fillRect(i * bw, 0, bw, h);
    for (let k = 0; k < 30; k++) { g.fillStyle = `rgba(70,45,25,${rr(0.05, 0.2)})`; g.fillRect(i * bw + rnd() * bw, 0, 1, h); }
    g.fillStyle = 'rgba(30,20,12,0.8)'; g.fillRect(i * bw, 0, 2, h);
  }
  speckle(g, w, h, 20);
});
const burlapTex = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = '#b29d73'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 2) { g.fillStyle = 'rgba(90,72,45,0.25)'; g.fillRect(0, y, w, 1); }
  for (let x = 0; x < w; x += 2) { g.fillStyle = 'rgba(90,72,45,0.18)'; g.fillRect(x, 0, 1, h); }
  speckle(g, w, h, 30);
});
const steelTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#6d7479'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 18, '120,70,40', 8, 40, 0.45);
  for (let i = 0; i < 60; i++) { g.strokeStyle = `rgba(200,205,210,${rr(0.05, 0.25)})`; g.beginPath(); const x = rnd() * w, y = rnd() * h; g.moveTo(x, y); g.lineTo(x + rr(-30, 30), y + rr(-8, 8)); g.stroke(); }
  speckle(g, w, h, 16);
});
const frondTex = canvasTex(128, 512, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  const cx = w / 2;
  for (let y = 10; y < h - 4; y += 5) {
    const t = y / h; const L = (w / 2 - 4) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.6) * (1 - 0.25 * t);
    for (const side of [-1, 1]) {
      const gcol = `rgb(${rr(40, 85) | 0},${rr(95, 135) | 0},${rr(30, 50) | 0})`;
      g.strokeStyle = gcol; g.lineWidth = rr(2.5, 4); g.beginPath(); g.moveTo(cx, y); g.quadraticCurveTo(cx + side * L * 0.5, y + 6, cx + side * L, y + rr(16, 26)); g.stroke();
    }
  }
  g.strokeStyle = '#7d7a3a'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke();
});
const barkTex = canvasTex(64, 256, (g, w, h) => {
  g.fillStyle = '#8a7a62'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 6) { g.fillStyle = `rgba(60,48,35,${rr(0.3, 0.6)})`; g.fillRect(0, y, w, 2); }
  speckle(g, w, h, 30);
}, { repeat: [2, 8] });
const awningTex = canvasTex(256, 64, (g, w, h) => { for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f2efe6' : '#c8382c'; g.fillRect(i * 32, 0, 32, h); } speckle(g, w, h, 12); });
const signTex = canvasTex(1024, 128, (g, w, h) => {
  g.fillStyle = '#1d4a6e'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#f4f1e8'; g.font = 'bold 76px Helvetica Neue, Arial'; g.textBaseline = 'middle'; g.fillText('PALMERA FREIGHT  ·  PIER 4', 40, h / 2 + 4);
  speckle(g, w, h, 14);
});

const leafBlobTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) { const v = rr(70, 255) | 0; g.fillStyle = `rgb(${v},${v},${v * 0.9 | 0})`; g.beginPath(); g.ellipse(rnd() * w, rnd() * h, rr(3, 8), rr(1.5, 3), rnd() * 3, 0, 7); g.fill(); }
});
const fabricTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#d0d0d0'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 40, '90,90,80', 10, 40, 0.35); blotches(g, w, h, 30, '255,255,240', 10, 30, 0.2);
  for (let y = 0; y < h; y += 3) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, y, w, 1); }
  speckle(g, w, h, 28);
}, { repeat: [2, 2] });
// ---------- materials ----------
const M = {
  concrete: new THREE.MeshStandardMaterial({ map: plainConcrete, roughness: 0.92 }),
  bunker: new THREE.MeshStandardMaterial({ map: clone(plainConcrete, 1.2, 1), color: 0xd8d2c4, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.6 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x2a2a28, roughness: 0.9 }),
  galv: new THREE.MeshStandardMaterial({ color: 0xa4abb0, metalness: 0.85, roughness: 0.38 }),
  wood: new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.8 }),
  burlap: new THREE.MeshStandardMaterial({ map: burlapTex, roughness: 0.95 }),
  steel: new THREE.MeshStandardMaterial({ map: steelTex, metalness: 0.75, roughness: 0.42 }),
  frond: new THREE.MeshStandardMaterial({ map: frondTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 }),
  bark: new THREE.MeshStandardMaterial({ map: barkTex, roughness: 0.95 }),
  craneRed: new THREE.MeshStandardMaterial({ color: 0xc9461f, roughness: 0.55, metalness: 0.3 }),
  craneWhite: new THREE.MeshStandardMaterial({ color: 0xe9e6de, roughness: 0.5, metalness: 0.2 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xe8b81c, roughness: 0.6 }),
  roof: new THREE.MeshStandardMaterial({ map: clone(corrTex, 6, 1), normalMap: clone(corrNormal, 6, 1), color: 0x8c9196, metalness: 0.6, roughness: 0.45 }),
  glow: new THREE.MeshStandardMaterial({ color: 0x113311, emissive: 0x39ff6a, emissiveIntensity: 12 }),
  cash: new THREE.MeshStandardMaterial({ color: 0x6fae6a, roughness: 0.8 }),
  awning: new THREE.MeshStandardMaterial({ map: awningTex, roughness: 0.8, side: THREE.DoubleSide }),
  sign: new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.7 }),
};
const containerMats = [0x9a3b2a, 0x1f4e79, 0x2f6b3a, 0xc8641e, 0xd6d4cc, 0x2a7f86, 0x7d2430, 0x46505a].map((c) =>
  new THREE.MeshStandardMaterial({ map: corrTex, normalMap: corrNormal, normalScale: new THREE.Vector2(1.2, 1.2), color: c, metalness: 0.45, roughness: 0.55 }));

let ROOT = scene;
function mesh(geo, mat, x = 0, y = 0, z = 0, parent = ROOT) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r, h, s = 12) => new THREE.CylinderGeometry(r, r, h, s);

// ---------- quays (islands) ----------
function quay(x0, x1, z0, z1, top, mat = M.concrete) {
  const w = x1 - x0, d = z1 - z0, hgt = top + 8;
  const sideX = new THREE.MeshStandardMaterial({ map: clone(seawallTex, d / 6, 1), roughness: 0.9 });
  const sideZ = new THREE.MeshStandardMaterial({ map: clone(seawallTex, w / 6, 1), roughness: 0.9 });
  const topM = new THREE.MeshStandardMaterial({ map: clone(concreteTex, w / 6, d / 6), roughness: 0.93 });
  const m = mesh(box(w, hgt, d), [sideX, sideX, topM, topM, sideZ, sideZ], (x0 + x1) / 2, top - hgt / 2, (z0 + z1) / 2);
  return m;
}
function edgeDetails(x0, x1, z, top, faceSign) {
  // bollards, fenders, yellow edge paint along a quay edge running along x
  for (let x = x0 + 3; x < x1 - 1; x += 7) {
    mesh(cyl(0.18, 0.5), M.dark, x, top + 0.25, z - faceSign * 0.6);
    mesh(new THREE.SphereGeometry(0.22, 12, 8), M.dark, x, top + 0.5, z - faceSign * 0.6).scale.y = 0.6;
  }
  for (let x = x0 + 2; x < x1; x += 4.5) mesh(box(0.5, 1.0, 0.25), M.rubber, x, top - 0.9, z + faceSign * 0.12);
  const paint = mesh(box(x1 - x0, 0.01, 0.18), M.yellow, (x0 + x1) / 2, top + 0.005, z - faceSign * 0.25);
  paint.castShadow = false;
}
function edgeDetailsZ(z0, z1, x, top, faceSign) {
  for (let z = z0 + 3; z < z1 - 1; z += 7) { mesh(cyl(0.18, 0.5), M.dark, x - faceSign * 0.6, top + 0.25, z); }
  for (let z = z0 + 2; z < z1; z += 4.5) mesh(box(0.25, 1.0, 0.5), M.rubber, x + faceSign * 0.12, top - 0.9, z);
  mesh(box(0.18, 0.01, z1 - z0), M.yellow, x - faceSign * 0.25, top + 0.005, (z0 + z1) / 2).castShadow = false;
}

// ---------- props ----------
function container(x, y, z, rotY, mi) {
  const m = mesh(box(6.06, 2.59, 2.44), containerMats[mi % containerMats.length], x, y + 1.295, z);
  m.rotation.y = rotY; return m;
}
function containerStack(x, y, z, rotY, heights, spacing = 2.6) {
  heights.forEach((n, i) => {
    for (let k = 0; k < n; k++) {
      const off = new THREE.Vector3(0, 0, i * spacing).applyAxisAngle(Y_UP, rotY);
      container(x + off.x + rr(-0.05, 0.05), y + k * 2.59, z + off.z, rotY + rr(-0.015, 0.015), Math.floor(rnd() * 8));
    }
  });
}
function sandbagWall(x, y, z, rotY, width = 2, rows = 6, parent = ROOT) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rotY; parent.add(g);
  const geo = new RoundedBoxGeometry(1, 1, 1, 3, 0.32);
  const per = Math.round(width / 0.5);
  for (let r = 0; r < rows; r++) for (let d = 0; d < 2; d++) for (let i = 0; i < per + (r % 2 ? -1 : 0); i++) {
    const m = mesh(geo, M.burlap, -width / 2 + 0.25 + i * 0.5 + (r % 2 ? 0.25 : 0) + rr(-0.03, 0.03), 0.09 + r * 0.155, (d - 0.5) * 0.36 + rr(-0.02, 0.02), g);
    m.scale.set(0.5 * rr(0.94, 1.02), 0.16 * rr(0.9, 1.05), 0.33); m.rotation.y = rr(-0.08, 0.08); m.rotation.z = rr(-0.04, 0.04);
  }
  return g;
}
function bunker(x, y, z) {
  const g = new THREE.Group(); g.position.set(x, y, z); ROOT.add(g);
  const T = 0.3, IN = 4, OUT = IN + 2 * T, Hh = 2.6, DW = 1.6, DH = 2.1, side = (OUT - DW) / 2;
  const wall = (w, h, d, px, py, pz) => mesh(box(w, h, d), M.bunker, px, py, pz, g);
  // back wall (-z) solid
  wall(OUT, Hh, T, 0, Hh / 2, -OUT / 2 + T / 2);
  // front (+z), left (-x), right (+x) each with centered doorway
  for (const [ax, sgn] of [['z', 1], ['x', -1], ['x', 1]]) {
    const pos = sgn * (OUT / 2 - T / 2);
    for (const s of [-1, 1]) {
      const c = s * (DW / 2 + side / 2);
      if (ax === 'z') wall(side, Hh, T, c, Hh / 2, pos); else wall(T, Hh, side, pos, Hh / 2, c);
    }
    if (ax === 'z') wall(DW, Hh - DH, T, 0, DH + (Hh - DH) / 2, pos); else wall(T, Hh - DH, DW, pos, DH + (Hh - DH) / 2, 0);
  }
  wall(OUT + 0.2, 0.3, OUT + 0.2, 0, Hh + 0.15, 0); // roof slab
  mesh(box(IN, 0.02, IN), M.dark, 0, 0.01, 0, g);
  return g;
}
function scaffoldBridge(x, y, z0, len = 4, wid = 2) {
  const g = new THREE.Group(); g.position.set(x, y, z0); ROOT.add(g);
  const deck = mesh(box(wid, 0.06, len), M.wood, 0, 0, -len / 2, g);
  deck.material = new THREE.MeshStandardMaterial({ map: clone(woodTex, 1, 1), roughness: 0.8, color: 0xd8b98a });
  for (const sx of [-1, 1]) {
    for (const zz of [0, -len / 2, -len]) {
      mesh(cyl(0.045, y + 3 + 1.05, 8), M.galv, sx * wid / 2, (1.05 - (y + 3)) / 2, zz, g);
    }
    for (const hy of [0.5, 1.0]) { const r = mesh(cyl(0.035, len, 8), M.galv, sx * wid / 2, hy, -len / 2, g); r.rotation.x = Math.PI / 2; }
    const toe = mesh(box(0.03, 0.15, len), M.yellow, sx * (wid / 2 - 0.02), 0.1, -len / 2, g); toe.castShadow = false;
    const br = mesh(cyl(0.03, Math.hypot(len / 2, 1.6), 6), M.galv, sx * wid / 2, -0.85, -len / 4, g); br.rotation.x = Math.atan2(len / 2, 1.6);
    const br2 = mesh(cyl(0.03, Math.hypot(len / 2, 1.6), 6), M.galv, sx * wid / 2, -0.85, -3 * len / 4, g); br2.rotation.x = -Math.atan2(len / 2, 1.6);
  }
  for (const zz of [0, -len]) { const t = mesh(cyl(0.035, wid, 8), M.galv, 0, -0.08, zz, g); t.rotation.z = Math.PI / 2; }
  return g;
}
// palm tree
const frondGeo = (() => {
  const N = 14, L = 3.6, positions = [], uvs = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, s = t * L, up = s * 0.55 - s * s * 0.17, hw = 0.75;
    for (let j = 0; j < 3; j++) { const u = j / 2, xw = (u - 0.5) * 2 * hw; positions.push(s, up - Math.abs(xw) * 0.28, xw); uvs.push(u, t); }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < 2; j++) { const a = i * 3 + j, b = a + 1, c = a + 3, d = a + 4; idx.push(a, c, b, b, c, d); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx); geo.computeVertexNormals(); return geo;
})();
function palm(x, y, z, h = 9, lean = 2, rotY = 0) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rotY; ROOT.add(g);
  const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(V(lean * t * t, t * h, 0)); }
  const curve = new THREE.CatmullRomCurve3(pts);
  const tube = new THREE.TubeGeometry(curve, 24, 0.17, 10);
  const pos = tube.attributes.position; // taper toward top
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / h, c = curve.getPoint(Math.min(1, Math.max(0, t))), k = 1.25 - 0.45 * t;
    pos.setXYZ(i, c.x + (pos.getX(i) - c.x) * k, pos.getY(i), c.z + (pos.getZ(i) - c.z) * k);
  }
  tube.computeVertexNormals();
  mesh(tube, M.bark, 0, 0, 0, g);
  const top = curve.getPoint(1);
  const n = 13;
  for (let k = 0; k < n; k++) {
    const f = mesh(frondGeo, M.frond, top.x, top.y, top.z, g);
    f.rotation.order = 'YZX';
    f.rotation.y = (k / n) * Math.PI * 2 + rr(-0.2, 0.2);
    f.rotation.z = rr(-0.35, 0.25);
    f.scale.setScalar(rr(0.85, 1.1));
  }
  for (let k = 0; k < 5; k++) mesh(new THREE.SphereGeometry(0.13, 8, 6), M.dark, top.x + rr(-0.2, 0.2), top.y - 0.25, top.z + rr(-0.2, 0.2), g).material = new THREE.MeshStandardMaterial({ color: 0x4b3a1f, roughness: 0.8 });
  return g;
}
function craneSTS(x, y, z, rotY, boomOut = 45) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rotY; ROOT.add(g);
  const LH = 28, gx = 8, gz = 8;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) mesh(box(1.1, LH, 1.1), M.craneRed, sx * gx, LH / 2, sz * gz, g);
  for (const sx of [-1, 1]) { mesh(box(1.2, 1.4, 2 * gz + 1.2), M.craneRed, sx * gx, LH, 0, g); mesh(box(1, 1, 2 * gz), M.craneRed, sx * gx, 10, 0, g); const d = mesh(box(0.5, Math.hypot(2 * gz, LH - 12), 0.5), M.craneRed, sx * gx, (LH + 10) / 2, 0, g); d.rotation.x = Math.atan2(2 * gz, LH - 12); }
  for (const sz of [-1, 1]) mesh(box(2 * gx + 1, 1.4, 1.1), M.craneRed, 0, LH, sz * gz, g);
  // boom along +z (over water) and back-reach
  mesh(box(3, 2.2, boomOut + gz + 18), M.craneWhite, 0, LH + 3, (boomOut + gz - 18) / 2 + 0, g);
  mesh(box(8, 4.5, 7), M.craneWhite, 0, LH + 1.8, -gz - 4, g); // machinery house
  mesh(box(4, 2.5, 3.5), M.craneWhite, -2.5, LH + 0.3, gz + 1, g); // cab
  for (const sx of [-1, 1]) { const a = mesh(box(0.7, 14, 0.7), M.craneRed, sx * 2, LH + 10, 0, g); a.rotation.z = -sx * 0.12; }
  const tie = (a, b) => { const d = b.clone().sub(a); const m = mesh(cyl(0.12, d.length(), 6), M.dark, 0, 0, 0, g); m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(Y_UP, d.normalize()); };
  tie(V(0, LH + 16.5, 0), V(0, LH + 4, boomOut * 0.95)); tie(V(0, LH + 16.5, 0), V(0, LH + 4, boomOut * 0.5)); tie(V(0, LH + 16.5, 0), V(0, LH + 4, -gz - 10));
  return g;
}
function lightMast(x, y, z) { mesh(cyl(0.18, 18, 8), M.galv, x, y + 9, z); mesh(box(1.8, 0.6, 0.4), M.dark, x, y + 18.2, z); }

// ---------- characters ----------
function limb(a, b, r, mat, parent) {
  const d = b.clone().sub(a), len = d.length();
  const m = mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len), 6, 12), mat, 0, 0, 0, parent);
  m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(Y_UP, d.normalize()); return m;
}
function rifle(parent, butt, muzzleDir) {
  const g = new THREE.Group(); parent.add(g); g.position.copy(butt);
  g.quaternion.setFromUnitVectors(V(0, 0, -1), muzzleDir.clone().normalize());
  const gm = new THREE.MeshStandardMaterial({ color: 0x2a2c2b, metalness: 0.5, roughness: 0.45 });
  const tan = new THREE.MeshStandardMaterial({ color: 0x8c7b5c, roughness: 0.7 });
  mesh(box(0.05, 0.1, 0.24), tan, 0, -0.02, -0.12, g); // stock
  mesh(box(0.06, 0.09, 0.36), gm, 0, 0.0, -0.42, g); // receiver
  mesh(box(0.065, 0.075, 0.3), tan, 0, 0.0, -0.74, g); // handguard
  const b = mesh(cyl(0.012, 0.32, 8), gm, 0, 0.01, -1.02, g); b.rotation.x = Math.PI / 2;
  const mag = mesh(box(0.035, 0.18, 0.08), gm, 0, -0.11, -0.46, g); mag.rotation.x = 0.25;
  const sc = mesh(cyl(0.022, 0.18, 10), gm, 0, 0.075, -0.45, g); sc.rotation.x = Math.PI / 2;
  mesh(box(0.035, 0.1, 0.04), gm, 0, -0.07, -0.33, g); // grip
  return g;
}
function person(p, cols, x, y, z, rotY) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rotY; ROOT.add(g);
  const mat = (c, r = 0.85, map = fabricTex) => new THREE.MeshStandardMaterial({ color: c, roughness: r, map });
  const shirt = mat(cols.shirt), pants = mat(cols.pants), skin = mat(cols.skin, 0.6, null), boots = mat(0x2a2522), vest = mat(cols.vest), cap = mat(cols.cap);
  for (const s of [-1, 1]) {
    const L = s < 0 ? p.legL : p.legR;
    const hip = V(s * 0.1, 0.95, 0);
    limb(hip, L[0], 0.082, pants, g); limb(L[0], L[1], 0.062, pants, g);
    const bt = mesh(box(0.11, 0.1, 0.26), boots, L[1].x, Math.max(0.05, L[1].y - 0.04), L[1].z - 0.05, g); bt.rotation.x = L[2] || 0;
  }
  const pel = mesh(new THREE.SphereGeometry(1, 16, 12), pants, 0, 0.97, 0, g); pel.scale.set(0.17, 0.12, 0.12);
  const lean = p.lean || 0;
  const torso = mesh(new THREE.CapsuleGeometry(0.15, 0.32, 6, 16), shirt, 0, 1.2, -lean * 0.12, g); torso.scale.set(1.3, 1, 0.85); torso.rotation.x = -lean;
  const v = mesh(new THREE.CapsuleGeometry(0.15, 0.2, 6, 16), vest, 0, 1.26, -lean * 0.14, g); v.scale.set(1.38, 1, 0.98); v.rotation.x = -lean;
  if (cols.pack) { const bp = mesh(new THREE.CapsuleGeometry(0.1, 0.16, 4, 10), vest, 0, 1.25, 0.13 - lean * 0.12, g); bp.scale.set(1.25, 1, 0.55); bp.rotation.x = -lean; }
  limb(V(0, 1.42, -lean * 0.3), V(0, 1.52, -lean * 0.35 - 0.02), 0.05, skin, g);
  const hc = V(0, 1.62, -lean * 0.4 - 0.04);
  const head = mesh(new THREE.SphereGeometry(0.105, 20, 16), cols.hair ? mat(cols.hair, 0.9) : skin, hc.x, hc.y, hc.z, g); head.scale.set(1, 1.12, 1.08);
  const c = mesh(new THREE.SphereGeometry(cols.helmet ? 0.13 : 0.118, 20, 12, 0, Math.PI * 2, 0, cols.helmet ? Math.PI * 0.62 : Math.PI / 2), cap, hc.x, hc.y + 0.02, hc.z, g); c.scale.set(1, 0.95, 1.08);
  if (cols.helmet) mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 14), cap, hc.x, hc.y - 0.17, hc.z + 0.01, g);
  if (cols.brim) { const br = mesh(box(0.17, 0.015, 0.1), cap, hc.x, hc.y + 0.03, hc.z - 0.14, g); }
  for (const s of [-1, 1]) { mesh(new THREE.SphereGeometry(0.075, 12, 10), shirt, s * 0.19, 1.4, -lean * 0.28, g); }
  if (cols.pack) for (const s of [-1, 1]) { const pc = mesh(box(0.1, 0.12, 0.07), vest, s * 0.17, 1.06, 0.12 - lean * 0.1, g); }
  for (const s of [-1, 1]) {
    const A = s < 0 ? p.armL : p.armR; const sh = V(s * 0.2, 1.4, -lean * 0.28);
    limb(sh, A[0], 0.058, shirt, g); limb(A[0], A[1], 0.048, shirt, g);
    mesh(new THREE.SphereGeometry(0.048, 10, 8), mat(0x2b2b2b), A[1].x, A[1].y, A[1].z, g);
  }
  if (p.rifle) rifle(g, p.rifle[0], p.rifle[1]);
  return g;
}

// ---------- WORLD ----------
const OUR_TOP = 1.6, EN_TOP = 1.8;
const ourG = new THREE.Group(); ourG.position.z = 5.5; scene.add(ourG); ROOT = ourG;
// our island: main dock + left jetty + right pier (camera stands at inner dock edge z=-3)
quay(-40, 7, -3, 40, OUR_TOP);
quay(-4.5, 2.5, -8.5, -3, OUR_TOP);
edgeDetails(-4.5, 2.5, -8.5, OUR_TOP, -1);
edgeDetailsZ(-8.5, -3, -4.5, OUR_TOP, 1);
edgeDetailsZ(-8.5, -3, 2.5, OUR_TOP, -1);
quay(-34, -6, -15, -3, OUR_TOP);
quay(7, 26, -18, 40, OUR_TOP);
edgeDetails(-6, -4.5, -3, OUR_TOP, -1); edgeDetails(2.5, 7, -3, OUR_TOP, -1);
edgeDetails(-34, -6, -15, OUR_TOP, -1);
edgeDetails(7, 26, -18, OUR_TOP, -1);
edgeDetailsZ(-15, -3, -6, OUR_TOP, 1);
edgeDetailsZ(-18, -3, 7, OUR_TOP, -1);
containerStack(-11.5, OUR_TOP, -12.5, Math.PI / 2, [2, 1], 2.6);
containerStack(-15, OUR_TOP, -12.5, Math.PI / 2, [2, 3, 1]);
containerStack(-13, OUR_TOP, -6, Math.PI / 2, [1]);
containerStack(11.5, OUR_TOP, -14, Math.PI / 2, [1, 2]);
containerStack(17.5, OUR_TOP, -15, Math.PI / 2, [2]);
craneSTS(19.5, OUR_TOP, -6, Math.PI, 40);
palm(3.4, OUR_TOP, -1.8, 8.5, 1.8, -2.4);
palm(-4.5, OUR_TOP, 3, 9.5, 1.5, 0.6);
sandbagWall(2.3, OUR_TOP, -7.9, -0.3, 2, 4);
ROOT = scene;
// enemy island
const EZ = -39;
quay(-60, 50, -110, EZ, EN_TOP);
edgeDetails(-60, 50, EZ, EN_TOP, 1);
// hill / jungle behind
{
  const geo = new THREE.PlaneGeometry(260, 140, 90, 50); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, cols = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const dz = (z + 70) / 70; // 0 at front edge
    let h = Math.max(0, 1 - dz) * 0 + Math.max(0, -z / 70) * 34 * (0.6 + 0.4 * Math.sin(x * 0.03 + 1.2)) * Math.exp(-((x + 10) * (x + 10)) / 18000);
    h += Math.sin(x * 0.11) * Math.cos(z * 0.13) * 1.6 + rr(-0.4, 0.4);
    h = Math.max(h, 0) + (z > 50 ? -10 : 0);
    pos.setY(i, h);
    const k = Math.min(1, h / 6); const c = new THREE.Color().setRGB(0.62 - 0.45 * k, 0.58 - 0.2 * k, 0.42 - 0.3 * k);
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); geo.computeVertexNormals();
  const hill = mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), -5, EN_TOP - 0.3, -165);
  // jungle canopy blobs on the hill
  const blob = new THREE.IcosahedronGeometry(1, 3);
  { const bp = blob.attributes.position; for (let i = 0; i < bp.count; i++) { const v = V(bp.getX(i), bp.getY(i), bp.getZ(i)); const k = 1 + 0.18 * Math.sin(v.x * 7.1 + v.y * 3.3) * Math.cos(v.z * 6.7 - v.y * 2.1); bp.setXYZ(i, v.x * k, v.y * k, v.z * k); } blob.computeVertexNormals(); }
  const leafM = [0x2a4f1f, 0x34602a, 0x22441b, 0x406d2c].map((c) => new THREE.MeshStandardMaterial({ map: leafBlobTex, color: c, roughness: 0.95 }));
  const ray = new THREE.Raycaster(); hill.updateMatrixWorld();
  for (let i = 0; i < 420; i++) {
    const x = rr(-120, 115), z = rr(-225, -102);
    ray.set(V(x, 200, z), V(0, -1, 0)); const hit = ray.intersectObject(hill)[0]; if (!hit || hit.point.y < EN_TOP + 1.2) continue;
    const s = rr(2.2, 4.8); const b = mesh(blob, leafM[i % 4], x, hit.point.y + s * 0.5, z); b.scale.set(s * rr(1, 1.4), s * rr(0.8, 1.1), s * rr(1, 1.4));
  }
  for (let i = 0; i < 26; i++) {
    const x = rr(-110, 100), z = rr(-170, -104);
    ray.set(V(x, 200, z), V(0, -1, 0)); const hit = ray.intersectObject(hill)[0]; if (!hit) continue;
    palm(x, hit.point.y - 0.3, z, rr(9, 14), rr(1, 3), rr(0, 6));
  }
}
// distant islands
for (const [x, z, s] of [[-330, -520, 90], [260, -600, 120], [520, -300, 70]]) {
  const geo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  const m = mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3f6b3a, roughness: 1 }), x, -2, z); m.scale.set(s * 1.8, s * 0.38, s);
}
// warehouse
{
  const g = new THREE.Group(); g.position.set(-24, EN_TOP, -72); ROOT.add(g);
  const Wd = 30, Hh = 10, D = 18;
  const wm = new THREE.MeshStandardMaterial({ map: clone(corrTex, 5, 1.5), normalMap: clone(corrNormal, 5, 1.5), color: 0xb9c3c8, metalness: 0.4, roughness: 0.55 });
  mesh(box(Wd, Hh, D), wm, 0, Hh / 2, 0, g);
  for (const s of [-1, 1]) { const r = mesh(box(Wd + 0.8, 0.25, D / 2 / Math.cos(0.22) + 0.6), M.roof, 0, Hh + Math.tan(0.22) * D / 4, s * D / 4, g); r.rotation.x = s * 0.22; }
  const gable = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(0, Math.tan(0.22) * D / 2)]);
  for (const s of [-1, 1]) { const gm = mesh(new THREE.ShapeGeometry(gable), wm, s * Wd / 2, Hh, 0, g); gm.rotation.y = s * Math.PI / 2; }
  for (const dx of [-9, 0, 9]) { mesh(box(5, 5.5, 0.12), new THREE.MeshStandardMaterial({ map: clone(corrTex, 1, 6), color: 0x7f878c, metalness: 0.4, roughness: 0.6 }), dx, 2.75, D / 2 + 0.07, g).material.map.rotation = Math.PI / 2; }
  mesh(box(16, 1.4, 0.1), M.sign, 0, Hh - 1.3, D / 2 + 0.08, g);
}
containerStack(10, EN_TOP, -55, 0, [3, 2, 4, 3], 2.6);
containerStack(18, EN_TOP, -55, Math.PI / 2 + 0.02, [2, 3]);
containerStack(-40, EN_TOP, -50, Math.PI / 2, [2, 1, 2]);
containerStack(28, EN_TOP, -64, 0, [4, 4, 3]);
craneSTS(30, EN_TOP, -52, 0, 34);
lightMast(-36, EN_TOP, -50); lightMast(36, EN_TOP, -42);
palm(-31, EN_TOP, -45, 10, 2, 0.3); palm(-34.5, EN_TOP, -47, 8, 1.5, 2.6); palm(4, EN_TOP, -48.5, 9, 1.6, -1.2); palm(-48, EN_TOP, -44, 11, 2.2, 0.9);
const drumM = [0x1f5fa8, 0xb23a26, 0x2f6b3a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.4 }));
for (const [x, z, n] of [[8.5, -42.5, 3], [-14, -43, 4], [24, -45, 2]]) for (let i = 0; i < n; i++) mesh(cyl(0.29, 0.88, 16), drumM[(i + n) % 3], x + (i % 2) * 0.62, EN_TOP + 0.44, z - Math.floor(i / 2) * 0.62);
for (const [x, z] of [[-17, -44], [-17, -45.3], [12, -46.5]]) { mesh(box(1.2, 0.14, 1.0), M.wood, x, EN_TOP + 0.07, z); mesh(box(1.1, 0.7, 0.9), new THREE.MeshStandardMaterial({ color: 0xa88a5c, roughness: 0.9 }), x, EN_TOP + 0.5, z); }
// enemy base: bunker with blocked doorways
const BX = -4.5, BZ = EZ - 4.6;
const bk = bunker(BX, EN_TOP, BZ); bk.rotation.y = -0.55;
sandbagWall(0, 0, 2.3 + 0.35, 0, 2, 6, bk);
{ const plate = mesh(box(0.05, 2.15, 1.8), M.steel, 2.3 + 0.12, 1.07, 0, bk); plate.rotation.z = 0.05;
  for (const [dy, dz] of [[0.3, 0.7], [0.3, -0.7], [1.8, 0.7], [1.8, -0.7]]) mesh(cyl(0.03, 0.05, 6), M.dark, 2.3 + 0.17, dy + 0.1, dz, bk).rotation.z = Math.PI / 2; }
// cash generator
{ const g = new THREE.Group(); g.position.set(BX + 3.8, EN_TOP, BZ - 2.4); g.rotation.y = -0.3; ROOT.add(g);
  mesh(box(1.4, 1.2, 1.0), new THREE.MeshStandardMaterial({ color: 0x3b4146, metalness: 0.6, roughness: 0.4 }), 0, 0.6, 0, g);
  mesh(box(1.2, 0.08, 0.02), M.glow, 0, 1.0, 0.51, g);
  mesh(box(0.5, 0.12, 0.3), M.cash, 0.2, 1.26, 0.1, g);
  const ex = mesh(cyl(0.08, 0.7, 10), M.galv, -0.5, 1.5, -0.3, g); }
// vault
{ const g = new THREE.Group(); g.position.set(BX - 4, EN_TOP, BZ - 0.5); g.rotation.y = 0.3; ROOT.add(g);
  mesh(box(1.6, 1.8, 1.4), M.steel, 0, 0.9, 0, g);
  const d = mesh(cyl(0.6, 0.12, 24), new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.9, roughness: 0.3 }), 0, 0.9, 0.72, g); d.rotation.x = Math.PI / 2;
  const w = mesh(new THREE.TorusGeometry(0.22, 0.03, 8, 20), M.dark, 0, 0.9, 0.8, g); }
// shop stall + NPC
{ const g = new THREE.Group(); g.position.set(5, EN_TOP, -44); g.rotation.y = -0.25; ROOT.add(g);
  mesh(box(2.6, 1.05, 0.7), M.wood, 0, 0.52, 0, g);
  for (const sx of [-1.25, 1.25]) for (const sz of [-1, 0.35]) mesh(cyl(0.04, 2.5, 6), M.galv, sx, 1.25, sz, g);
  const aw = mesh(new THREE.PlaneGeometry(2.8, 1.8), M.awning, 0, 2.45, -0.3, g); aw.rotation.x = -Math.PI / 2 + 0.25;
  mesh(box(0.4, 0.25, 0.3), M.cash, -0.6, 1.17, 0, g);
  person({ legL: [V(-0.1, 0.5, 0), V(-0.11, 0.06, 0)], legR: [V(0.1, 0.5, 0), V(0.11, 0.06, 0)], armL: [V(-0.24, 1.12, -0.05), V(-0.15, 1.08, -0.3)], armR: [V(0.24, 1.12, -0.05), V(0.15, 1.08, -0.3)] },
    { shirt: 0xe9e4d6, pants: 0x3b4252, skin: 0x8d5a3b, vest: 0x2f6f73, cap: 0x222222, brim: true }, 0, 0, -0.6, Math.PI);
}
// scaffold bridge chain from the water up to the enemy quay, with the rival crossing it
const BRX = 1.2;
for (let i = 0; i < 4; i++) scaffoldBridge(BRX, EN_TOP, EZ + 16 - i * 4);
const rival = person({
  lean: 0.18,
  legL: [V(-0.12, 0.6, -0.3), V(-0.12, 0.18, -0.38), -0.3],
  legR: [V(0.12, 0.48, 0.15), V(0.12, 0.2, 0.42), 0.6],
  armL: [V(-0.22, 1.2, -0.25), V(0.0, 1.3, -0.48)], armR: [V(0.3, 1.15, -0.05), V(0.12, 1.22, -0.22)],
  rifle: [V(0.08, 1.3, -0.05), V(-0.2, -0.15, -1)],
}, { shirt: 0x7a1f1a, pants: 0x2e2f33, skin: 0xc79a7b, vest: 0x26282b, cap: 0x1d1f22, pack: true }, BRX + 0.2, EN_TOP + 0.03, EZ + 7.6, 0.35);

// our player (over-the-shoulder)
const PX = -1.0, PZ = -0.4;
const aim = V(BRX + 0.2, EN_TOP + 1.3, EZ + 7.6);
const player = person({
  lean: 0.08,
  legL: [V(-0.15, 0.5, -0.14), V(-0.17, 0.08, -0.2), 0],
  legR: [V(0.15, 0.5, 0.1), V(0.2, 0.08, 0.22), 0],
  armL: [V(-0.18, 1.2, -0.32), V(0.02, 1.4, -0.56)], armR: [V(0.36, 1.28, -0.02), V(0.13, 1.4, -0.2)],
  rifle: [V(0.11, 1.46, -0.04), V(0, -0.02, -1)],
}, { shirt: 0x4e5640, pants: 0x4b4a40, skin: 0xa8714c, vest: 0x3d4431, cap: 0x4a4f3c, helmet: true, pack: true, hair: 0x2b2018 }, PX, OUR_TOP, PZ, 0);
player.lookAt(aim.x, OUR_TOP, aim.z); player.rotateY(Math.PI);

// ---------- water ----------
const normals = await new THREE.TextureLoader().loadAsync('./textures/waternormals.jpg');
normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
const water = new Water(new THREE.PlaneGeometry(6000, 6000), {
  textureWidth: 1024, textureHeight: 1024, waterNormals: normals, sunDirection: sunDir.clone(),
  sunColor: 0xfff3dc, waterColor: 0x14b3c4, distortionScale: 3.2, fog: true,
});
water.material.fragmentShader = water.material.fragmentShader.replace(
  'vec3 albedo = mix( ( sunColor * diffuseLight * 0.3 + scatter ) * getShadowMask(), reflectionSample + specularLight, reflectance );',
  'vec3 albedo = mix( ( sunColor * diffuseLight * 0.25 + scatter * 1.6 ) * getShadowMask(), reflectionSample * vec3(0.7, 0.92, 1.0) + specularLight, reflectance * 0.55 );');
water.rotation.x = -Math.PI / 2;
water.material.uniforms.size.value = 3.5;
water.material.uniforms.time.value = 12;
scene.add(water);

// ---------- camera (over right shoulder, aiming) ----------
const fwd = aim.clone().sub(V(PX, 0, PZ)).setY(0).normalize();
const right = new THREE.Vector3().crossVectors(fwd, Y_UP).normalize();
camera.position.set(PX, OUR_TOP + 1.78, PZ).addScaledVector(fwd, -3.1).addScaledVector(right, 0.95);
camera.lookAt(aim.clone().add(V(0, 0.35, 0)));

// ---------- post ----------
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.35, 0.6, 4.0));
composer.addPass(new OutputPass());

// rival tag
const tag = document.getElementById('tag');
const tp = rival.localToWorld(V(0, 2.0, 0)).project(camera);
tag.style.left = `${(tp.x * 0.5 + 0.5) * W}px`; tag.style.top = `${(-tp.y * 0.5 + 0.5) * H}px`;

let frames = 0;
(function loop() {
  composer.render();
  if (++frames === 6) window.__ready = true;
  requestAnimationFrame(loop);
})();

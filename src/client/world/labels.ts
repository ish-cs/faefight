import * as THREE from 'three/webgpu';
import { weather } from './weathering';

/**
 * Printed labels, spray stencils and packing tape for props: one 512² canvas atlas (2 × 2 cells), drawn once with a
 * few dozen canvas ops (no per-pixel work), on one alpha-tested material shared by every decal. Decal geometry is
 * thin shells just outside the prop's surface with UVs remapped into one atlas cell.
 *
 * Cells: 0 drum hazard stencil (UN number + flammable diamond), 1 crate spray stencil (freight mark, arrows,
 * FRAGILE), 2 shipping label (address block + barcode), 3 brown packing tape.
 */
export type LabelCell = 0 | 1 | 2 | 3;
const N = 512, H = N / 2;

let atlasTex: THREE.CanvasTexture | null = null;
function atlas(): THREE.CanvasTexture {
  if (atlasTex) return atlasTex;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  if (!g) throw new Error('[world/labels] 2D canvas context unavailable');
  g.clearRect(0, 0, N, N);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  // 0 (top-left): drum stencil — white UN number, red/white flammable diamond, a warning strip
  {
    const x0 = 0, y0 = 0;
    g.save();
    g.translate(x0 + 90, y0 + 120);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#c8261c'; g.fillRect(-52, -52, 104, 104);
    g.strokeStyle = '#f2efe6'; g.lineWidth = 6; g.strokeRect(-44, -44, 88, 88);
    g.restore();
    g.fillStyle = '#f2efe6';
    g.font = 'bold 30px Arial'; g.fillText('3', x0 + 90, y0 + 150);
    g.beginPath(); g.moveTo(x0 + 90, y0 + 86); g.quadraticCurveTo(x0 + 70, y0 + 116, x0 + 90, y0 + 130); g.quadraticCurveTo(x0 + 110, y0 + 116, x0 + 90, y0 + 86); g.fill();
    g.font = 'bold 40px "Arial Narrow", Arial'; g.fillText('UN 1203', x0 + 190, y0 + 92);
    g.font = 'bold 20px Arial'; g.fillText('FLAMMABLE', x0 + 190, y0 + 132);
    g.font = '16px Arial'; g.fillText('NET 200 L · BATCH 4471', x0 + 190, y0 + 160);
    g.fillStyle = '#e8b81c'; g.fillRect(x0 + 10, y0 + 210, 236, 14);
  }
  // 1 (top-right): crate spray stencil, slightly broken letters
  {
    const x0 = H, y0 = 0;
    g.fillStyle = '#1c1a18';
    g.font = 'bold 44px "Courier New", monospace'; g.fillText('PALMERA', x0 + 128, y0 + 62);
    g.font = 'bold 26px "Courier New", monospace'; g.fillText('FRAGILE', x0 + 128, y0 + 110);
    for (const dx of [-60, 60]) { // "this way up" arrows
      g.beginPath(); g.moveTo(x0 + 128 + dx, y0 + 140); g.lineTo(x0 + 128 + dx - 22, y0 + 172); g.lineTo(x0 + 128 + dx + 22, y0 + 172); g.fill();
      g.fillRect(x0 + 128 + dx - 7, y0 + 170, 14, 34);
    }
    g.font = 'bold 20px "Courier New", monospace'; g.fillText('PIER 3 · 42KG', x0 + 128, y0 + 228);
    // stencil bridges: thin gaps through the letters
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 9; i++) g.fillRect(x0 + 34 + i * 22, y0 + 36, 3, 52);
    g.globalCompositeOperation = 'source-over';
  }
  // 2 (bottom-left): shipping label — off-white paper, address lines, barcode
  {
    const x0 = 0, y0 = H;
    g.fillStyle = '#f1ede2'; g.fillRect(x0 + 20, y0 + 30, 216, 196);
    g.fillStyle = '#2a2a2a';
    g.font = 'bold 22px Arial'; g.textAlign = 'left'; g.fillText('SHIP TO:', x0 + 32, y0 + 54);
    for (let i = 0; i < 4; i++) g.fillRect(x0 + 32, y0 + 74 + i * 16, 120 + ((i * 47) % 70), 7);
    for (let i = 0, x = x0 + 32; x < x0 + 222; i++) { const w = 1 + ((i * 7919) % 4); g.fillRect(x, y0 + 150, w, 52); x += w + 1 + ((i * 31) % 3); }
    g.font = '14px Arial'; g.fillText('0042 7781 3390', x0 + 32, y0 + 214);
    g.textAlign = 'center';
  }
  // 3 (bottom-right): packing tape, tan with a sheen streak and torn ends
  {
    const x0 = H, y0 = H;
    g.fillStyle = '#b89662'; g.fillRect(x0, y0 + 64, H, 128);
    g.fillStyle = 'rgba(255,240,210,0.35)'; g.fillRect(x0, y0 + 96, H, 18);
    g.fillStyle = 'rgba(80,60,30,0.25)'; g.fillRect(x0, y0 + 64, H, 6); g.fillRect(x0, y0 + 186, H, 6);
  }
  atlasTex = new THREE.CanvasTexture(c);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 8;
  return atlasTex;
}

let labelMat: THREE.MeshStandardNodeMaterial | null = null;
/** The shared decal material (alpha-tested, pulled toward the camera so it never z-fights its prop). */
export function labelMaterial(): THREE.MeshStandardNodeMaterial {
  if (labelMat) return labelMat;
  const m = new THREE.MeshStandardNodeMaterial({ map: atlas(), alphaTest: 0.5, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.name = 'labels';
  labelMat = weather(m, { grime: 0.35, grimeHeight: 0.4, edge: 0.6, chip: 'light', vary: 0.2 });
  return labelMat;
}

/** Remap a geometry's 0..1 UVs into atlas cell `cell` (with a 4 px inset against bleeding). */
function toCell(g: THREE.BufferGeometry, cell: LabelCell) {
  const uv = g.getAttribute('uv');
  const cx = cell % 2, cy = cell < 2 ? 1 : 0; // canvas row 0 = top = high v
  const ic = 8 / N; // 4 atlas px, in cell units
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (cx + ic + uv.getX(i) * (1 - 2 * ic)) / 2, (cy + ic + uv.getY(i) * (1 - 2 * ic)) / 2);
  return g;
}

/** A label wrapped part-way round a cylinder (axis Y, centred at y), radius r, height h, arc `arc` rad facing +Z. */
export function cylinderLabel(r: number, y: number, h: number, arc: number, cell: LabelCell): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, 12, 1, true, -arc / 2, arc);
  g.translate(0, y, 0);
  return toCell(g, cell);
}

/** A flat label of w × h on a box face: centre `at`, facing `normal` (axis-aligned), lifted 2 mm off the face. */
export function faceLabel(w: number, h: number, at: THREE.Vector3, normal: THREE.Vector3, cell: LabelCell): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  g.lookAt(normal);
  g.translate(at.x + normal.x * 0.002, at.y + normal.y * 0.002, at.z + normal.z * 0.002);
  return toCell(g, cell);
}

/** Packing tape over the top of a box (half extents hx, hy, hz; origin at the box centre): across the top along X, down both X faces. */
export function boxTape(hx: number, hy: number, hz: number, width = 0.06): THREE.BufferGeometry[] {
  const d = 0.002, drop = Math.min(hy * 0.6, 0.12);
  return [
    toCell(new THREE.PlaneGeometry(hx * 2, width).rotateX(-Math.PI / 2).translate(0, hy + d, 0), 3),
    toCell(new THREE.PlaneGeometry(width, drop).rotateY(Math.PI / 2).translate(hx + d, hy - drop / 2, 0), 3),
    toCell(new THREE.PlaneGeometry(width, drop).rotateY(-Math.PI / 2).translate(-hx - d, hy - drop / 2, 0), 3),
  ];
}

/** Push dents into a closed mesh: each dent pulls vertices within `radius` of `at` inward by up to `depth`. */
export function dent(g: THREE.BufferGeometry, dents: { at: THREE.Vector3; radius: number; depth: number }[]) {
  const p = g.getAttribute('position'), v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    for (const d of dents) {
      const k = 1 - v.distanceTo(d.at) / d.radius;
      if (k <= 0) continue;
      n.set(v.x, 0, v.z).normalize(); // radial (cylinders)
      v.addScaledVector(n, -d.depth * k * k * (3 - 2 * k));
    }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

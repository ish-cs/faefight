import * as THREE from 'three/webgpu';
import type { LootBag, PieceKind, Vec3 } from '../sim/types';
import { buildWeapon } from './characters/weapons';
import { ICONS, iconGroup } from './icons';
import { lootItems, lootLabel, type LootItem } from './lootLook';
import { pieceGeometry } from './world';

/** Loot on the ground: each bag shows its items (gun / piece models, else icon billboards), spinning and bobbing over a soft glow; a label with names and counts within LABEL_M or when aimed at. */
export const LOOT_VIEW = { labelM: 8, aimM: 40, aimRadius: 0.7, spin: 1.2, bob: 0.06, maxModels: 3, maxLabels: 6 };

const GROUP_COLOR: Record<string, string> = { gun: '#ffd166', piece: '#8fc7ff', explosive: '#ff8a65', medkit: '#7ee2a8', potion: '#6cc2ff', upgrade: '#c9a7ff' };

// ---- shared resources (one per kind, built lazily) ----
const glowTex = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,240,200,0.85)');
  r.addColorStop(0.4, 'rgba(255,220,150,0.35)');
  r.addColorStop(1, 'rgba(255,220,150,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
let glowMat: THREE.SpriteNodeMaterial | null = null;
const iconMats = new Map<string, THREE.SpriteNodeMaterial>();
const pieceMeshGeo = new Map<PieceKind, THREE.BufferGeometry>();
const pieceMat = new THREE.MeshStandardNodeMaterial({ color: 0xb9c6d4, roughness: 0.6, metalness: 0.2 });
const PIECE_TINT: Partial<Record<PieceKind, number>> = { wood: 0xa0703f, sandbags: 0xc2a878, metal: 0x9aa8b6, steel: 0x6f7c88, scaffold: 0xc9b26a, ramp: 0xa0703f, container: 0x3d7fbf };
const pieceMats = new Map<PieceKind, THREE.MeshStandardNodeMaterial>();

function iconMat(kind: string): THREE.SpriteNodeMaterial {
  let m = iconMats.get(kind);
  if (m) return m;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  m = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
  m.color.setScalar(1.6);
  iconMats.set(kind, m);
  const g = c.getContext('2d')!;
  if (kind === 'cash') {
    g.fillStyle = '#ffd166';
    g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#7a5a12';
    g.font = '800 72px "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('$', 64, 68);
    tex.needsUpdate = true;
  } else {
    const color = GROUP_COLOR[iconGroup(kind as keyof typeof ICONS)] ?? '#ffffff';
    const svg = ICONS[kind as keyof typeof ICONS].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" ').replaceAll('currentColor', color);
    const img = new Image();
    img.onload = () => { g.drawImage(img, 0, 0, 128, 128); tex.needsUpdate = true; };
    img.onerror = () => console.warn(`[loot] icon for ${kind} failed to load`);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  return m;
}

function pieceMesh(kind: PieceKind): THREE.Mesh {
  let g = pieceMeshGeo.get(kind);
  if (!g) {
    g = pieceGeometry(kind).clone();
    g.computeBoundingBox();
    const b = g.boundingBox!, size = new THREE.Vector3();
    b.getSize(size);
    const s = 0.55 / Math.max(size.x, size.y, size.z);
    const c = new THREE.Vector3();
    b.getCenter(c);
    g.translate(-c.x, -c.y, -c.z).scale(s, s, s);
    pieceMeshGeo.set(kind, g);
  }
  let m = pieceMats.get(kind);
  if (!m) { m = pieceMat.clone(); m.color.setHex(PIECE_TINT[kind] ?? 0xb9c6d4); pieceMats.set(kind, m); }
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  return mesh;
}

function itemObject(it: LootItem): THREE.Object3D {
  if (it.model === 'gun') {
    const w = buildWeapon(it.kind);
    if (w) {
      // Lay it flat-ish, a bit bigger than in the hand so it reads from afar.
      w.scale.setScalar(1.6);
      w.rotation.set(0, Math.PI / 2, 0);
      const holder = new THREE.Group();
      holder.add(w);
      return holder;
    }
  }
  if (it.model === 'piece') return pieceMesh(it.kind);
  const s = new THREE.Sprite(iconMat(it.kind));
  s.scale.setScalar(0.5);
  return s;
}

function labelSprite(lines: string[]): THREE.Sprite {
  const c = document.createElement('canvas');
  const lh = 36, w = 340, h = 16 + lh * lines.length;
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(14,18,24,0.78)';
  g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 14); g.fill();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((t, i) => {
    g.font = `${i === 0 ? 700 : 600} ${i === 0 ? 28 : 24}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    g.fillStyle = i === 0 ? '#ffd166' : '#f3f5f7';
    g.fillText(t.slice(0, 26), w / 2, 8 + lh * i + lh / 2);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false });
  mat.color.setScalar(1.8);
  const s = new THREE.Sprite(mat);
  s.scale.set(0.26, (0.26 * h) / w, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 7;
  return s;
}

type BagView = { group: THREE.Group; spin: THREE.Group; key: string; lines: string[]; label: THREE.Sprite | null; phase: number; pos: Vec3 };

export class LootView {
  private bags = new Map<number, BagView>();
  private tmp = new THREE.Vector3();
  private dir = new THREE.Vector3();
  /** Debug/e2e: ids whose label shows, and what each bag displays. */
  readonly shown = new Set<number>();

  constructor(private scene: THREE.Scene) {}

  sync(loot: LootBag[]) {
    const seen = new Set<number>();
    for (const l of loot) {
      seen.add(l.id);
      const items = lootItems(l.inv);
      const key = items.map((i) => `${i.model}:${i.kind}:${i.text}`).join('|');
      let b = this.bags.get(l.id);
      if (b && b.key !== key) { this.drop(l.id, b); b = undefined; }
      if (!b) b = this.make(l.id, items, key);
      b.pos = l.pos;
      b.group.position.set(l.pos.x, l.pos.y, l.pos.z);
    }
    for (const [id, b] of this.bags) if (!seen.has(id)) this.drop(id, b);
  }

  /** Per frame: spin + bob, labels for near / aimed-at bags (closest first, capped). */
  frame(dt: number, t: number, viewer: Vec3 | null, cam: THREE.Camera) {
    cam.getWorldDirection(this.dir);
    const near: [number, BagView, number][] = [];
    for (const [id, b] of this.bags) {
      b.spin.rotation.y += LOOT_VIEW.spin * dt;
      b.spin.position.y = 0.45 + Math.sin(t * 2 + b.phase) * LOOT_VIEW.bob;
      const p = b.pos;
      const d = viewer ? Math.hypot(p.x - viewer.x, p.y - viewer.y, p.z - viewer.z) : Infinity;
      this.tmp.set(p.x, p.y + 0.45, p.z).sub(cam.position);
      const along = this.tmp.dot(this.dir);
      const aimed = along > 0 && along < LOOT_VIEW.aimM && this.tmp.addScaledVector(this.dir, -along).length() < LOOT_VIEW.aimRadius;
      if (d <= LOOT_VIEW.labelM || aimed) near.push([id, b, aimed ? -1 : d]);
    }
    near.sort((a, b) => a[2] - b[2]);
    const show = new Set(near.slice(0, LOOT_VIEW.maxLabels).map((n) => n[0]));
    this.shown.clear();
    for (const [id, b] of this.bags) {
      const on = show.has(id) && b.lines.length > 0;
      if (on && !b.label) { b.label = labelSprite(b.lines); b.label.position.y = 0.95; b.group.add(b.label); }
      if (b.label) b.label.visible = on;
      if (on) this.shown.add(id);
    }
  }

  /** Debug/e2e: what's on the ground as drawn. */
  info() {
    return [...this.bags].map(([id, b]) => ({ id, lines: b.lines, labelShown: this.shown.has(id), models: b.spin.children.length }));
  }

  private make(id: number, items: LootItem[], key: string): BagView {
    const group = new THREE.Group();
    const spin = new THREE.Group();
    group.add(spin);
    if (glowTex) {
      glowMat ??= new THREE.SpriteNodeMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.setScalar(1.1);
      glow.position.y = 0.4;
      glow.renderOrder = 2;
      group.add(glow);
    }
    const shownItems = items.slice(0, LOOT_VIEW.maxModels);
    shownItems.forEach((it, i) => {
      const o = itemObject(it);
      if (shownItems.length > 1) {
        const a = (i / shownItems.length) * Math.PI * 2;
        o.position.set(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32);
      }
      spin.add(o);
    });
    this.scene.add(group);
    const b: BagView = { group, spin, key, lines: lootLabel(items), label: null, phase: (id * 1.7) % (Math.PI * 2), pos: { x: 0, y: 0, z: 0 } };
    this.bags.set(id, b);
    return b;
  }

  private drop(id: number, b: BagView) {
    this.scene.remove(b.group);
    if (b.label) { const m = b.label.material as THREE.SpriteNodeMaterial; m.map?.dispose(); m.dispose(); }
    this.bags.delete(id);
  }
}


import * as THREE from 'three/webgpu';
import { HAZARD } from '../../sim/constants';
import type { HazardDef, HazardKind } from '../../sim/map';
import type { HazardNet, MatchEvent, Vec3 } from '../../sim/types';
import { boxUV, mat, StaticBatch } from './geo';
import { SHADOW_ONLY_FIRST_LAYER } from './lod';
import { mats } from './materials';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Particles } from './particles';
import type { SolidHit } from './impacts';
import { ownHazard } from './surfaces';
import { v3 } from '../../sim/vec';

/**
 * Explosive barrels, propane tanks and supply crates (MapDef.hazards; sim state in snapshot `hz`).
 * One InstancedMesh per (kind, material); a gone one is zero-scaled. A fusing one shakes, leaks a jet of
 * fuel / gas and flashes faster and faster until it blows (hazard 'fuse' event, or `hz` st 1 for late
 * joiners). Explosions leave a scorch decal; crates burst into splinters.
 */

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// ---------------------------------------------------------------- painted textures

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('hazards: no 2d canvas context');
  return [c, g];
}

function grime(g: CanvasRenderingContext2D, w: number, h: number, n: number, rgb: string) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(${rgb},${rr(0.04, 0.22)})`;
    g.beginPath(); g.ellipse(rr(0, w), rr(0, h), rr(2, 14), rr(2, 30), rr(0, 3), 0, 7); g.fill();
  }
}

/** A red diamond "flammable" placard with a flame, centred at (x, y), half-diagonal s. */
function flammable(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.save(); g.translate(x, y);
  g.fillStyle = '#f4f0e6'; g.beginPath(); g.moveTo(0, -s); g.lineTo(s, 0); g.lineTo(0, s); g.lineTo(-s, 0); g.closePath(); g.fill();
  g.fillStyle = '#c8201a'; const k = s * 0.86;
  g.beginPath(); g.moveTo(0, -k); g.lineTo(k, 0); g.lineTo(0, k); g.lineTo(-k, 0); g.closePath(); g.fill();
  g.fillStyle = '#111';
  g.beginPath(); g.moveTo(0, -k * 0.55); g.quadraticCurveTo(k * 0.32, -k * 0.1, k * 0.18, k * 0.22); g.lineTo(-k * 0.18, k * 0.22);
  g.quadraticCurveTo(-k * 0.3, -k * 0.05, 0, -k * 0.55); g.fill();
  g.fillRect(-k * 0.3, k * 0.28, k * 0.6, k * 0.06);
  g.restore();
}

function stripes(g: CanvasRenderingContext2D, y: number, h: number, w: number) {
  g.save(); g.beginPath(); g.rect(0, y, w, h); g.clip();
  g.fillStyle = '#f0c21a'; g.fillRect(0, y, w, h);
  g.fillStyle = '#151515';
  for (let x = -h; x < w + h; x += h * 1.4) { g.beginPath(); g.moveTo(x, y); g.lineTo(x + h * 0.7, y); g.lineTo(x + h * 0.7 + h, y + h); g.lineTo(x + h, y + h); g.fill(); }
  g.restore();
}

let TEX: { barrel: THREE.Texture; propane: THREE.Texture; crate: THREE.Texture; scorch: THREE.Texture } | null = null;
function textures() {
  if (TEX) return TEX;
  const done = (c: HTMLCanvasElement) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  // Fuel drum side (u wraps the circumference): red, two hazard bands, a flammable placard front and back.
  const [bc, bg] = canvas(512, 256);
  bg.fillStyle = '#a3241b'; bg.fillRect(0, 0, 512, 256);
  grime(bg, 512, 256, 140, '40,10,6');
  stripes(bg, 26, 22, 512); stripes(bg, 208, 22, 512);
  for (const x of [128, 384]) flammable(bg, x, 128, 52);
  bg.fillStyle = 'rgba(245,240,230,0.9)'; bg.font = 'bold 22px monospace'; bg.textAlign = 'center';
  for (const x of [0, 256, 512]) bg.fillText('FUEL', x, 140);
  grime(bg, 512, 256, 60, '20,16,12');
  // Propane cylinder: off-white, red band with the name, a placard.
  const [pc, pg] = canvas(512, 256);
  pg.fillStyle = '#e8e4da'; pg.fillRect(0, 0, 512, 256);
  grime(pg, 512, 256, 90, '90,80,60');
  pg.fillStyle = '#b5281f'; pg.fillRect(0, 70, 512, 46);
  pg.fillStyle = '#f6f2e8'; pg.font = 'bold 30px sans-serif'; pg.textAlign = 'center';
  for (const x of [128, 384]) pg.fillText('PROPANE', x, 104);
  for (const x of [0, 256, 512]) flammable(pg, x, 176, 40);
  // Supply crate panel: planks with a stencilled "SUPPLY", arrows and a cross.
  const [cc, cg] = canvas(256, 256);
  cg.fillStyle = '#b48c58'; cg.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 42) {
    cg.fillStyle = `rgb(${rr(160, 190) | 0},${rr(120, 145) | 0},${rr(75, 95) | 0})`; cg.fillRect(0, y + 2, 256, 38);
    cg.fillStyle = 'rgba(60,40,20,0.5)'; cg.fillRect(0, y, 256, 2);
    for (let k = 0; k < 18; k++) { cg.fillStyle = `rgba(90,60,30,${rr(0.05, 0.2)})`; cg.fillRect(rr(0, 256), y + rr(4, 36), rr(20, 90), 1); }
  }
  cg.fillStyle = 'rgba(28,28,24,0.82)'; cg.font = 'bold 40px monospace'; cg.textAlign = 'center';
  cg.fillText('SUPPLY', 128, 118);
  cg.fillRect(112, 140, 32, 70); cg.fillRect(93, 159, 70, 32);
  cg.font = 'bold 18px monospace'; cg.fillText('▲ THIS SIDE UP ▲', 128, 40);
  for (let k = 0; k < 90; k++) { cg.fillStyle = `rgba(180,140,90,${rr(0.2, 0.6)})`; cg.fillRect(rr(80, 180), rr(80, 215), rr(1, 4), rr(1, 4)); }
  // Scorch: soft black blot with ragged rays.
  const [sc, sg] = canvas(256, 256);
  const grad = sg.createRadialGradient(128, 128, 8, 128, 128, 124);
  grad.addColorStop(0, 'rgba(8,6,4,0.95)'); grad.addColorStop(0.45, 'rgba(14,10,8,0.75)'); grad.addColorStop(1, 'rgba(20,16,12,0)');
  sg.fillStyle = grad; sg.fillRect(0, 0, 256, 256);
  for (let k = 0; k < 40; k++) {
    const a = rr(0, 7), l = rr(60, 120);
    sg.strokeStyle = `rgba(10,8,6,${rr(0.15, 0.4)})`; sg.lineWidth = rr(2, 7);
    sg.beginPath(); sg.moveTo(128, 128); sg.lineTo(128 + Math.cos(a) * l, 128 + Math.sin(a) * l); sg.stroke();
  }
  TEX = { barrel: done(bc), propane: done(pc), crate: done(cc), scorch: done(sc) };
  return TEX;
}

let MATS: { barrel: THREE.Material; propane: THREE.Material; crate: THREE.Material; scorch: THREE.MeshBasicNodeMaterial } | null = null;
function hazardMats() {
  if (MATS) return MATS;
  const t = textures();
  const m = (name: string, map: THREE.Texture, rough: number, metal: number) => {
    const x = new THREE.MeshStandardNodeMaterial({ map, roughness: rough, metalness: metal });
    x.name = name;
    return x;
  };
  const scorch = new THREE.MeshBasicNodeMaterial({ map: t.scorch, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  scorch.name = 'hazard:scorch';
  MATS = { barrel: m('hazard:barrel', t.barrel, 0.55, 0.35), propane: m('hazard:propane', t.propane, 0.45, 0.4), crate: m('hazard:crate', t.crate, 0.85, 0), scorch };
  return MATS;
}

// ---------------------------------------------------------------- models (base centre at the origin)

const cyl = (r: number, h: number, s = 20) => new THREE.CylinderGeometry(r, r, h, s, 1, true);

function barrelModel(b: StaticBatch) {
  const M = mats(), H = hazardMats(), s = HAZARD.barrel;
  b.add(H.barrel, cyl(s.r - 0.02, s.h - 0.02), mat(0, s.h / 2, 0));
  for (const y of [0.01, s.h / 3, (2 * s.h) / 3, s.h - 0.01]) b.add(M.paint, new THREE.CylinderGeometry(s.r, s.r, 0.03, 20), mat(0, y, 0), 0x7a1a14);
  b.add(M.paint, new THREE.CylinderGeometry(s.r - 0.025, s.r - 0.025, 0.012, 20), mat(0, s.h - 0.004, 0), 0x5a1410);
  b.add(M.paint, new THREE.CylinderGeometry(0.045, 0.045, 0.03, 8), mat(0.14, s.h + 0.01, 0.06), 0xd0b020);
  b.add(M.paint, new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), mat(-0.15, s.h + 0.01, -0.04), 0x6a6a6a);
}

function propaneModel(b: StaticBatch) {
  const M = mats(), H = hazardMats(), s = HAZARD.propane;
  const body = s.h - 0.32;
  b.add(H.propane, cyl(s.r, body), mat(0, 0.1 + body / 2, 0));
  b.add(M.paint, new THREE.SphereGeometry(s.r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 0.1 + body, 0, 0, 0, 0, 1, 0.55, 1), 0xe4e0d6);
  b.add(M.paint, new THREE.SphereGeometry(s.r, 20, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(0, 0.1, 0, 0, 0, 0, 1, 0.35, 1), 0xe4e0d6);
  b.add(M.paint, new THREE.CylinderGeometry(s.r * 0.92, s.r * 0.95, 0.1, 20, 1, true), mat(0, 0.05, 0), 0x8a8a86); // foot ring
  // collar (open guard ring) and brass valve
  const top = 0.1 + body + s.r * 0.55;
  b.add(M.paint, new THREE.CylinderGeometry(0.13, 0.13, 0.13, 16, 1, true), mat(0, top + 0.02, 0), 0xb5281f);
  b.add(M.galv, new THREE.CylinderGeometry(0.03, 0.035, 0.1, 8), mat(0, top + 0.02, 0));
  b.add(M.paint, new THREE.CylinderGeometry(0.045, 0.045, 0.02, 10), mat(0, top + 0.08, 0), 0xc9a23a);
}

function crateModel(b: StaticBatch) {
  const M = mats(), H = hazardMats(), s = HAZARD.crate;
  const W = 0.8, D = 0.62, h = s.h;
  b.add(H.crate, new THREE.BoxGeometry(W - 0.04, h - 0.06, D - 0.04), mat(0, h / 2, 0));
  // frame: corner posts, top/bottom rails, a diagonal brace on the long sides
  for (const x of [-W / 2 + 0.03, W / 2 - 0.03]) for (const z of [-D / 2 + 0.03, D / 2 - 0.03]) b.add(M.wood, boxUV(0.07, h, 0.07, 0.8), mat(x, h / 2, z), 0x7a5a36);
  for (const y of [0.035, h - 0.035]) for (const z of [-D / 2 + 0.02, D / 2 - 0.02]) b.add(M.wood, boxUV(W, 0.07, 0.05, 0.8), mat(0, y, z), 0x8a6840);
  for (const y of [0.035, h - 0.035]) for (const x of [-W / 2 + 0.02, W / 2 - 0.02]) b.add(M.wood, boxUV(0.05, 0.07, D, 0.8), mat(x, y, 0), 0x8a6840);
  b.add(M.wood, boxUV(0.66, 0.07, 0.62, 0.8), mat(0, h - 0.01, 0), 0x9a7448); // lid boards
  for (const y of [0.2, h - 0.2]) b.add(M.dark, new THREE.BoxGeometry(W + 0.01, 0.025, D + 0.01), mat(0, y, 0), 0x2a2a28); // steel straps
}

const MODELS: Record<HazardKind, (b: StaticBatch) => void> = { barrel: barrelModel, propane: propaneModel, crate: crateModel };

// ---------------------------------------------------------------- layer

type Slot = { def: HazardDef; meshes: THREE.InstancedMesh[]; index: number; matrix: THREE.Matrix4; shadowId: number };
type Fuse = { slot: Slot; start: number; end: number; nextFlash: number; jet: THREE.Vector3 };

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);

/** depth-only material of the hazards' shared shadow batch (never drawn by the camera) */
const SHADOW_MAT = new THREE.MeshBasicNodeMaterial();

/** Whether `p` sits on hazard `d` (the sim's hit cylinder, within `slack`): the hit with its face normal, or null. */
export function hazardSolidHit(d: HazardDef, p: Vec3, slack: number): SolidHit | null {
  const s = HAZARD[d.kind];
  const dx = p.x - d.pos.x, dz = p.z - d.pos.z, rad = Math.hypot(dx, dz);
  if (rad > s.r + slack || p.y < d.pos.y - slack || p.y > d.pos.y + s.h + slack) return null;
  const top = p.y > d.pos.y + s.h - 0.03 || rad < 1e-6;
  return { surface: d.kind === 'crate' ? 'wood' : 'metal', point: v3(p.x, p.y, p.z), normal: top ? v3(0, 1, 0) : v3(dx / rad, 0, dz / rad), owner: ownHazard(d.id) };
}

export class HazardLayer {
  readonly root = new THREE.Group();
  /**
   * Shadows: one shadow-only batch of every hazard (each kind's parts merged), first cascade only like the gameplay
   * props, instead of one shadow draw per kind x material in every cascade (~13 shadow draws -> 1).
   */
  private shadow: THREE.BatchedMesh | null = null;
  private slots = new Map<number, Slot>();
  private shown = new Map<number, boolean>();
  private fusing = new Map<number, Fuse>();
  private scorches: { mesh: THREE.Mesh; born: number }[] = [];
  private scorchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  constructor(defs: HazardDef[]) {
    this.root.name = 'hazards';
    const byKind = new Map<HazardKind, HazardDef[]>();
    for (const d of defs) {
      if (!MODELS[d.kind]) { console.warn(`[world/hazards] unknown hazard kind ${String(d.kind)} (id ${d.id})`); continue; }
      (byKind.get(d.kind) ?? byKind.set(d.kind, []).get(d.kind)!).push(d);
    }
    const shadowGeos: { geo: THREE.BufferGeometry; list: HazardDef[] }[] = [];
    for (const [kind, list] of byKind) {
      const b = new StaticBatch();
      MODELS[kind](b);
      const parts = b.take();
      const meshes = parts.map(({ material, geometry, receive }) => {
        const m = new THREE.InstancedMesh(geometry, material, list.length);
        m.name = `hazard:${kind}:${material.name}`;
        m.castShadow = false; m.receiveShadow = receive; // the shadow batch below casts for every kind
        return m;
      });
      shadowGeos.push({ geo: mergeGeometries(parts.map((x) => x.geometry), false)!, list });
      list.forEach((d, i) => {
        const matrix = new THREE.Matrix4().compose(_p.set(d.pos.x, d.pos.y, d.pos.z), _q.setFromAxisAngle(_up, d.rotY), _one);
        for (const m of meshes) m.setMatrixAt(i, matrix);
        this.slots.set(d.id, { def: d, meshes, index: i, matrix, shadowId: -1 });
        this.shown.set(d.id, true);
      });
      for (const m of meshes) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); this.root.add(m); }
    }
    if (shadowGeos.length) {
      const sh = new THREE.BatchedMesh(shadowGeos.reduce((n, x) => n + x.list.length, 0), shadowGeos.reduce((n, x) => n + x.geo.getAttribute('position').count, 0), 0, SHADOW_MAT);
      sh.name = 'hazard:shadow';
      sh.castShadow = true;
      sh.layers.set(SHADOW_ONLY_FIRST_LAYER);
      sh.frustumCulled = false; // spans the map; perObjectFrustumCulled culls each instance
      sh.sortObjects = false;
      for (const { geo, list } of shadowGeos) {
        const gid = sh.addGeometry(geo);
        for (const d of list) {
          const slot = this.slots.get(d.id)!;
          slot.shadowId = sh.addInstance(gid);
          sh.setMatrixAt(slot.shadowId, slot.matrix);
        }
      }
      this.shadow = sh;
      this.root.add(sh);
    }
  }

  /** The standing hazard a shot's end point `p` sits on (the sim's hit cylinder, a little slack), or null. */
  hitAt(p: Vec3, slack = 0.1): SolidHit | null {
    for (const [id, slot] of this.slots) {
      if (!this.shown.get(id)) continue;
      const h = hazardSolidHit(slot.def, p, slack);
      if (h) return h;
    }
    return null;
  }

  /** Snapshot state: hide gone ones, show respawned ones, start the fuse fx for late-seen fusing ones. */
  sync(hz: HazardNet[] | undefined) {
    const st = new Map<number, number>();
    for (const h of hz ?? []) st.set(h.id, h.st);
    const now = performance.now();
    for (const [id, slot] of this.slots) {
      const s = st.get(id) ?? 0;
      this.setVisible(slot, s !== 2);
      if (s === 1 && !this.fusing.has(id)) this.startFuse(slot, now, HAZARD.fuseSec);
      if (s !== 1 && this.fusing.has(id)) this.stopFuse(id);
    }
  }

  private setVisible(slot: Slot, visible: boolean) {
    if (this.shown.get(slot.def.id) === visible) return;
    this.shown.set(slot.def.id, visible);
    for (const m of slot.meshes) { m.setMatrixAt(slot.index, visible ? slot.matrix : ZERO); m.instanceMatrix.needsUpdate = true; }
    if (this.shadow && slot.shadowId >= 0) this.shadow.setVisibleAt(slot.shadowId, visible);
  }

  private startFuse(slot: Slot, now: number, sec: number) {
    const a = R() * Math.PI * 2;
    const s = HAZARD[slot.def.kind];
    this.fusing.set(slot.def.id, {
      slot, start: now, end: now + Math.max(0.05, sec) * 1000, nextFlash: now,
      jet: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(s.r).setY(s.h * rr(0.4, 0.8)),
    });
  }

  private stopFuse(id: number) {
    const f = this.fusing.get(id);
    if (!f) return;
    this.fusing.delete(id);
    if (this.shown.get(id)) for (const m of f.slot.meshes) { m.setMatrixAt(f.slot.index, f.slot.matrix); m.instanceMatrix.needsUpdate = true; }
  }

  /** `hazard` events and hazard explosions. */
  onEvent(e: MatchEvent, particles: Particles) {
    const d = e.data;
    if (e.type === 'explosion' && typeof d.hazard === 'number') {
      const slot = this.slots.get(d.hazard);
      if (!slot) return;
      this.stopFuse(slot.def.id);
      this.setVisible(slot, false);
      this.blowFx(slot.def, particles);
      return;
    }
    if (e.type !== 'hazard') return;
    const slot = this.slots.get(d.id as number);
    if (!slot) { console.warn('[world/hazards] event for an unknown hazard', d); return; }
    const pos = (d.pos as Vec3 | undefined) ?? slot.def.pos;
    switch (d.what) {
      case 'hit': {
        const crate = slot.def.kind === 'crate';
        for (let i = 0; i < (crate ? 6 : 5); i++) {
          const a = R() * 7, s = rr(1, 3);
          if (crate) particles.debris.spawn(pos.x, pos.y, pos.z, Math.cos(a) * s, rr(1, 3), Math.sin(a) * s, rr(0.08, 0.2), 0.02, 0.02, 0xb08a5a, rr(0.8, 1.4), slot.def.pos.y);
          else particles.sparks.spawn(pos.x, pos.y, pos.z, Math.cos(a) * s * 2, rr(0.5, 3), Math.sin(a) * s * 2, rr(0.15, 0.3), 0.05, 0.01, 1, 0.7, 0.3, 1, 9, 1);
        }
        break;
      }
      case 'fuse':
        if (!this.fusing.has(slot.def.id)) this.startFuse(slot, performance.now(), Number(d.sec ?? HAZARD.fuseSec));
        break;
      case 'break':
        this.setVisible(slot, false);
        this.splinters(slot.def, particles);
        break;
      case 'respawn':
        this.setVisible(slot, true);
        break;
    }
  }

  private splinters(def: HazardDef, particles: Particles) {
    const { debris, dust } = particles;
    const p = def.pos;
    for (let i = 0; i < 22; i++) {
      const a = R() * Math.PI * 2, out = rr(1.2, 3.6);
      const plank = i % 3 === 0;
      debris.spawn(p.x + Math.cos(a) * 0.3, p.y + rr(0.1, 0.7), p.z + Math.sin(a) * 0.3, Math.cos(a) * out, rr(1.5, 4.5), Math.sin(a) * out,
        plank ? 0.7 : rr(0.12, 0.35), plank ? 0.07 : 0.03, plank ? 0.03 : 0.025, i % 2 ? 0xb08a5a : 0x8a6840, rr(1.8, 3), p.y, def.rotY + rr(-0.6, 0.6));
    }
    for (let i = 0; i < 8; i++) {
      const a = R() * 7, s = rr(0.4, 1.4);
      dust.spawn(p.x, p.y + rr(0.1, 0.6), p.z, Math.cos(a) * s, rr(0.3, 1), Math.sin(a) * s, rr(0.8, 1.4), 0.3, 1.2, 0.62, 0.54, 0.42, 0.5, -0.2, 1.5);
    }
  }

  private blowFx(def: HazardDef, particles: Particles) {
    const { debris, dust, sparks } = particles;
    const s = HAZARD[def.kind];
    const p = def.pos, cy = p.y + s.h / 2;
    const big = def.kind === 'barrel' ? 1.3 : 1;
    // fireball: a column of hot additive puffs rolling upward
    for (let i = 0; i < 40 * big; i++) {
      const a = R() * 7, sp = rr(0.5, 4) * big;
      sparks.spawn(p.x + rr(-0.3, 0.3), cy + rr(0, 0.6), p.z + rr(-0.3, 0.3), Math.cos(a) * sp, rr(2, 7), Math.sin(a) * sp,
        rr(0.35, 0.8), rr(0.6, 1.1) * big, rr(1.4, 2.6) * big, 1, rr(0.35, 0.6), rr(0.08, 0.2), 1, -3, 2.2);
    }
    // black fuel smoke rising after it
    for (let i = 0; i < 18; i++) {
      const a = R() * 7, sp = rr(0.3, 1.6);
      dust.spawn(p.x, cy + rr(0.4, 1.6), p.z, Math.cos(a) * sp, rr(1.2, 3), Math.sin(a) * sp, rr(2.2, 3.8), rr(0.6, 1), rr(2.4, 3.6) * big,
        0.1, 0.09, 0.08, 0.7, -0.6, 0.9);
    }
    // shell fragments: red drum steel / white cylinder steel
    const col = def.kind === 'barrel' ? 0x8f1f17 : 0xd8d4ca;
    for (let i = 0; i < 18; i++) {
      const a = R() * Math.PI * 2, out = rr(3, 9);
      debris.spawn(p.x, cy, p.z, Math.cos(a) * out, rr(4, 10), Math.sin(a) * out, rr(0.12, 0.35), rr(0.1, 0.3), 0.015, i % 4 ? col : 0x555555, rr(2, 3.5), p.y);
    }
    this.scorch(p, s.radius * 0.7);
  }

  private scorch(p: Vec3, size: number) {
    const m = new THREE.Mesh(this.scorchGeo, hazardMats().scorch.clone());
    m.position.set(p.x, p.y + 0.02, p.z);
    m.rotation.y = R() * Math.PI * 2;
    m.scale.set(size, 1, size);
    m.renderOrder = 1;
    m.name = 'hazard:scorch';
    this.root.add(m);
    this.scorches.push({ mesh: m, born: performance.now() });
    while (this.scorches.length > 16) this.dropScorch(0);
  }

  private dropScorch(i: number) {
    const [s] = this.scorches.splice(i, 1);
    (s.mesh.material as THREE.Material).dispose();
    s.mesh.removeFromParent();
  }

  /** Per frame: fusing ones shake, leak and flash; scorch marks fade after a minute. */
  update(now: number, particles: Particles) {
    for (const f of this.fusing.values()) {
      const { slot } = f;
      const d = slot.def, s = HAZARD[d.kind];
      const k = Math.min(1, (now - f.start) / Math.max(1, f.end - f.start));
      const j = 0.012 + 0.03 * k;
      _m.compose(_p.set(d.pos.x + rr(-j, j), d.pos.y, d.pos.z + rr(-j, j)), _q.setFromAxisAngle(_up, d.rotY + rr(-j, j)), _one);
      for (const m of slot.meshes) { m.setMatrixAt(slot.index, _m); m.instanceMatrix.needsUpdate = true; }
      // leak: a jet out of the side (dark fuel spray from a drum, white gas from a tank)
      const gas = d.kind === 'propane';
      const jx = d.pos.x + f.jet.x, jy = d.pos.y + f.jet.y, jz = d.pos.z + f.jet.z;
      for (let i = 0; i < 3; i++) {
        const sp = rr(2, 4);
        particles.dust.spawn(jx, jy, jz, f.jet.x / s.r * sp + rr(-0.4, 0.4), rr(-0.2, 0.6), f.jet.z / s.r * sp + rr(-0.4, 0.4), rr(0.3, 0.6), 0.06, rr(0.4, 0.7),
          gas ? 0.92 : 0.3, gas ? 0.94 : 0.26, gas ? 0.96 : 0.2, gas ? 0.5 : 0.6, gas ? -0.5 : 4, 2);
      }
      // warning flash: faster as the fuse runs down
      if (now >= f.nextFlash) {
        f.nextFlash = now + 220 - 160 * k;
        particles.sparks.spawn(d.pos.x, d.pos.y + s.h + 0.1, d.pos.z, 0, 0, 0, 0.09, 0.9, 1.1, 1, 0.25, 0.1, 1, 0, 0);
        particles.sparks.spawn(jx, jy, jz, 0, 0, 0, 0.07, 0.4, 0.5, 1, 0.6, 0.2, 1, 0, 0);
      }
    }
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const s = this.scorches[i];
      const age = (now - s.born) / 1000;
      if (age > 75) { this.dropScorch(i); continue; }
      if (age > 45) (s.mesh.material as THREE.MeshBasicNodeMaterial).opacity = 1 - (age - 45) / 30;
    }
  }

  dispose() {
    for (const m of new Set([...this.slots.values()].flatMap((v) => v.meshes))) { m.geometry.dispose(); m.dispose(); }
    this.shadow?.dispose();
    while (this.scorches.length) this.dropScorch(0);
    this.root.removeFromParent();
  }
}

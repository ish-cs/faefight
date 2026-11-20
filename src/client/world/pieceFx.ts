import * as THREE from 'three/webgpu';
import { PIECES, PLAYER } from '../../sim/constants';
import type { MatchEvent, PieceKind, PieceState, PlayerState, Vec3 } from '../../sim/types';
import { DECAL_METAL, DECAL_SAND, DECAL_STEEL, DECAL_WOOD } from './damageTex';
import { DecalLayer } from './decals';
import { CONTAINER_COLORS } from './materials';
import { Particles } from './particles';
import type { PieceLayer, PieceSlot, VisualHit } from './pieces';

type Surface = 'sand' | 'wood' | 'metal' | 'steel';
const SLOT_SURFACE: Record<PieceSlot, Surface> = { burlap: 'sand', wood: 'wood', corr: 'metal', steel: 'steel', galv: 'steel', paint: 'metal' };
const KIND_SURFACE: Record<PieceKind, Surface> = { sandbags: 'sand', wood: 'wood', metal: 'metal', steel: 'steel', scaffold: 'wood', ramp: 'wood', container: 'metal' };
const DECAL: Record<Surface, number> = { sand: DECAL_SAND, wood: DECAL_WOOD, metal: DECAL_METAL, steel: DECAL_STEEL };

const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
const _hit: VisualHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), slot: 'wood' };

/** Max debris chunks one destruction may take; with several pieces collapsing in a tick the pools' caps still bind. */
const DEBRIS_PER_DESTROY = 26;
const G_SPARK = 9;

/**
 * Damage feedback for building pieces, driven by sim `pieceHit` / `destroyed` events:
 * bullet holes that stay where the hit landed, per-hit sparks/splinters/sand, a wobble on explosive hits,
 * and a debris + dust burst on destruction. Material-level cracks/holes live in the piece shaders (pieces.ts).
 */
export class PieceFx {
  readonly root = new THREE.Group();
  readonly decals = new DecalLayer();
  readonly particles = new Particles();
  private last = performance.now();
  private destroyedThisFrame = 0;

  constructor(private pieces: PieceLayer) {
    this.root.name = 'pieceFx';
    this.root.add(this.decals.mesh, this.particles.root);
  }

  sync(pieces: PieceState[]) {
    if (!this.decals.active) return;
    const ids = new Set<number>();
    for (const p of pieces) ids.add(p.id);
    this.decals.retain((id) => ids.has(id));
  }

  onEvent(e: MatchEvent, players: PlayerState[]) {
    if (e.type === 'pieceHit') this.onHit(e.data, players);
    else if (e.type === 'destroyed') this.onDestroyed(e.data);
  }

  private onHit(data: Record<string, unknown>, players: PlayerState[]) {
    const id = data.piece as number, kind = data.kind as PieceKind, at = data.pos as Vec3 | undefined;
    const source = data.source as 'bullet' | 'fist' | 'explosive';
    if (!at || !PIECES[kind]) return;
    const info = this.pieces.info(id);
    if (source === 'explosive') {
      const frac = Math.min(1, ((data.amount as number) || 0) / PIECES[kind].hp);
      this.pieces.shake(id, 0.03 + frac * 0.25);
      this.dustBurst(at.x, at.y, at.z, KIND_SURFACE[kind], 4, 1.2);
      return;
    }
    // Ray from the attacker's eye through the hull hit point, re-cast against the visual surface.
    const shooter = players.find((p) => p.id === data.by);
    if (shooter) _d.set(at.x - shooter.pos.x, at.y - (shooter.pos.y + PLAYER.eyeHeight), at.z - shooter.pos.z);
    else if (info) _d.set(at.x - info.x, 0, at.z - info.z).negate();
    else _d.set(0, -1, 0);
    if (_d.lengthSq() < 1e-6) _d.set(0, -1, 0);
    _d.normalize();
    let surf = KIND_SURFACE[kind];
    let px = at.x, py = at.y, pz = at.z;
    _n.copy(_d).negate();
    if (info) {
      _o.set(at.x, at.y, at.z).addScaledVector(_d, -0.4);
      if (this.pieces.raycastVisual(id, _o, _d, 1.6, _hit)) {
        surf = SLOT_SURFACE[_hit.slot];
        px = _hit.point.x; py = _hit.point.y; pz = _hit.point.z;
        _n.copy(_hit.normal);
        if (source === 'bullet') this.decals.add(id, _hit.point, _hit.normal, DECAL[surf]);
      }
    }
    this.impact(surf, px, py, pz, _n, source === 'fist' ? 0.6 : 1);
  }

  /** Short-lived, material-appropriate spray at a hit point leaving along normal n. */
  private impact(surf: Surface, x: number, y: number, z: number, n: THREE.Vector3, k: number) {
    const { dust, sparks, debris } = this.particles;
    // tangent frame for cone sampling
    _t1.set(n.y, n.z, -n.x).cross(n).normalize();
    _t2.crossVectors(n, _t1);
    const cone = (speed: number, spread: number, out: THREE.Vector3) => {
      const a = R() * Math.PI * 2, s = R() * spread;
      return out.copy(n).addScaledVector(_t1, Math.cos(a) * s).addScaledVector(_t2, Math.sin(a) * s).normalize().multiplyScalar(speed);
    };
    const v = _o;
    if (surf === 'metal' || surf === 'steel') {
      const count = Math.round((surf === 'steel' ? 11 : 8) * k);
      for (let i = 0; i < count; i++) {
        cone(rr(3, 8), 0.9, v);
        sparks.spawn(x, y, z, v.x, v.y + 1, v.z, rr(0.18, 0.4), rr(0.05, 0.08), 0.015, 1.0, rr(0.55, 0.8), 0.25, 1, G_SPARK, 1.5);
      }
      sparks.spawn(x + n.x * 0.03, y + n.y * 0.03, z + n.z * 0.03, 0, 0, 0, 0.08, 0.3, 0.12, 1, 0.8, 0.45, 1, 0, 0); // flash
      cone(0.4, 0.5, v);
      dust.spawn(x, y, z, v.x, v.y + 0.2, v.z, rr(0.5, 0.8), 0.08, 0.35, 0.35, 0.34, 0.32, 0.5, -0.3, 1.5);
    } else if (surf === 'wood') {
      for (let i = 0; i < Math.round(5 * k); i++) {
        cone(rr(2, 5), 0.8, v);
        debris.spawn(x, y, z, v.x, v.y + 1, v.z, rr(0.06, 0.14), rr(0.012, 0.022), rr(0.012, 0.022), 0xd9b27a, rr(0.6, 1.0), y - 3);
      }
      for (let i = 0; i < 3; i++) {
        cone(rr(0.5, 1.2), 0.6, v);
        dust.spawn(x, y, z, v.x, v.y, v.z, rr(0.5, 0.8), 0.07, rr(0.3, 0.45), 0.62, 0.5, 0.36, 0.55, -0.2, 2);
      }
    } else {
      for (let i = 0; i < Math.round(7 * k); i++) {
        cone(rr(0.6, 1.8), 0.9, v);
        dust.spawn(x, y, z, v.x, v.y, v.z, rr(0.6, 1.0), rr(0.06, 0.1), rr(0.35, 0.6), 0.82, 0.72, 0.52, 0.75, 1.2, 2.2);
      }
      for (let i = 0; i < Math.round(4 * k); i++) {
        cone(rr(1.5, 3), 0.7, v);
        debris.spawn(x, y, z, v.x, v.y + 0.5, v.z, 0.025, 0.025, 0.025, 0xd8c08a, rr(0.5, 0.8), y - 3);
      }
    }
  }

  private dustBurst(x: number, y: number, z: number, surf: Surface, count: number, size: number) {
    const tint = surf === 'sand' ? [0.78, 0.68, 0.5] : surf === 'wood' ? [0.6, 0.52, 0.42] : [0.45, 0.44, 0.42];
    for (let i = 0; i < count; i++) {
      const a = R() * Math.PI * 2, s = rr(0.6, 2.2);
      this.particles.dust.spawn(x + rr(-0.3, 0.3), y + rr(-0.2, 0.3), z + rr(-0.3, 0.3), Math.cos(a) * s, rr(0.3, 1.4), Math.sin(a) * s,
        rr(1.2, 2.2), size * rr(0.4, 0.7), size * rr(1.2, 2), tint[0], tint[1], tint[2], 0.6, -0.25, 1.4);
    }
  }

  private onDestroyed(data: Record<string, unknown>) {
    const id = data.piece as number, kind = data.kind as PieceKind, c = data.pos as Vec3 | undefined;
    this.decals.removePiece(id);
    if (!c || !PIECES[kind]) return;
    // A collapse can destroy many pieces in one tick: later ones get a smaller burst, pools cap the rest.
    const scale = this.destroyedThisFrame++ < 3 ? 1 : 0.4;
    const rotY = (data.rotY as number) ?? 0;
    const { w, h, d } = PIECES[kind];
    const floorY = c.y - h / 2 - (kind === 'scaffold' ? 2 : 0);
    const cs = Math.cos(rotY), sn = Math.sin(rotY);
    const { debris, sparks } = this.particles;
    // chunk shape/colour per kind: [sx, sy, sz, colour]
    const shapes: Record<PieceKind, [number, number, number, number][]> = {
      sandbags: [[0.42, 0.15, 0.28, 0x8c7550], [0.28, 0.13, 0.22, 0x7a6544], [0.1, 0.08, 0.1, 0xb59a68]],
      wood: [[1.1, 0.22, 0.05, 0x6e5236], [0.6, 0.2, 0.05, 0x5e4630], [0.22, 0.06, 0.04, 0xc49a62]],
      metal: [[0.7, 0.6, 0.02, 0x9aa0a2], [0.45, 0.5, 0.02, 0x80878a], [0.6, 0.09, 0.03, 0x8a7a64]],
      steel: [[0.6, 0.5, 0.1, 0x5f666b], [0.4, 0.35, 0.1, 0x4f5559], [0.15, 0.12, 0.08, 0x777e82]],
      scaffold: [[1.5, 0.045, 0.3, 0x7a5a3a], [1.3, 0.05, 0.05, 0xa4abb0], [0.4, 0.04, 0.2, 0xc49a62]],
      ramp: [[1.2, 0.05, 0.45, 0x7a5a3a], [0.7, 0.05, 0.35, 0x6a4e32], [0.5, 0.4, 0.03, 0x7c8287]],
      container: [[1.1, 0.9, 0.04, CONTAINER_COLORS[id % CONTAINER_COLORS.length]], [0.7, 0.6, 0.04, CONTAINER_COLORS[id % CONTAINER_COLORS.length]], [0.3, 0.3, 0.2, 0x55585a]],
    };
    const n = Math.round(DEBRIS_PER_DESTROY * scale * (kind === 'container' ? 1.3 : kind === 'sandbags' ? 0.8 : 1));
    const pal = shapes[kind];
    for (let i = 0; i < n; i++) {
      const [sx, sy, sz, col] = pal[i % pal.length];
      const lx = rr(-w / 2, w / 2) * 0.9, ly = rr(-h / 2, h / 2) * 0.9, lz = rr(-d / 2, d / 2) * 0.9;
      const x = c.x + lx * cs + lz * sn, z = c.z - lx * sn + lz * cs, y = c.y + ly;
      const heft = 1 / Math.sqrt(Math.max(0.3, sx * sy + sy * sz + sx * sz) * 3); // big chunks fly slower
      const out = rr(1, 3.5) * Math.min(1.2, heft);
      const ox = lx * cs + lz * sn, oz = -lx * sn + lz * cs, ol = Math.hypot(ox, oz) || 1;
      const j = rr(0.85, 1.15);
      debris.spawn(x, y, z, (ox / ol) * out + rr(-0.6, 0.6), rr(1.5, 4.5) * Math.min(1.2, heft), (oz / ol) * out + rr(-0.6, 0.6), sx * j, sy * j, sz * j, col, rr(2.0, 3.0), floorY, rotY);
    }
    const surf = KIND_SURFACE[kind];
    const big = Math.max(w, h, d);
    this.dustBurst(c.x, c.y, c.z, surf, Math.round((10 + big * 3) * scale), 0.9 + big * 0.25);
    if (surf === 'metal' || surf === 'steel') {
      for (let i = 0; i < 24 * scale; i++) {
        const a = R() * Math.PI * 2, s = rr(3, 9);
        sparks.spawn(c.x, c.y, c.z, Math.cos(a) * s, rr(1, 6), Math.sin(a) * s, rr(0.3, 0.6), 0.05, 0.01, 1, rr(0.55, 0.8), 0.25, 1, G_SPARK, 1);
      }
    }
  }

  /** Per frame. */
  update(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.destroyedThisFrame = 0;
    this.pieces.update(now);
    this.particles.update(dt);
  }
}


import * as THREE from 'three/webgpu';
import { float, materialOpacity, texture, uv, vec4 } from 'three/tsl';
import { scopeGlint } from '../../sim/combat';
import { PLAYER } from '../../sim/constants';
import type { PlayerState, Vec3 } from '../../sim/types';

/**
 * Sniper scope glint (fairness): a scoped sniper's lens flashes toward whoever it points at, brightest straight down
 * the barrel (sim/combat.ts scopeGlint, the same rule the bots read). A small pool of additive, constant-screen-size
 * sprites at the scope's objective; depth-tested (a wall hides it), no light, no per-frame allocation. Bloom does the
 * rest. Usually 0-2 are visible, so it costs at most a couple of tiny draws.
 */
const POOL = 8;
/** On-screen size (fraction of the view height) at a faint and at a full glint. */
const SIZE_MIN = 0.055, SIZE_MAX = 0.13;
/** Below this the glint isn't drawn. */
const MIN_K = 0.04;

let tex: THREE.CanvasTexture | null = null;
/** A four-point star with a hot core (drawn once). */
function glintTex(): THREE.CanvasTexture {
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.24, 'rgba(255,250,235,0.9)'); r.addColorStop(0.5, 'rgba(255,240,210,0.15)'); r.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = 'lighter';
  for (const [w, h] of [[64, 5], [5, 64]]) {
    const l = g.createLinearGradient(32 - w / 2, 32 - h / 2, 32 + w / 2, 32 + h / 2);
    l.addColorStop(0, 'rgba(255,255,255,0)'); l.addColorStop(0.5, 'rgba(255,255,255,0.9)'); l.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = l; g.fillRect(32 - w / 2, 32 - h / 2, w, h);
  }
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type Glint = { sprite: THREE.Sprite; mat: THREE.SpriteNodeMaterial };
type Aimer = Pick<PlayerState, 'id' | 'alive' | 'yaw' | 'pitch' | 'ads' | 'equipped'>;

const _pos = { x: 0, y: 0, z: 0 };
const _p: Pick<PlayerState, 'pos' | 'yaw' | 'pitch' | 'ads' | 'equipped'> = { pos: _pos, yaw: 0, pitch: 0, ads: true, equipped: 'sniper' };

export class ScopeGlints {
  readonly root = new THREE.Group();
  private pool: Glint[] = [];
  /** Glints drawn last frame (tests / perf HUD). */
  shown = 0;

  constructor() {
    this.root.name = 'scopeGlints';
    for (let i = 0; i < POOL; i++) {
      const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, fog: false });
      mat.name = 'scopeGlint';
      const t = texture(glintTex(), uv());
      mat.colorNode = vec4(t.rgb.mul(float(5)), 1); // pre-boosted for bloom
      mat.opacityNode = t.a.mul(materialOpacity);
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 4;
      sprite.frustumCulled = false;
      this.root.add(sprite);
      this.pool.push({ sprite, mat });
    }
  }

  /**
   * Per frame: `players` from the snapshot, `feet(id)` their drawn position (null = not drawn), `eye` the camera.
   * `skip` = the viewer's own player (no glint from your own scope).
   */
  frame(players: readonly Aimer[], feet: (id: number) => Vec3 | null, eye: THREE.Vector3, skip: number) {
    let n = 0;
    for (const p of players) {
      if (n >= POOL) break;
      if (!p.alive || p.id === skip || p.equipped !== 'sniper' || !p.ads) continue;
      const f = feet(p.id);
      if (!f) continue;
      _pos.x = f.x; _pos.y = f.y; _pos.z = f.z;
      _p.yaw = p.yaw; _p.pitch = p.pitch;
      const k = scopeGlint(_p, eye);
      if (k < MIN_K) continue;
      // The objective lens: a little ahead of and above the eye along the aim.
      const c = Math.cos(p.pitch);
      const g = this.pool[n++];
      g.sprite.position.set(f.x - Math.sin(p.yaw) * c * 0.45, f.y + PLAYER.eyeHeight - 0.05 + Math.sin(p.pitch) * 0.45, f.z - Math.cos(p.yaw) * c * 0.45);
      const s = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * k;
      g.sprite.scale.set(s, s, 1);
      g.mat.opacity = Math.min(1, 0.45 + k);
      g.sprite.visible = true;
    }
    for (let i = n; i < this.shown; i++) this.pool[i].sprite.visible = false;
    this.shown = n;
  }
}

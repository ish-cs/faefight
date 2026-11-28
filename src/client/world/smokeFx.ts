import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, texture, uv, vec3, vec4 } from 'three/tsl';
import { SMOKE } from '../../sim/constants';
import type { SmokeCloud } from '../../sim/types';
import { smokeCenter, smokeDensity, smokeHalfHeight, smokeRadius } from '../../sim/utility';
import { lightU } from './lightUniforms';
import { canvasTex } from './textures';

/**
 * Smoke grenade clouds (Snapshot.smokes): ONE instanced camera-facing Sprite for every cloud, PUFFS soft puffs each,
 * sized by the sim's own smokeRadius / smokeHalfHeight and faded by smokeDensity, so what you see is what hides you
 * from bots. The puff layout is a fixed table rotated per cloud id: no per-cloud state, nothing allocated per frame.
 * Unlit (no new light): tinted by the day/night ambient uniform the impostors use. Puffs the camera is inside are
 * dropped (scale 0) so standing in a cloud doesn't stack full-screen layers; the screen fog (screenFx.ts) takes over.
 * Fill rate is the cost: few big puffs whose texture fills most of the quad (~3 layers deep on average), not many small ones.
 */
export const SMOKE_PUFFS = 18;
const CORE = 5, RIM = 14;
const CAP = SMOKE_PUFFS * SMOKE.maxClouds;
/** Centre height over the pop point (sim's ellipsoid; computed once from the sim helper, not per frame). */
const LIFT = smokeCenter({ id: 0, owner: 0, pos: { x: 0, y: 0, z: 0 }, t0: 0 }).y;

// Puff table, 7 floats each: horizontal offset (x, z, fraction of the radius), vertical (fraction of the half height),
// size (fraction of the radius), drift phase, shade, rotation.
const TBL = new Float32Array(SMOKE_PUFFS * 7);
{
  let s = 0x9e3779b9;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < SMOKE_PUFFS; i++) {
    const o = i * 7;
    // big core puffs (dense middle), mid puffs, then small rim puffs that make the outline lumpy (dome: lower
    // further out)
    const core = i < CORE, rim = i >= RIM;
    const q = core ? 0.2 * rnd() : rim ? 0.6 + 0.25 * rnd() : 0.32 + 0.3 * Math.sqrt(rnd());
    const a = rnd() * Math.PI * 2;
    TBL[o] = Math.cos(a) * q;
    TBL[o + 1] = Math.sin(a) * q;
    TBL[o + 2] = (rim ? -0.5 + 1.1 * rnd() : -0.35 + 0.8 * rnd()) * (1 - 0.5 * q);
    TBL[o + 3] = core ? 0.95 + 0.15 * rnd() : rim ? 0.45 + 0.15 * rnd() : 0.7 + 0.15 * rnd();
    TBL[o + 4] = rnd() * Math.PI * 2;
    TBL[o + 5] = rnd();
    TBL[o + 6] = rnd() * Math.PI * 2;
  }
}

/** Soft lumpy puff: overlapping blobs under a radial falloff (white; alpha carries the shape, rgb a little relief). */
function smokeTex(): THREE.CanvasTexture {
  const t = canvasTex(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * w * 0.17;
      const x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d, r = w * (0.24 + rnd() * 0.12);
      const l = Math.round(215 + 40 * (1 - (y / h))); // lit from above
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${l},${l},${l},1)`);
      gr.addColorStop(1, `rgba(${l},${l},${l},0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    }
    // fade the edge to nothing so the sprite's square never shows
    g.globalCompositeOperation = 'destination-in';
    const edge = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    edge.addColorStop(0, 'rgba(0,0,0,1)');
    edge.addColorStop(0.62, 'rgba(0,0,0,1)');
    edge.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = edge;
    g.fillRect(0, 0, w, h);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 1;
  return t;
}

export class SmokeFx {
  readonly sprite: THREE.Sprite;
  private ps = new Float32Array(CAP * 4); // x y z size
  private ls = new Float32Array(CAP * 4); // shade alpha rotation -
  private psA: THREE.InstancedBufferAttribute;
  private lsA: THREE.InstancedBufferAttribute;
  private n = 0;
  private clouds = 0;

  constructor() {
    this.psA = new THREE.InstancedBufferAttribute(this.ps, 4).setUsage(THREE.DynamicDrawUsage);
    this.lsA = new THREE.InstancedBufferAttribute(this.ls, 4).setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.name = 'fx:smoke';
    const p = instancedBufferAttribute(this.psA, 'vec4') as unknown as THREE.Node<'vec4'>;
    const l = instancedBufferAttribute(this.lsA, 'vec4') as unknown as THREE.Node<'vec4'>;
    const t = texture(smokeTex(), uv());
    mat.positionNode = p.xyz;
    mat.scaleNode = p.w;
    mat.rotationNode = l.z;
    // grey-white smoke × the ambient tone (day/night) — unlit, no light added
    mat.colorNode = vec4(vec3(1.05, 1.05, 1.07).mul(t.rgb).mul(l.x).mul(lightU.impostor), 1);
    mat.opacityNode = t.a.mul(l.y);
    this.sprite = new THREE.Sprite(mat);
    // never 0 instances (a zero-size one when idle): the loading warm-up forces hidden objects visible and compiles
    // whatever draws, so the smoke pipeline is built at load, not at the first smoke of the match
    this.sprite.count = 1;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 7; // after the storm wall (5) and island beacons (6): a beam behind the cloud must not cut through it
    this.sprite.name = 'fx:smoke';
    this.sprite.visible = false;
  }

  /** Per frame: lay out every cloud's puffs at sim time `now` (drift, bloom, thinning). */
  frame(clouds: readonly SmokeCloud[] | undefined, now: number, cam: THREE.Vector3) {
    const ps = this.ps, ls = this.ls;
    let n = 0, live = 0;
    if (clouds) for (const c of clouds) {
      const den = smokeDensity(c, now);
      if (den <= 0 || n + SMOKE_PUFFS > CAP) continue;
      live++;
      const r = smokeRadius(c, now), hh = smokeHalfHeight(c, now), age = now - c.t0;
      const cx = c.pos.x, cy = c.pos.y + LIFT, cz = c.pos.z;
      const yaw = (c.id * 2.399963) % (Math.PI * 2), cs = Math.cos(yaw), sn = Math.sin(yaw);
      const emerge = Math.min(1, 0.35 + age / 0.6);
      for (let i = 0; i < SMOKE_PUFFS; i++) {
        const o = i * 7, ph = TBL[o + 4];
        const ox = TBL[o] * cs - TBL[o + 1] * sn, oz = TBL[o] * sn + TBL[o + 1] * cs;
        const size = TBL[o + 3] * r;
        // slow churn: each puff wanders ~0.3 m and the whole cloud creeps up a little as it ages
        const x = cx + ox * r + Math.sin(now * 0.23 + ph) * 0.3;
        const y = Math.max(c.pos.y + size * 0.18, cy + TBL[o + 2] * hh + Math.sin(now * 0.31 + ph * 1.7) * 0.18 + age * 0.02);
        const z = cz + oz * r + Math.cos(now * 0.19 + ph) * 0.3;
        // camera inside this puff: drop it (fill rate), fade it in over the next ~half size
        const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
        const dc = Math.sqrt(dx * dx + dy * dy + dz * dz) / size;
        const near = dc < 0.45 ? 0 : Math.min(1, (dc - 0.45) / 0.35);
        const k = n * 4;
        ps[k] = x; ps[k + 1] = y; ps[k + 2] = z; ps[k + 3] = near > 0 ? size : 0;
        ls[k] = 0.72 + 0.32 * (TBL[o + 2] + 0.35) + 0.1 * TBL[o + 5]; // tops lit, base in its own shade
        ls[k + 1] = (i < CORE ? 1 : 0.92) * den * emerge * near;
        ls[k + 2] = TBL[o + 6] + now * (TBL[o + 5] - 0.5) * 0.08;
        n++;
      }
    }
    this.n = n;
    this.clouds = live;
    this.sprite.count = Math.max(1, n);
    this.sprite.visible = n > 0;
    if (n > 0) {
      this.psA.clearUpdateRanges(); this.psA.addUpdateRange(0, n * 4); this.psA.needsUpdate = true;
      this.lsA.clearUpdateRanges(); this.lsA.addUpdateRange(0, n * 4); this.lsA.needsUpdate = true;
    }
  }

  /** Debug / e2e: clouds and puffs drawn this frame. */
  info() { return { clouds: this.clouds, puffs: this.n, visible: this.sprite.visible }; }
}

/**
 * How deep the eye `p` is in smoke at `now`, 0 (outside / thin) .. 1 (well inside a full cloud), for the screen fog.
 * Ellipsoid depth: 0 at the rim, 1 from 45% of the way in, × the cloud's density. Strongest cloud wins.
 */
export function smokeDepth(clouds: readonly SmokeCloud[] | undefined, p: { x: number; y: number; z: number }, now: number): number {
  let best = 0;
  if (clouds) for (const c of clouds) {
    const den = smokeDensity(c, now);
    if (den <= 0) continue;
    const r = smokeRadius(c, now), hh = smokeHalfHeight(c, now);
    const dx = (p.x - c.pos.x) / r, dy = (p.y - c.pos.y - LIFT) / hh, dz = (p.z - c.pos.z) / r;
    const q = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (q >= 1) continue;
    const k = Math.min(1, (1 - q) / 0.55) * den;
    if (k > best) best = k;
  }
  return best;
}

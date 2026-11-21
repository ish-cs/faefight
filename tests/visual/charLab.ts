/**
 * Dev-only character lab (served by vite at /tests/visual/chars.html, not part of the build).
 * Drives the real Renderer with synthetic snapshots: a close-up soldier, an 8-player group, the island shop keeper,
 * and the first-person hands. Used by tests/visual/charShots.mjs for docs/screens/chars-*.png and frame timing.
 */
import * as THREE from 'three/webgpu';
import { buildMapDef } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import type { PlayerState, Snapshot, WeaponKind } from '../../src/sim/types';
import { Renderer } from '../../src/client/render';
import { FirstPersonView } from '../../src/client/viewmodel';
import { settings } from '../../src/client/settings/store';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const r = await Renderer.create(canvas);
const def = buildMapDef(8);
const HUMAN = 100;
r.setMap(def, HUMAN);
await r.characters.ready;
const isl = def.islands[0];
const yaw0 = isl.bunker.facingYaw;
/** island-local (x, z) → world (three.js Y rotation, as tests/visual/realism.mjs) */
const W = (x: number, z: number) => ({ x: isl.center.x + x * Math.cos(yaw0) + z * Math.sin(yaw0), z: isl.center.z - x * Math.sin(yaw0) + z * Math.cos(yaw0) });
const GY = isl.groundY;
const shop = isl.shop;

const GUNS: WeaponKind[] = ['rifle', 'smg', 'pistol', 'shotgun', 'rifle', 'fists', 'rocket', 'smg'];
type Actor = { p: PlayerState; base: { x: number; z: number }; walk: number; yaw: number };
let actors: Actor[] = [];
let tick = 0;
let fpv: FirstPersonView | null = null;
let me: PlayerState | null = null;
let camYaw = 0, camPitch = 0;

function mk(id: number, island: number, at: { x: number; z: number }, yaw: number, gun: WeaponKind, walk = 0): Actor {
  const p = newPlayer(id, `P${id}`, id % 2 === 1, island, { x: at.x, y: GY, z: at.z });
  p.equipped = gun;
  p.yaw = yaw;
  return { p, base: at, walk, yaw };
}

function push() {
  const t = tick / 30;
  for (const a of actors) {
    const { p } = a;
    if (a.walk) {
      // walk back and forth along the facing direction at the given speed
      const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
      const s = Math.sin(t * a.walk / 2.4);
      p.pos.x = a.base.x + fx * s * 1.2; p.pos.z = a.base.z + fz * s * 1.2;
      const v = Math.cos(t * a.walk / 2.4) * a.walk / 2.4 * 1.2;
      p.vel.x = fx * v; p.vel.z = fz * v;
      p.yaw = v >= 0 ? a.yaw : a.yaw + Math.PI;
    }
  }
  const s: Snapshot = {
    time: t, tick: tick++, players: actors.map((a) => a.p), pieces: [], loot: [], projectiles: [], generators: [], genLevels: [1, 1, 1, 1, 1, 1, 1, 1],
    sealed: def.islands.map(() => false), waterY: 0, suddenDeath: false, winner: null, potionShops: [], events: [],
  };
  r.ingest(s);
  r.pushSnapshot(s);
}

const look = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => {
  r.camera.position.set(from.x, from.y, from.z);
  r.camera.lookAt(to.x, to.y, to.z);
};

/** Third-person scenes. */
function setup(name: 'closeup' | 'group' | 'shop' | 'fp' | 'far') {
  tick = 0;
  fpv = null;
  settings.update((s) => { s.gameplay.cameraMode = 'third'; });
  // the group stands on open ground in front of the bunker, facing the camera (+Z local → yaw toward camera)
  const C = W(0, 9);
  const faceCam = yaw0 + Math.PI; // local +Z
  if (name === 'closeup') {
    actors = [mk(1, 1, C, faceCam - 0.5, 'rifle')];
    const c = actors[0].p.pos;
    const cam = W(0.9, 10.6);
    look({ x: cam.x, y: GY + 1.62, z: cam.z }, { x: c.x, y: GY + 1.38, z: c.z });
  } else if (name === 'group' || name === 'far') {
    actors = GUNS.map((g, i) => {
      const row = i < 4 ? 0 : 1;
      const at = W(-3.3 + (i % 4) * 2.2 + row * 1.1, 9 - row * 2.2);
      return mk(i + 1, i, at, faceCam + (i % 3 - 1) * 0.35, g, i === 2 ? 1.6 : i === 6 ? 5.5 : 0);
    });
    const d = name === 'far' ? 30 : 0;
    const cam = W(0.2, 15 + d);
    look({ x: cam.x, y: GY + 2.1 + d * 0.06, z: cam.z }, { ...(() => { const t = W(0, 8.2); return { x: t.x, z: t.z }; })(), y: GY + 1.0 });
  } else if (name === 'shop') {
    // shop keeper + two customers walking up
    const sw = (x: number, z: number) => W(shop.x - isl.center.x + x, shop.z - isl.center.z + z); // approx island-local
    actors = [mk(1, 2, sw(1.4, 3.2), faceCam, 'rifle', 1.4), mk(2, 3, sw(-1.6, 2.6), faceCam, 'pistol')];
    const k = { x: shop.x, z: shop.z };
    look({ x: k.x + 3.2 * Math.sin(yaw0) + 1.3, y: GY + 1.9, z: k.z + 3.2 * Math.cos(yaw0) + 1.3 }, { x: k.x, y: GY + 1.25, z: k.z });
  } else if (name === 'fp') {
    actors = [mk(HUMAN, 0, C, faceCam, 'rifle'), mk(2, 4, W(0.4, 4), yaw0, 'rifle')];
    me = actors[0].p;
    settings.update((s) => { s.gameplay.cameraMode = 'first'; });
    fpv = new FirstPersonView(r, () => true);
    camYaw = faceCam + Math.PI; camPitch = -0.12;
  }
  push();
}

/** Set the first-person weapon (fp scene). */
function fpWeapon(kind: WeaponKind) { if (me) me.equipped = kind; }
/** Look direction for the first-person scene: yaw offset from the default, pitch. */
function fpLook(dyaw: number, pitch: number) { camYaw = yaw0 + dyaw; camPitch = pitch; }

let frameMs: number[] = [];
let lastT = performance.now();
let last = performance.now();
function loop(now: number) {
  frameMs.push(now - lastT); lastT = now;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (actors.length) push();
  r.beginFrame();
  if (fpv && me) {
    const feet = new THREE.Vector3(me.pos.x, me.pos.y, me.pos.z);
    fpv.updateCamera(feet, camYaw, camPitch, me, HUMAN);
    r.render(camYaw);
    fpv.render(me, camYaw, camPitch, dt, me.vel, tick / 30);
  } else r.render(0);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function measure(ms = 3000): Promise<unknown> {
  frameMs = [];
  return new Promise((res) => setTimeout(() => {
    const a = frameMs.slice(5).sort((x, y) => x - y);
    const avg = a.reduce((s, x) => s + x, 0) / a.length;
    res({ frames: a.length, fps: +(1000 / avg).toFixed(1), avgMs: +avg.toFixed(2), p95ms: +a[Math.floor(a.length * 0.95)].toFixed(2), info: r.info() });
  }, ms));
}

(window as unknown as { lab: unknown }).lab = { setup, fpWeapon, fpLook, measure, renderer: r, ready: true };

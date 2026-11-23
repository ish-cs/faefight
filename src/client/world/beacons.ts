import * as THREE from 'three/webgpu';
import {
  abs, cameraPosition, dot, float, instancedBufferAttribute, length, max, mix, normalView, positionGeometry, positionViewDirection,
  positionWorld, pow, sin, smoothstep, step, time, uniform, uv, vec2, vec3,
} from 'three/tsl';
import { MAP } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import type { Snapshot } from '../../sim/types';
import { playSfx } from '../audio/api';
import { BeaconStates } from './beaconState';
import { perfOff } from './perfFlags';
import type { SkyLighting } from './sky';

/** Beam height (m): reaches well above every roof, mast and the cinematic drone's orbit. */
const HEIGHT = 320;
/** Beam radius (m) of an open bunker; sealed ones shrink to SEALED_W of it. */
const RADIUS = 1.5;
const SEALED_W = 0.45;
/** Far beams widen to stay at least ~this many metres per metre of distance (a few pixels wide anywhere on the map). */
const MIN_ANGULAR = 0.004;
/** WebGPURenderer tone-maps unlit materials: pre-boost so the beam reads. */
const BOOST = 2.4;
const MAX = 16;
/** ?nobeacons: perf A/B (tests/visual/perfMatch.mjs --query=nobeacons). */
const NO_BEACONS = perfOff('nobeacons');

function upload(a: THREE.InstancedBufferAttribute, n: number) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }

/**
 * Island beacons: a soft light column in the owner's colour (team colour in team modes) rising from every living
 * player's bunker, so you can tell whose island is whose from anywhere. Sealed bunker → a thinner, dimmer beam
 * that flickers like a failing light; owner eliminated → a bright burst, then the beam collapses down into the
 * bunker and is gone (beaconState.ts has the state machine). All beams are ONE instanced, additive, depth-tested
 * draw (no lights, no shadows); positions, widths and the animation live in three small instance buffers.
 */
export class IslandBeacons {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  readonly states = new BeaconStates();
  private base: { x: number; y: number; z: number }[] = [];
  private colors: THREE.Color[] = [];
  private readonly pos = new Float32Array(MAX * 4); // x y z radius
  private readonly col = new Float32Array(MAX * 4); // r g b seed
  private readonly par = new Float32Array(MAX * 4); // seal cut flash -
  private readonly posA = new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage);
  private readonly colA = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
  private readonly parA = new THREE.InstancedBufferAttribute(this.par, 4).setUsage(THREE.DynamicDrawUsage);
  /** Day/night/weather brightness. */
  private readonly gain = uniform(1);

  constructor(private sky: SkyLighting, scene: THREE.Scene) {
    const P = instancedBufferAttribute(this.posA, 'vec4') as unknown as THREE.Node<'vec4'>;
    const C = instancedBufferAttribute(this.colA, 'vec4') as unknown as THREE.Node<'vec4'>;
    const S = instancedBufferAttribute(this.parA, 'vec4') as unknown as THREE.Node<'vec4'>;
    const seal = S.x, cut = S.y, flash = S.z, seed = C.w;
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false });
    mat.name = 'islandBeacon';

    // Vertex: an open unit cylinder stretched to the beam; far away it widens so it stays a few pixels across.
    const g = positionGeometry;
    const camD = length(vec2(cameraPosition.x.sub(P.x), cameraPosition.z.sub(P.z)));
    const r = max(P.w, camD.mul(MIN_ANGULAR).mul(P.w.div(RADIUS)));
    mat.positionNode = vec3(P.x.add(g.x.mul(r)), P.y.add(g.y.mul(HEIGHT)), P.z.add(g.z.mul(r)));

    // Fragment: bright core, soft edges (facing ratio), energy drifting upward, fading out high in the sky.
    const v = uv().y; // 0 at the base, 1 at the top
    const core = pow(abs(dot(normalView, positionViewDirection)), float(1.8));
    const rise = smoothstep(0, 0.012, v).mul(float(1).sub(smoothstep(0.25, 1, v)));
    const flowA = sin(v.mul(HEIGHT * 0.09).sub(time.mul(3.2)).add(seed.mul(6.3))).mul(0.5).add(0.5);
    const flowB = sin(uv().x.mul(Math.PI * 4).add(v.mul(HEIGHT * 0.025)).sub(time.mul(1.1)).add(seed.mul(17))).mul(0.5).add(0.5);
    const energy = float(0.72).add(flowA.mul(flowB).mul(0.5));
    // Sealed: dimmer, with brief dropouts like a failing light (two beating sines → irregular off-blinks).
    const blink = sin(time.mul(17).add(seed.mul(5))).mul(sin(time.mul(5.3).add(seed.mul(11))));
    const sealedLook = float(0.42).mul(float(0.3).add(step(-0.55, blink).mul(0.7)));
    const sealK = mix(float(1), sealedLook, seal);
    // Shutdown: everything above `cut` is gone, with a hot band at the falling edge; the burst brightens it all.
    const below = float(1).sub(smoothstep(cut.sub(0.01), cut, v));
    const edge = float(1).sub(smoothstep(0, 0.035, abs(v.sub(cut)))).mul(step(cut, 0.999)).mul(2.5);
    // Distance: soft when you stand right at it (inside/next to your bunker), a little fainter far away.
    const d = length(positionWorld.sub(cameraPosition));
    const near = smoothstep(2, 22, d);
    const far = mix(float(1), float(0.6), smoothstep(150, 900, d));
    const k = core.mul(rise).mul(energy).mul(sealK).mul(below.add(edge)).mul(flash.mul(2.5).add(1)).mul(near).mul(far).mul(this.gain);
    mat.colorNode = C.xyz.mul(BOOST).add(flash.mul(1.5));
    mat.opacityNode = k;

    const cyl = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true).translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(cyl.index);
    for (const k of ['position', 'normal', 'uv']) geo.setAttribute(k, cyl.getAttribute(k));
    geo.instanceCount = 1;
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'islandBeacons';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** The match's islands and their colours (Renderer.setMap). */
  setMap(map: readonly IslandLayout[], colorOf: (island: number) => number) {
    // From the bunker roof up: the part inside the bunker would only glare at its owner.
    this.base = map.map((isl) => ({ x: isl.bunker.center.x, y: isl.groundY + MAP.bunker.height + 0.25, z: isl.bunker.center.z }));
    this.colors = map.map((isl) => new THREE.Color(colorOf(isl.index)));
    this.states.reset();
  }

  /** Every snapshot (live, replay, spectate, after a host migration: it's all snapshot state). */
  sync(snap: Snapshot, sound: boolean) {
    const started = this.states.sync(snap.players, snap.sealed, snap.suddenDeath);
    if (!sound) return;
    // Heard map-wide (2D, soft): a player leaving the game is news wherever you are.
    if (started.length) playSfx('beaconDown', null, { gain: 0.6 });
  }

  /** Replay seek: show the new time as it is (no shutdown animations for what happened in between). */
  reset() { this.states.reset(); }

  /** Per frame. `on` = the Island beacons setting. */
  frame(dt: number, on: boolean) {
    const st = this.states;
    st.step(dt);
    let n = 0;
    if (on && !NO_BEACONS) for (let i = 0; i < st.count && i < this.base.length && n < MAX; i++) {
      const e = st.at(i);
      if (e.phase === 'gone') continue;
      const b = this.base[i], c = this.colors[i], o = n * 4;
      const w = RADIUS * (1 - (1 - SEALED_W) * e.seal) * (1 + 0.6 * e.flash) * (0.35 + 0.65 * Math.max(e.cut, 0.0001) ** 0.3);
      this.pos[o] = b.x; this.pos[o + 1] = b.y; this.pos[o + 2] = b.z; this.pos[o + 3] = w;
      this.col[o] = c.r; this.col[o + 1] = c.g; this.col[o + 2] = c.b; this.col[o + 3] = i * 0.618;
      this.par[o] = e.seal; this.par[o + 1] = e.cut; this.par[o + 2] = e.flash; this.par[o + 3] = 0;
      n++;
    }
    this.mesh.visible = n > 0;
    if (n === 0) return;
    this.geo.instanceCount = n;
    upload(this.posA, n); upload(this.colA, n); upload(this.parA, n);
    // Readable by day against a bright sky, soft (not blinding) at night when bloom makes it glow; a bit stronger in
    // the storm's gloom so it cuts through the rain.
    const L = this.sky.lighting;
    this.gain.value = (1 - 0.45 * L.night) * (1 + 0.2 * L.weather);
  }
}

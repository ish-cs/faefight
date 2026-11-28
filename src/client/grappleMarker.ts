import type * as THREE from 'three/webgpu';
import { aimDir } from '../sim/combat';
import { PLAYER } from '../sim/constants';
import { grappleAim, physicsAimWorld, type AimTarget, type AimWorld } from '../sim/grappleAim';
import type { Physics } from '../sim/physics';
import type { PlayerState, Vec3 } from '../sim/types';

/**
 * Grapple aim marker: while the hook is in hand, a red X where it would bite (a ring when it locks onto a player, a
 * small caret over the X when it snapped up onto a ledge top), dim while the hook is cooling down, hidden when nothing
 * in reach would take it. Worked out every frame with the sim's own rule (grappleAim.ts) against the predictor's world
 * from the same eye ray the sim fires along, so it never shows a spot the hook wouldn't take. One DOM element, no
 * draw calls; nothing runs while the hook isn't held. Players are taken where they are drawn (`seen`), as the host's
 * lag compensation rewinds them to the moment the click was made.
 */
export class GrappleMarker {
  private readonly el: HTMLDivElement;
  private readonly eye: Vec3 = { x: 0, y: 0, z: 0 };
  private shown = '';
  private world: AimWorld | null = null;
  private physics: Physics | null = null;

  /** `v`: a scratch vector (three.js comes in lazily: no static import here, or the phone card would pull it in). */
  constructor(private readonly v: THREE.Vector3, parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'grapple-marker';
    this.el.innerHTML =
      '<svg viewBox="-12 -12 24 24" width="26" height="26" aria-hidden="true">' +
      '<g class="gm-x"><path d="M-6 -6 L6 6 M6 -6 L-6 6" /></g>' +
      '<circle class="gm-ring" r="9" />' +
      '<path class="gm-up" d="M-4 -9 L0 -12 L4 -9" />' +
      '</svg>';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  /** Hide (hook not in hand, dead, spectating). */
  hide() { this.set(''); }

  /**
   * Show where `me`'s hook would bite. `feet`: my predicted feet; yaw/pitch: the sim aim this frame (after the
   * third-person crosshair fix-up); `ready`: off cooldown with a hook to spend. Returns the target (or null).
   */
  update(physics: Physics, range: number, waterY: number, me: PlayerState, feet: Vec3, yaw: number, pitch: number,
    players: readonly PlayerState[], now: number, ready: boolean, camera: THREE.Camera, seen?: (q: PlayerState) => Vec3 | null): AimTarget | null {
    if (this.physics !== physics || !this.world || this.world.range !== range || this.world.waterY !== waterY) {
      this.physics = physics;
      this.world = physicsAimWorld(physics, range, waterY);
    }
    // Players where I see them (interpolated): the host rewinds to exactly that view when the hook fires (viewT).
    this.world.seen = seen;
    const eye = this.eye;
    eye.x = feet.x; eye.y = feet.y + PLAYER.eyeHeight; eye.z = feet.z;
    const t = grappleAim(this.world, me, eye, aimDir(yaw, pitch), players, now);
    if (!t) { this.set(''); return null; }
    this.v.set(t.point.x, t.point.y, t.point.z).project(camera);
    if (this.v.z > 1 || this.v.z < -1) { this.set(''); return t; }
    const x = (this.v.x * 0.5 + 0.5) * window.innerWidth, y = (-this.v.y * 0.5 + 0.5) * window.innerHeight;
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    this.set(`${t.kind === 'player' ? 'player' : t.ledge ? 'ledge' : 'world'}${ready ? '' : ' cool'}`);
    return t;
  }

  private set(cls: string) {
    if (cls === this.shown) return;
    this.shown = cls;
    this.el.style.display = cls ? '' : 'none';
    this.el.className = `grapple-marker ${cls}`;
  }
}

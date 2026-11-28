/**
 * Sniper scope sway: the crosshair drifts in a slow figure-of-eight while you look through the scope, a lot less when
 * you stand still. It moves the local look angles (like recoil recovery), so what you see is where the shot goes and
 * the sim, bots and wire format are untouched. Eases in on scoping and back out (to no offset) on unscoping.
 */
/** Sway radius (rad) walking scoped; standing still it is STILL × that. */
export const SWAY_RAD = 0.0035;
export const STILL = 0.3;
/** Below this ground speed (m/s) you count as still. */
const STILL_SPEED = 0.4;
/** How fast the sway amount follows (1/s). */
const EASE = 4;

export class ScopeSway {
  dYaw = 0;
  dPitch = 0;
  private t = 0;
  private k = 0;
  private ox = 0;
  private oy = 0;

  /** One frame; afterwards dYaw/dPitch hold this frame's look change. */
  step(dt: number, scoped: boolean, speed: number) {
    this.t += dt;
    const want = scoped ? (speed < STILL_SPEED ? STILL : 1) : 0;
    this.k += (want - this.k) * Math.min(1, dt * EASE);
    if (!scoped && this.k < 1e-4) this.k = 0;
    const a = SWAY_RAD * this.k, t = this.t;
    const x = a * (Math.sin(t * 0.9) + 0.35 * Math.sin(t * 2.3 + 1.7));
    const y = a * 0.7 * (Math.sin(t * 1.8 + 0.6) + 0.35 * Math.sin(t * 2.9));
    this.dYaw = x - this.ox;
    this.dPitch = y - this.oy;
    this.ox = x; this.oy = y;
  }
}

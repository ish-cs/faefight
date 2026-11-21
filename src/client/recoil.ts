/**
 * Client-side recoil delivery and recovery for the local player's look angles.
 *
 * The sim decides each shot's kick (gunplay.recoilKick, deterministic, sent with the shot) and adds it to
 * the shooter's aim; we feed the same kick into the camera over ~50 ms so it reads as a kick. Once a burst
 * stops, part of the climb eases back by itself (CS/Valorant-style recovery): that is only the local
 * player's own look input changing, exactly as if they pulled the mouse down, so the sim, bots and the
 * wire format are untouched. Mouse movement against the climb pays the recovery off, so a player who
 * compensates by hand is never corrected twice.
 */

/** Share of each kick that recovers by itself after a burst (the rest you pull down yourself). */
export const RECOVER_FRAC = 0.6;
/** Seconds without a new kick before recovery starts (sustained fire keeps the full climb). */
export const RECOVER_DELAY = 0.12;
/** Recovery rate (1/s): most of it is back within ~0.3 s. */
const RECOVER_RATE = 10;
/** Kick delivery rate (1/s): ~50 ms. */
const DELIVER_RATE = 45;

export class RecoilRecovery {
  /** This step's look change (rad), set by step(). */
  dPitch = 0;
  dYaw = 0;
  private pendPitch = 0;
  private pendYaw = 0;
  private debtPitch = 0;
  private debtYaw = 0;
  private since = Infinity;

  /** One shot's kick (rad; pitch up positive). */
  kick(pitch: number, yaw: number) {
    this.pendPitch += pitch;
    this.pendYaw += yaw;
    this.debtPitch += pitch * RECOVER_FRAC;
    this.debtYaw += yaw * RECOVER_FRAC;
    this.since = 0;
  }

  /** The player's own look movement (rad): moving against the outstanding recovery pays it off. */
  mouse(dPitch: number, dYaw: number) {
    this.debtPitch = payOff(this.debtPitch, dPitch);
    this.debtYaw = payOff(this.debtYaw, dYaw);
  }

  reset() {
    this.pendPitch = this.pendYaw = this.debtPitch = this.debtYaw = 0;
    this.dPitch = this.dYaw = 0;
    this.since = Infinity;
  }

  /** Advance by dt seconds; the look change to apply is left in dPitch / dYaw. */
  step(dt: number) {
    this.since += dt;
    const k = 1 - Math.exp(-DELIVER_RATE * dt);
    const dp = Math.abs(this.pendPitch) < 1e-6 ? this.pendPitch : this.pendPitch * k;
    const dy = Math.abs(this.pendYaw) < 1e-6 ? this.pendYaw : this.pendYaw * k;
    this.pendPitch -= dp; this.pendYaw -= dy;
    let rp = 0, ry = 0;
    if (this.since >= RECOVER_DELAY && (this.debtPitch !== 0 || this.debtYaw !== 0)) {
      const r = 1 - Math.exp(-RECOVER_RATE * dt);
      rp = Math.abs(this.debtPitch) < 1e-6 ? this.debtPitch : this.debtPitch * r;
      ry = Math.abs(this.debtYaw) < 1e-6 ? this.debtYaw : this.debtYaw * r;
      this.debtPitch -= rp; this.debtYaw -= ry;
    }
    this.dPitch = dp - rp;
    this.dYaw = dy - ry;
  }
}

/** Outstanding recovery `debt` after a look move `d`: only movement opposite to the kick counts. */
function payOff(debt: number, d: number): number {
  if (debt > 0 && d < 0) return Math.max(0, debt + d);
  if (debt < 0 && d > 0) return Math.min(0, debt + d);
  return debt;
}

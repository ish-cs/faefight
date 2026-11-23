/**
 * Island beacon state machine (no three.js: unit-tested in tests/client/beacons.test.ts). One beacon per island,
 * driven only by snapshot state, so replays, spectating and host migration all show the same thing:
 *
 *   open    the bunker is open: full beam.
 *   sealed  the bunker is sealed (or sudden death sealed every bunker): `seal` eases 0 → 1 and the renderer draws a
 *           thinner, dimmer beam that flickers like a failing light. Unsealing eases it back to full.
 *   down    every owner of the island is eliminated: shutdown animation (`flash` burst, then `cut` drops 1 → 0, the
 *           beam collapsing down into the bunker), reported once by sync() so the caller can play the sound.
 *   gone    nothing drawn (no owner, eliminated, or the shutdown finished).
 *
 * First sight after construction or reset() (joining late, a replay seek) snaps to the current state: no fades,
 * no shutdown animation for players who were already out.
 */

export const BEACON = {
  /** Seconds to ease between the open and sealed looks. */
  sealSec: 0.6,
  /** Shutdown animation length (s). */
  downSec: 1.6,
  /** The bright burst at the start of a shutdown (s). */
  flashSec: 0.25,
  /** Part of the shutdown spent on the flash before the beam starts falling. */
  holdSec: 0.15,
} as const;

export type BeaconPhase = 'open' | 'sealed' | 'down' | 'gone';

export type BeaconEntry = {
  phase: BeaconPhase;
  /** 0 = open look, 1 = sealed look (eased). */
  seal: number;
  /** Visible height fraction from the base (1 = full beam, 0 = collapsed). */
  cut: number;
  /** Shutdown burst 1 → 0. */
  flash: number;
  /** Seconds into the shutdown. */
  downT: number;
  // per-sync scratch
  owners: number;
  out: number;
};

const entry = (): BeaconEntry => ({ phase: 'gone', seal: 0, cut: 1, flash: 0, downT: 0, owners: 0, out: 0 });

export class BeaconStates {
  private list: BeaconEntry[] = [];
  /** False until the first sync after construction / reset(): that one snaps instead of animating. */
  private seen = false;
  private started: number[] = [];

  /** Forget history (replay seek): the next sync shows the state as-is. */
  reset() { this.seen = false; }

  get count() { return this.list.length; }

  /** Island `i`'s beacon (a 'gone' one if the island has none). */
  at(i: number): BeaconEntry {
    while (this.list.length <= i) this.list.push(entry());
    return this.list[i];
  }

  /**
   * A snapshot's state. Returns the islands whose beacon just started shutting down (the array is reused: read it
   * before the next call).
   */
  sync(players: readonly { island: number; eliminated: boolean }[], sealed: readonly boolean[], suddenDeath: boolean): number[] {
    const started = this.started;
    started.length = 0;
    for (const e of this.list) { e.owners = 0; e.out = 0; }
    for (const p of players) {
      if (p.island < 0) continue;
      const e = this.at(p.island);
      e.owners++;
      if (p.eliminated) e.out++;
    }
    this.at(sealed.length - 1);
    const first = !this.seen;
    this.seen = true;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      const live = e.owners > 0 && e.out < e.owners;
      const shut = suddenDeath || !!sealed[i];
      if (!live) {
        if (e.owners > 0 && !first && (e.phase === 'open' || e.phase === 'sealed')) {
          e.phase = 'down'; e.downT = 0; e.flash = 1;
          started.push(i);
        } else if (e.phase !== 'down') {
          e.phase = 'gone'; e.cut = 0; e.flash = 0;
        }
        continue;
      }
      const was = e.phase;
      e.phase = shut ? 'sealed' : 'open';
      // A new beam (first sight, a replay seek back before the elimination, a late owner) shows its state at once.
      if (first || was === 'gone' || was === 'down') { e.seal = shut ? 1 : 0; e.cut = 1; e.flash = 0; e.downT = 0; }
    }
    return started;
  }

  /** Advance the animations by `dt` seconds (per rendered frame). */
  step(dt: number) {
    for (const e of this.list) {
      if (e.phase === 'open' || e.phase === 'sealed') {
        const target = e.phase === 'sealed' ? 1 : 0;
        const d = dt / BEACON.sealSec;
        e.seal = e.seal < target ? Math.min(target, e.seal + d) : Math.max(target, e.seal - d);
        continue;
      }
      if (e.phase !== 'down') continue;
      e.downT += dt;
      e.flash = Math.max(0, 1 - e.downT / BEACON.flashSec);
      const k = Math.min(1, Math.max(0, (e.downT - BEACON.holdSec) / (BEACON.downSec - BEACON.holdSec)));
      e.cut = 1 - k * k; // accelerates: the beam drops into the bunker
      if (e.downT >= BEACON.downSec) { e.phase = 'gone'; e.cut = 0; e.flash = 0; }
    }
  }
}

/**
 * Whose eyes the HUD, screen effects and audio show: the player the spectator camera follows (bot or human),
 * else the local player. One id for hit markers, damage numbers, hit arcs, vignettes, alerts, compass,
 * banners, death recap and the "own" sounds, so spectating looks like what they see.
 */
export function viewedPlayer(humanId: number, following: number | null): number {
  return following ?? humanId;
}

/**
 * Player references (`@id`) in bot-brain text as words: the local player is "you" / "your" (capitalised at the
 * start), anyone else by name ("Marco's").
 */
export function personalize(text: string, selfId: number, nameOf: (id: number) => string): string {
  return text.replace(/@(\d+)('s)?/g, (_m: string, n: string, poss: string | undefined, at: number) => {
    const id = Number(n);
    if (id !== selfId || selfId <= 0) return nameOf(id) + (poss ?? '');
    const w = poss ? 'your' : 'you';
    return at === 0 ? w[0].toUpperCase() + w.slice(1) : w;
  });
}

/** Watching someone else (not our own player)? */
export const viewingOther = (humanId: number, viewed: number) => viewed !== humanId;

/**
 * Spectator camera mode: through the watched player's own camera (their `view`; bots are third person),
 * flipped while the spectator presses the camera key. The flip is relative to the local camera setting at
 * the moment the target (or their camera) last changed, so following someone new starts from their view.
 */
export class SpectatorCamera {
  private key = '';
  private base: 'first' | 'third' = 'third';

  firstPerson(followId: number | null, watchedView: 0 | 1 | undefined, localMode: 'first' | 'third'): boolean {
    const v = watchedView ?? 0;
    const key = `${followId}:${v}`;
    if (key !== this.key) { this.key = key; this.base = localMode; }
    return (v === 1) !== (localMode !== this.base);
  }
}

/** How long the spectator camera stays on a followed player who just died, looking at their killer. */
export const BODYCAM_SEC = 3;

/**
 * Body cam: the spectator camera holds on a followed player who just died, turned toward their killer.
 * Only the fallback: the killer-view replay (qol/killcam.ts) plays instead whenever there's enough of the
 * killer on record (main.ts decides).
 */
export class BodyCam {
  victim: number | null = null;
  killer: number | null = null;
  until = -Infinity;

  /** Snapshot events; `followId` = who the spectator follows; `now` in seconds. */
  onEvents(events: { type: string; data: Record<string, unknown> }[], followId: number | null, now: number) {
    if (followId === null) return;
    for (const e of events) {
      if (e.type !== 'kill') continue;
      const victim = e.data.victim ?? e.data.target, killer = e.data.killer ?? e.data.by;
      if (victim !== followId) continue;
      this.victim = followId;
      this.killer = typeof killer === 'number' && killer !== followId ? killer : null;
      this.until = now + BODYCAM_SEC;
    }
  }

  /** Running for this followed player right now? */
  active(followId: number | null, now: number): boolean {
    return this.victim !== null && this.victim === followId && now < this.until;
  }
}

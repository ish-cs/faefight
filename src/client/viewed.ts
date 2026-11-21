/**
 * Whose eyes the HUD, screen effects and audio show: the player the spectator camera follows (bot or human),
 * else the local player. One id for hit markers, damage numbers, hit arcs, vignettes, alerts, compass,
 * banners, death recap and the "own" sounds, so spectating looks like what they see.
 */
export function viewedPlayer(humanId: number, following: number | null): number {
  return following ?? humanId;
}

/** Watching someone else (not our own player)? */
export const viewingOther = (humanId: number, viewed: number) => viewed !== humanId;

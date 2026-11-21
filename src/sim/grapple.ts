import { GRAPPLE, PLAYER } from './constants';
import { aimDir, eyePos } from './combat';
import { removeIfEmpty, setGrapples } from './hotbar';
import type { RayHit } from './physics';
import type { MatchEvent, PieceState, PlayerState, Vec3 } from './types';
import { add, dist, scale, v3 } from './vec';

/**
 * Grappling hook. Fired from the selected hotbar slot: the hook flies out along the aim (hitscan picks the
 * point, the hook takes dist / GRAPPLE.tipSpeed to get there). On the world (terrain, docks, props, pieces,
 * cranes) it reels its owner in (movement.ts stepPull: mv.pull); on a player it yanks them toward the owner;
 * water, sky or too close is a miss and the rope comes back. A use is spent only when the hook latches.
 *
 * Rules: the rope never passes firing slits; a yank needs clear line of sight from the owner's eye to the
 * target at the moment it latches (no pulling through walls), and never takes a spawn-protected player or one
 * trapped in a sealed bunker. Hooking a player ends the owner's own spawn protection, like firing.
 */
export type GrappleCtx = {
  players: Map<number, PlayerState>;
  pieces: Map<number, PieceState>;
  waterY: number;
  /** The hook's ray from the eye: first world / piece / player hit, blocked by firing slits. */
  cast(origin: Vec3, dir: Vec3, maxDist: number, shooter: number): RayHit | null;
  /** True when nothing solid (players aside) sits between a and b. */
  clear(a: Vec3, b: Vec3): boolean;
};

const ev = (t: number, data: Record<string, unknown>): MatchEvent => ({ t, type: 'grapple', data });
const chest = (q: PlayerState): Vec3 => v3(q.pos.x, q.pos.y + PLAYER.height * 0.6, q.pos.z);

/** Why a hook couldn't take this player now (null = it can). */
export function unyankable(q: PlayerState | undefined, now: number): string | null {
  if (!q || !q.alive) return 'gone';
  if (q.spawnProtected || q.invulnUntil > now) return 'spawn protected';
  if (q.breakoutUntil !== null) return 'sealed in';
  return null;
}

/** Fire the hook in the selected slot, or let go of the one that's out. */
export function fireGrapple(ctx: GrappleCtx, p: PlayerState, now: number): MatchEvent[] {
  if (!p.alive) return [];
  if (p.hook) return p.hook.st === 3 ? [] : release(ctx, p, now);
  if (p.hotbar[p.selected] !== 'grapple' || (p.inv.grapples ?? 0) <= 0) return [];
  if (now < (p.hookReadyAt ?? 0) || now < p.busyUntil || p.mv?.pull) return [];
  const eye = eyePos(p), dir = aimDir(p.yaw, p.pitch);
  const hit = ctx.cast(eye, dir, GRAPPLE.range, p.id);
  const ok = hit !== null && hit.dist >= GRAPPLE.minDist && hit.point.y > ctx.waterY + 0.05;
  const d = hit ? hit.dist : GRAPPLE.range;
  const pt = hit ? hit.point : add(eye, scale(dir, GRAPPLE.range));
  if (!ok) {
    // Out and straight back.
    p.hook = { st: 3, x: pt.x, y: pt.y, z: pt.z, t0: now, at: now + (2 * d) / GRAPPLE.tipSpeed };
    p.hookReadyAt = Math.max(p.hook.at, now + GRAPPLE.missCooldownSec);
    return [ev(now, { by: p.id, phase: 'fire' })];
  }
  p.hook = { st: 0, x: pt.x, y: pt.y, z: pt.z, t0: now, at: now + d / GRAPPLE.tipSpeed };
  if (hit.hit.type === 'player') p.hook.tgt = hit.hit.id;
  else if (hit.hit.type === 'piece') p.hook.pc = hit.hit.id;
  return [ev(now, { by: p.id, phase: 'fire' })];
}

/** Advance a player's hook: latch when it arrives, end it when its pull is over. Call once per tick, before moving. */
export function tickGrapple(ctx: GrappleCtx, p: PlayerState, now: number): MatchEvent[] {
  const h = p.hook;
  if (!h) return [];
  if (h.st === 3) {
    if (now >= h.at - 1e-9) delete p.hook;
    return [];
  }
  if (h.st === 0) return now >= h.at - 1e-9 ? latch(ctx, p, h, now) : [];
  if (h.st === 1) {
    const broke = h.pc !== undefined && !ctx.pieces.has(h.pc);
    if (p.mv?.pull && !p.mv.pull.yank && !broke) return [];
    return release(ctx, p, now);
  }
  const q = ctx.players.get(h.tgt ?? -1);
  if (q?.alive && q.mv?.pull?.yank) return [];
  return release(ctx, p, now);
}

function latch(ctx: GrappleCtx, p: PlayerState, h: NonNullable<PlayerState['hook']>, now: number): MatchEvent[] {
  const eye = eyePos(p);
  if (h.tgt !== undefined) {
    const q = ctx.players.get(h.tgt);
    const why = unyankable(q, now);
    const c = q ? chest(q) : null;
    if (!why && q && c && dist(eye, c) <= GRAPPLE.range + 3 && ctx.clear(eye, c)) {
      spend(p);
      h.st = 2;
      // Drag them in: a target at your feet (a little up, so they come off the ground), stopping short of you.
      const mv = q.mv;
      if (mv) mv.pull = { x: p.pos.x, y: p.pos.y + 0.6, z: p.pos.z, left: GRAPPLE.yankSec, yank: true };
      if (q.hook && q.hook.st !== 3) release(ctx, q, now); // their own hook lets go
      if (q.emote) delete q.emote;
      p.spawnProtected = false;
      p.invulnUntil = Math.min(p.invulnUntil, now);
      return [ev(now, { by: p.id, phase: 'yank', target: q.id })];
    }
    return miss(p, h, now, eye);
  }
  if (h.pc !== undefined && !ctx.pieces.has(h.pc)) return miss(p, h, now, eye);
  spend(p);
  h.st = 1;
  if (p.mv) p.mv.pull = { x: h.x, y: h.y, z: h.z, left: GRAPPLE.pullSec };
  return [ev(now, { by: p.id, phase: 'latch' })];
}

function miss(p: PlayerState, h: NonNullable<PlayerState['hook']>, now: number, eye: Vec3): MatchEvent[] {
  h.st = 3;
  h.at = now + dist(eye, h) / GRAPPLE.tipSpeed;
  delete h.tgt; delete h.pc;
  p.hookReadyAt = Math.max(h.at, now + GRAPPLE.missCooldownSec);
  return [ev(now, { by: p.id, phase: 'miss' })];
}

function spend(p: PlayerState) {
  setGrapples(p.inv, (p.inv.grapples ?? 0) - 1);
  removeIfEmpty(p.hotbar, p.inv);
}

/** Let go: the rope stops pulling (whoever it pulls) and reels back; cooldown starts. */
export function release(ctx: GrappleCtx, p: PlayerState, now: number): MatchEvent[] {
  const h = p.hook;
  if (!h) return [];
  if (h.st === 1 && p.mv?.pull && !p.mv.pull.yank) delete p.mv.pull;
  if (h.st === 2) {
    const q = ctx.players.get(h.tgt ?? -1);
    if (q?.mv?.pull?.yank) delete q.mv.pull;
  }
  delete p.hook;
  p.hookReadyAt = now + (h.st === 0 ? GRAPPLE.missCooldownSec : GRAPPLE.cooldownSec);
  return [ev(now, { by: p.id, phase: 'release' })];
}

/** A dead player drops their rope and comes off anyone else's. */
export function clearGrapple(ctx: GrappleCtx, p: PlayerState, now: number): void {
  if (p.hook) release(ctx, p, now);
  if (p.mv?.pull) delete p.mv.pull;
}

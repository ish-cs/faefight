import { GRAPPLE, PLAYER, WEAPONS } from '../constants';
import { aimDir, eyePos } from '../combat';
import { unyankable } from '../grapple';
import type { PlayerState, Vec3, WeaponKind } from '../types';
import { dist, dist2D, norm, sub, v3, yawOf } from '../vec';
import type { NavNode } from './nav';
import type { HookParams } from './params';
import type { BotView } from './view';

/**
 * Bots and the grappling hook (sim/grapple.ts). Three uses, checked a few times a second:
 * - cross: hook over to the island I'm heading for when I can't walk there (skips building a bridge);
 * - escape: nearly dead with an enemy close: hook away to solid ground on the far side from them;
 * - yank: drag an enemy over when it pays: open water between us (they drop in), they hold high ground, or my gun
 *   wants them closer.
 * Decisions only; Bot.think aims (its normal aim skill for a yank) and fires the hook.
 */
export type HookIntent =
  | { why: 'cross' | 'escape'; to: Vec3; node: number; note: string }
  | { why: 'yank'; target: number; note: string };

/** Can I fire my hook right now (have one, it's back, hands free, not on a rope)? */
export function hookReady(me: PlayerState, now: number): boolean {
  return me.alive && (me.inv.grapples ?? 0) > 0 && me.hotbar.includes('grapple') && !me.hook && !me.mv?.pull &&
    now >= (me.hookReadyAt ?? 0) && me.busyUntil <= now && me.healAt === null && !me.drinking;
}

/** A point on `node` to hook so I land on it, if one is in reach and the rope would catch there. */
export function crossTo(view: BotView, P: HookParams, node: NavNode): HookIntent | null {
  const me = view.self, eye = eyePos(me);
  const dx = node.center.x - me.pos.x, dz = node.center.z - me.pos.z;
  const dl = Math.hypot(dx, dz);
  if (dl <= node.radius) return null;
  const along = dl - node.radius + P.crossInset;
  const to = v3(me.pos.x + (dx / dl) * along, node.groundY + 0.3, me.pos.z + (dz / dl) * along);
  if (dist(eye, to) > Math.min(P.crossMax, GRAPPLE.range - 0.5) || !view.castHook) return null;
  const hit = view.castHook(norm(sub(to, eye)));
  if (!hit || hit.player !== null || hit.dist < GRAPPLE.minDist || hit.point.y < view.waterY + 0.5) return null;
  if (dist2D(hit.point, node.center) > node.radius + 0.5) return null;
  return { why: 'cross', to: hit.point, node: node.index, note: `Hooking over to ${node.index === view.map.length ? 'the center island' : `island ${node.index}`} (${Math.round(hit.dist)} m)` };
}

/** Somewhere solid away from `from` to hook to (furthest of a few headings), if any. */
export function escapeFrom(view: BotView, P: HookParams, from: Vec3, nodeAt: (p: Vec3) => number): HookIntent | null {
  const me = view.self;
  if (!view.castHook) return null;
  const away = yawOf({ x: me.pos.x - from.x, z: me.pos.z - from.z });
  const d0 = dist2D(me.pos, from);
  let best: { to: Vec3; d: number; node: number } | null = null;
  for (const k of [0, 0.5, -0.5, 1, -1]) for (const pitch of [0.06, -0.08]) {
    const hit = view.castHook(aimDir(away + k, pitch));
    if (!hit || hit.player !== null || hit.dist < P.escapeMin || hit.point.y < view.waterY + 0.5) continue;
    const node = nodeAt(hit.point);
    if (node < 0 || dist2D(hit.point, from) < d0 + 5) continue;
    if (!best || hit.dist > best.d) best = { to: hit.point, d: hit.dist, node };
  }
  return best && { why: 'escape', to: best.to, node: best.node, note: `Nearly dead: hooking away (${Math.round(best.d)} m)` };
}

/** Is yanking this enemy worth it now (and why)? `gun`: what I'd fight them with. */
export function yankReason(view: BotView, P: HookParams, e: PlayerState, d: number, gun: WeaponKind): string | null {
  const me = view.self;
  if (d < P.yankMin || d > Math.min(P.yankMax, GRAPPLE.range - 1) || unyankable(e, view.now)) return null;
  const chest = v3(e.pos.x, e.pos.y + PLAYER.height * 0.6, e.pos.z);
  if (view.clearShot && !view.clearShot(chest)) return null;
  // Water between us: a yank from further than it can drag drops them in.
  const reach = GRAPPLE.yankSpeed * GRAPPLE.yankSec + GRAPPLE.yankStop;
  if (d > reach) {
    const t = Math.max(0.2, 1 - reach / d);
    if (view.groundAt(me.pos.x + (e.pos.x - me.pos.x) * t, me.pos.z + (e.pos.z - me.pos.z) * t) === null) return `Yanking @${e.id} into the water`;
  }
  if (e.pos.y - me.pos.y > P.yankHigh) return `Yanking @${e.id} off the high ground`;
  const w = WEAPONS[gun];
  if (d > P.yankFalloff * Math.min(w.falloff.start, w.range)) return `Yanking @${e.id} into ${gun === 'fists' ? 'punching' : `${gun}`} range`;
  return null;
}

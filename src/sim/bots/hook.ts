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
  // Aim into the ground there, not above it: a grazing rope aimed just over the surface flies on past the end of its
  // reach (26 m) without catching anything.
  const to = v3(me.pos.x + (dx / dl) * along, node.groundY - 0.1, me.pos.z + (dz / dl) * along);
  if (dist(eye, to) > Math.min(P.crossMax, (view.hookRange ?? GRAPPLE.range) - 0.5) || !view.castHook) return null;
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

/** Highest lip the capsule steps up onto (physics.ts autostep 0.35 m): deeper than this under a ledge's top is its face. */
const RELEASE_STEP = 0.35;
/** A fling must touch down this close to the anchor (m, flat), on ground at least this far on along the flight. */
const RELEASE_LAND = 4, RELEASE_RUNOUT = [1, 2, 3];

/**
 * On my own elastic rope (movement.ts stepPull): let go now (jump) and fling the rest of the way? Only within
 * P.releaseDist of the anchor, moving toward it, and when the fling (my velocity, capped like any release) comes
 * down on top of solid ground at about the anchor's level near it, with ground ahead to slide out on. Never into a
 * ledge's face (feet under its lip: the capsule stops dead there and drops in the water) and never past a narrow
 * landing. Null = ride it in (the arrival lands me).
 */
export function ropeRelease(view: BotView, P: HookParams, rope: { x: number; y: number; z: number }): string | null {
  const me = view.self;
  const d = dist(me.pos, rope);
  if (P.releaseDist <= 0 || d > P.releaseDist || d < GRAPPLE.arriveDist + 0.4) return null;
  // Sagged below the ledge (gravity on a long rope): ride it in, the rope hauls me up the face; a fling would hit it.
  if (me.pos.y < rope.y - 0.2) return null;
  const sp = Math.hypot(me.vel.x, me.vel.y, me.vel.z);
  if (sp < 4 || (me.vel.x * (rope.x - me.pos.x) + me.vel.y * (rope.y - me.pos.y) + me.vel.z * (rope.z - me.pos.z)) / (sp * d) < 0.5) return null;
  const k = Math.min(1, GRAPPLE.flingMax / sp);
  let x = me.pos.x, y = me.pos.y, z = me.pos.z, vy = me.vel.y * k;
  const vx = me.vel.x * k, vz = me.vel.z * k, hs = Math.hypot(vx, vz), dt = 1 / 30;
  for (let i = 0; i < 60; i++) {
    const py = y;
    x += vx * dt; z += vz * dt; vy -= PLAYER.gravity * dt; y += vy * dt;
    if (y < view.waterY) return null;
    const g = view.groundAt(x, z);
    if (g === null) continue;
    if (py < g - RELEASE_STEP) return null; // into the side of it
    if (y > g || vy >= 0) continue;
    if (g < rope.y - 1.5 || dist2D(v3(x, g, z), rope) > RELEASE_LAND) return null;
    const r = PLAYER.radius;
    if ([[r, 0], [-r, 0], [0, r], [0, -r]].filter(([ox, oz]) => view.groundAt(x + ox, z + oz) !== null).length < 3) return null;
    if (hs > 0.1) for (const a of RELEASE_RUNOUT) {
      const h = view.groundAt(x + vx / hs * a, z + vz / hs * a);
      if (h === null || h < g - 1) return null; // the slide after touchdown runs off the edge
    }
    return `Letting go of the rope ${d.toFixed(1)} m out: flinging onto the ledge`;
  }
  return null;
}

/** Is yanking this enemy worth it now (and why)? `gun`: what I'd fight them with. */
export function yankReason(view: BotView, P: HookParams, e: PlayerState, d: number, gun: WeaponKind): string | null {
  const me = view.self;
  if (d < P.yankMin || d > Math.min(P.yankMax, (view.hookRange ?? GRAPPLE.range) - 1) || unyankable(e, view.now)) return null;
  // The rope must reach them: the hook's own ray at their chest catches them first.
  const chest = v3(e.pos.x, e.pos.y + PLAYER.height * 0.6, e.pos.z);
  const hit = view.castHook?.(norm(sub(chest, eyePos(me))));
  if (!hit || hit.player !== e.id) return null;
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

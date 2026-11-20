import { CHARGE, DT, GRENADE, PIECES, PLAYER, SHOTGUN_SPREAD_DEG, WEAPONS } from './constants';
import { damagePiece } from './building';
import type { Physics } from './physics';
import type { MatchEvent, PieceState, PlayerState, Vec3 } from './types';
import { add, dist, forward, norm, right, scale, v3 } from './vec';

export type Explosive = { id: number; kind: 'grenade' | 'charge'; owner: number; pos: Vec3; vel: Vec3; explodeAt: number };

export type CombatCtx = {
  physics: Physics;
  players: Map<number, PlayerState>;
  pieces: Map<number, PieceState>;
  explosives: Explosive[];
  nextId(): number;
  onPieceDestroyed(id: number): void;
  onKill(victim: number, killer: number | null): void;
};

const ev = (t: number, type: MatchEvent['type'], data: Record<string, unknown>): MatchEvent => ({ t, type, data });

export const eyePos = (p: PlayerState): Vec3 => v3(p.pos.x, p.pos.y + PLAYER.eyeHeight, p.pos.z);

export const aimDir = (yaw: number, pitch: number): Vec3 => {
  const c = Math.cos(pitch);
  return v3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
};

/** Deterministic shotgun pattern: pellet 0 dead center, the rest on a ring. */
function pelletDir(yaw: number, pitch: number, i: number, n: number): Vec3 {
  if (i === 0 || n === 1) return aimDir(yaw, pitch);
  const spread = (SHOTGUN_SPREAD_DEG * Math.PI) / 180;
  const a = (2 * Math.PI * (i - 1)) / (n - 1);
  return aimDir(yaw + Math.cos(a) * spread, pitch + Math.sin(a) * spread);
}

export function applyPlayerDamage(ctx: CombatCtx, target: PlayerState, amount: number, attackerId: number | null, now: number): MatchEvent[] {
  if (!target.alive || now < target.invulnUntil) return [];
  target.hp -= amount;
  const out = [ev(now, 'hit', { target: target.id, by: attackerId, amount })];
  if (target.hp <= 0) {
    target.hp = 0;
    ctx.onKill(target.id, attackerId);
  }
  return out;
}

function hitPiece(ctx: CombatCtx, id: number, amount: number, source: 'bullet' | 'fist' | 'explosive', now: number): MatchEvent[] {
  const piece = ctx.pieces.get(id);
  if (!piece) return [];
  if (!damagePiece(piece, amount, source)) return [];
  ctx.onPieceDestroyed(id);
  return [ev(now, 'destroyed', { piece: id, kind: piece.kind })];
}

export function tryFire(ctx: CombatCtx, p: PlayerState, now: number): MatchEvent[] {
  if (!p.alive || now < p.nextFireAt || p.reloadUntil > 0) return [];
  const kind = p.equipped;
  const spec = WEAPONS[kind];
  const ammo = kind === 'fists' ? null : p.inv.weapons[kind];
  if (kind !== 'fists' && !ammo) return [];
  if (ammo && ammo.mag <= 0) { tryReload(p, now); return []; }
  if (ammo) ammo.mag -= 1;
  p.nextFireAt = now + 1 / spec.rps;

  const out: MatchEvent[] = [];
  const eye = eyePos(p);
  for (let i = 0; i < spec.pellets; i++) {
    const dir = pelletDir(p.yaw, p.pitch, i, spec.pellets);
    const hit = ctx.physics.raycast(eye, dir, spec.range, p.id);
    const to = hit ? hit.point : add(eye, scale(dir, spec.range));
    if (i === 0) out.push(ev(now, 'shot', { by: p.id, weapon: kind, from: eye, to }));
    if (!hit) continue;
    if (hit.hit.type === 'player') {
      const target = ctx.players.get(hit.hit.id);
      if (target) out.push(...applyPlayerDamage(ctx, target, spec.dmg, p.id, now));
    } else if (hit.hit.type === 'piece') {
      out.push(...hitPiece(ctx, hit.hit.id, spec.dmg, kind === 'fists' ? 'fist' : 'bullet', now));
    }
  }
  if (ammo && ammo.mag === 0) tryReload(p, now);
  return out;
}

export function tryReload(p: PlayerState, now: number): void {
  const kind = p.equipped;
  if (kind === 'fists' || p.reloadUntil > 0) return;
  const ammo = p.inv.weapons[kind];
  if (!ammo || ammo.spare <= 0 || ammo.mag >= WEAPONS[kind].mag) return;
  p.reloadUntil = now + WEAPONS[kind].reloadSec;
}

/** Finishes a pending reload once its time has passed. Switching weapons cancels (handled by caller). */
export function tickReload(p: PlayerState, now: number): void {
  if (p.reloadUntil <= 0 || now < p.reloadUntil) return;
  p.reloadUntil = 0;
  const kind = p.equipped;
  const ammo = kind === 'fists' ? undefined : p.inv.weapons[kind];
  if (!ammo) return;
  const take = Math.min(WEAPONS[kind].mag - ammo.mag, ammo.spare);
  ammo.mag += take;
  ammo.spare -= take;
}

export function throwGrenade(ctx: CombatCtx, p: PlayerState, now: number): void {
  if (!p.alive || p.inv.grenades <= 0) return;
  p.inv.grenades -= 1;
  const dir = aimDir(p.yaw, p.pitch);
  const vel = add(scale(dir, GRENADE.throwSpeed), v3(0, 3, 0));
  const start = add(eyePos(p), add(scale(right(p.yaw), 0.3), scale(forward(p.yaw), 0.3)));
  ctx.explosives.push({ id: ctx.nextId(), kind: 'grenade', owner: p.id, pos: start, vel, explodeAt: now + GRENADE.fuseSec });
}

export function placeCharge(ctx: CombatCtx, p: PlayerState, now: number): void {
  if (!p.alive || p.inv.charges <= 0) return;
  const eye = eyePos(p);
  const dir = norm(aimDir(p.yaw, 0));
  const hit = ctx.physics.raycast(eye, dir, 2.5, p.id);
  const pos = hit ? add(eye, scale(dir, hit.dist - 0.05)) : add(p.pos, add(scale(dir, 0.8), v3(0, 0.1, 0)));
  p.inv.charges -= 1;
  ctx.explosives.push({ id: ctx.nextId(), kind: 'charge', owner: p.id, pos, vel: v3(), explodeAt: now + CHARGE.fuseSec });
}

const pieceCenter = (pc: PieceState) => v3(pc.pos.x, pc.pos.y + PIECES[pc.kind].h / 2, pc.pos.z);
const bodyCenter = (pl: PlayerState) => v3(pl.pos.x, pl.pos.y + PLAYER.height / 2, pl.pos.z);

function explode(ctx: CombatCtx, e: Explosive, now: number): MatchEvent[] {
  const out: MatchEvent[] = [ev(now, 'explosion', { kind: e.kind, pos: e.pos, by: e.owner })];
  if (e.kind === 'grenade') {
    for (const pl of ctx.players.values()) {
      const d = dist(bodyCenter(pl), e.pos);
      if (d < GRENADE.radius) out.push(...applyPlayerDamage(ctx, pl, GRENADE.dmg * (1 - d / GRENADE.radius), e.owner, now));
    }
    for (const pc of [...ctx.pieces.values()]) {
      const d = dist(pieceCenter(pc), e.pos);
      if (d < GRENADE.radius) out.push(...hitPiece(ctx, pc.id, GRENADE.dmg * (1 - d / GRENADE.radius), 'explosive', now));
    }
  } else {
    for (const pl of ctx.players.values())
      if (dist(bodyCenter(pl), e.pos) < CHARGE.playerRadius) out.push(...applyPlayerDamage(ctx, pl, CHARGE.playerDmg, e.owner, now));
    for (const pc of [...ctx.pieces.values()])
      if (dist(pieceCenter(pc), e.pos) < CHARGE.radius) out.push(...hitPiece(ctx, pc.id, CHARGE.pieceDmg, 'explosive', now));
  }
  return out;
}

/** Moves thrown grenades (simple gravity + stop on first surface) and detonates anything due. */
export function tickExplosives(ctx: CombatCtx, now: number): MatchEvent[] {
  const out: MatchEvent[] = [];
  for (const e of ctx.explosives) {
    if (e.kind !== 'grenade' || (e.vel.x === 0 && e.vel.y === 0 && e.vel.z === 0)) continue;
    e.vel.y -= PLAYER.gravity * DT;
    const step = scale(e.vel, DT);
    const stepLen = Math.hypot(step.x, step.y, step.z);
    const wall = stepLen > 0 ? ctx.physics.raycast(e.pos, scale(step, 1 / stepLen), stepLen, e.owner) : null;
    if (wall) {
      // Hit something on the way: stop just short of it (no bounce).
      e.pos = add(e.pos, scale(step, Math.max(0, wall.dist - 0.1) / stepLen));
      e.vel = v3();
      continue;
    }
    const next = add(e.pos, step);
    const floor = ctx.physics.surfaceBelow(next.x, e.pos.y + 0.05, next.z, e.pos.y - next.y + 0.1);
    if (floor !== null && next.y <= floor) {
      e.pos = v3(next.x, floor + 0.05, next.z);
      e.vel = v3();
    } else {
      e.pos = next;
    }
  }
  const due = ctx.explosives.filter((e) => now >= e.explodeAt);
  ctx.explosives.splice(0, ctx.explosives.length, ...ctx.explosives.filter((e) => now < e.explodeAt));
  for (const e of due) out.push(...explode(ctx, e, now));
  return out;
}

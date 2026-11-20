import {
  CHARGE, DT, GRENADE, HEAD, PIECES, PLAYER, ROCKET, SHOTGUN_ADS_SPREAD_DEG, SHOTGUN_SPREAD_DEG, TICK_HZ, WEAPONS,
} from './constants';
import { damagePiece } from './building';
import { bloomAfterShot, coneOffset, DEG, falloff, hash01, magCap, nextBurst, recoilKick, reloadTime, shellsLoadedBy, spreadDeg } from './gunplay';
import type { Physics } from './physics';
import type { MatchEvent, PieceState, PlayerState, Projectile, Vec3 } from './types';
import { add, dist, forward, norm, right, rotateY, scale, sub, v3 } from './vec';

export type Explosive = { id: number; kind: 'grenade' | 'charge' | 'rocket'; owner: number; pos: Vec3; vel: Vec3; explodeAt: number };

export type CombatCtx = {
  physics: Physics;
  players: Map<number, PlayerState>;
  pieces: Map<number, PieceState>;
  explosives: Explosive[];
  nextId(): number;
  onPieceDestroyed(id: number): void;
  onKill(victim: number, killer: number | null): void;
  /** Whether a player stands on something (spread); defaults to "vertical speed is small". */
  grounded?(id: number): boolean;
  /** A blast pushed this player (velocity change, m/s). */
  onKnockback?(id: number, dv: Vec3): void;
};

const ev = (t: number, type: MatchEvent['type'], data: Record<string, unknown>): MatchEvent => ({ t, type, data });

export const eyePos = (p: PlayerState): Vec3 => v3(p.pos.x, p.pos.y + PLAYER.eyeHeight, p.pos.z);

export const aimDir = (yaw: number, pitch: number): Vec3 => {
  const c = Math.cos(pitch);
  return v3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
};

/**
 * Direction of pellet `i` of a shot: the whole shot is thrown off by a deterministic offset inside the
 * spread cone (seeded per player per tick, so host and replays agree); shotgun pellets 1.. sit on a
 * ring around it with a little seeded jitter.
 */
export function pelletDir(yaw: number, pitch: number, coneDeg: number, seed: number, i: number, n: number, ringDeg: number): Vec3 {
  const o = coneOffset(coneDeg, hash01(seed, 0, 11), hash01(seed, 0, 12));
  let y = yaw + o.yaw, pt = pitch + o.pitch;
  if (i > 0 && n > 1) {
    const a = (2 * Math.PI * (i - 1)) / (n - 1) + (hash01(seed, i, 13) - 0.5) * 0.5;
    const r = ringDeg * DEG * (0.75 + 0.5 * hash01(seed, i, 14));
    y += Math.cos(a) * r;
    pt += Math.sin(a) * r;
  }
  return aimDir(y, pt);
}

export type HitInfo = { part?: 'head' | 'body'; pos?: Vec3; weapon?: string };

export function applyPlayerDamage(
  ctx: CombatCtx, target: PlayerState, amount: number, attackerId: number | null, now: number, info: HitInfo = {},
): MatchEvent[] {
  if (!target.alive || now < target.invulnUntil) return [];
  target.hp -= amount;
  target.lastDamagedAt = now;
  const out = [ev(now, 'hit', { target: target.id, by: attackerId, amount, ...info })];
  if (target.hp <= 0) {
    target.hp = 0;
    ctx.onKill(target.id, attackerId);
  }
  return out;
}

function hitPiece(
  ctx: CombatCtx, id: number, amount: number, source: 'bullet' | 'fist' | 'explosive', now: number, by: number | null, at: Vec3,
): MatchEvent[] {
  const piece = ctx.pieces.get(id);
  if (!piece) return [];
  const before = piece.hp;
  const destroyed = damagePiece(piece, amount, source);
  const out = [ev(now, 'pieceHit', {
    piece: id, kind: piece.kind, by, source, amount: before - Math.max(0, piece.hp), hp: Math.max(0, piece.hp), maxHp: PIECES[piece.kind].hp, pos: at,
  })];
  if (!destroyed) return out;
  ctx.onPieceDestroyed(id);
  out.push(ev(now, 'destroyed', { piece: id, kind: piece.kind, pos: pieceCenter(piece), rotY: piece.rotY }));
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const rv = (v: Vec3): Vec3 => v3(r2(v.x), r2(v.y), r2(v.z));
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

const isGrounded = (ctx: CombatCtx, p: PlayerState) => (ctx.grounded ? ctx.grounded(p.id) : Math.abs(p.vel.y) < 0.5);

/** Current spread cone (deg) for a player's next shot. */
export function playerSpread(ctx: CombatCtx, p: PlayerState, now: number): number {
  return spreadDeg(p.equipped, p, now, { speed: Math.hypot(p.vel.x, p.vel.z), grounded: isGrounded(ctx, p) });
}

export function tryFire(ctx: CombatCtx, p: PlayerState, now: number): MatchEvent[] {
  // A shotgun reload stops between shells when you pull the trigger with something loaded.
  if (p.reloadUntil > 0 && p.equipped === 'shotgun' && (p.inv.weapons.shotgun?.mag ?? 0) > 0) { p.reloadUntil = 0; p.reloadSec = 0; }
  if (!p.alive || now < p.nextFireAt || p.reloadUntil > 0) return [];
  const kind = p.equipped;
  const spec = WEAPONS[kind];
  const ammo = kind === 'fists' ? null : p.inv.weapons[kind];
  if (kind !== 'fists' && !ammo) return [];
  if (ammo && ammo.mag <= 0) {
    // Dry fire: the hammer clicks on an empty chamber (then reload if there's anything to load).
    p.nextFireAt = now + 0.3;
    tryReload(p, now);
    return [ev(now, 'dry', { by: p.id, weapon: kind })];
  }
  if (ammo) ammo.mag -= 1;
  p.nextFireAt = now + 1 / spec.rps;

  const seed = Math.round(now * TICK_HZ) * 64 + p.id;
  const cone = playerSpread(ctx, p, now);
  const burst = nextBurst(kind, p, now);
  const kick = recoilKick(kind, burst, seed);
  p.bloom = bloomAfterShot(kind, p, now);
  p.lastShotAt = now;
  p.burst = burst + 1;

  const out: MatchEvent[] = [];
  const eye = eyePos(p);
  const shot: Record<string, unknown> = { by: p.id, weapon: kind, from: eye, to: eye, kick: { pitch: r5(kick.pitch), yaw: r5(kick.yaw) } };
  if (kind === 'rocket') {
    out.push(ev(now, 'shot', shot));
    out.push(...launchRocket(ctx, p, pelletDir(p.yaw, p.pitch, cone, seed, 0, 1, 0), now));
  } else {
    const ring = p.ads ? SHOTGUN_ADS_SPREAD_DEG : SHOTGUN_SPREAD_DEG;
    const tos: Vec3[] = [];
    const hits: MatchEvent[] = [];
    for (let i = 0; i < spec.pellets; i++) {
      const dir = pelletDir(p.yaw, p.pitch, cone, seed, i, spec.pellets, ring);
      const hit = ctx.physics.raycast(eye, dir, spec.range, p.id);
      const to = hit ? hit.point : add(eye, scale(dir, spec.range));
      if (i === 0) shot.to = to; else tos.push(rv(to));
      if (!hit) continue;
      const dmg = spec.dmg * falloff(kind, hit.dist);
      if (hit.hit.type === 'player') {
        const target = ctx.players.get(hit.hit.id);
        const head = hit.part === 'head';
        if (target) hits.push(...applyPlayerDamage(ctx, target, dmg * (head ? HEAD.mult : 1), p.id, now, { part: hit.part, pos: rv(hit.point), weapon: kind }));
      } else if (hit.hit.type === 'piece') {
        hits.push(...hitPiece(ctx, hit.hit.id, dmg, kind === 'fists' ? 'fist' : 'bullet', now, p.id, hit.point));
      }
    }
    if (tos.length) shot.tos = tos;
    out.push(ev(now, 'shot', shot), ...hits);
  }
  // Recoil throws the shooter's aim. Bots keep it and must pull back; a human's client applies the same
  // kick to its own look angles and the next input overwrites this, so it never counts twice.
  p.pitch += kick.pitch;
  p.yaw += kick.yaw;
  if (ammo && ammo.mag === 0) tryReload(p, now);
  return out;
}

export function tryReload(p: PlayerState, now: number): void {
  const kind = p.equipped;
  if (kind === 'fists' || p.reloadUntil > 0) return;
  const ammo = p.inv.weapons[kind];
  if (!ammo || ammo.spare <= 0 || ammo.mag >= magCap(kind, ammo.mag)) return;
  p.reloadSec = reloadTime(kind, ammo.mag, ammo.spare);
  p.reloadUntil = now + p.reloadSec;
  p.reloadMag = ammo.mag;
  p.ads = false;
}

/** Finishes a pending reload once its time has passed. Switching weapons cancels (handled by caller). */
export function tickReload(p: PlayerState, now: number): void {
  if (p.reloadUntil <= 0) return;
  if (p.equipped === 'shotgun') { tickShells(p, now); return; }
  if (now < p.reloadUntil) return;
  p.reloadUntil = 0;
  p.reloadSec = 0;
  const kind = p.equipped;
  const ammo = kind === 'fists' ? undefined : p.inv.weapons[kind];
  if (!ammo) return;
  const take = Math.min(magCap(kind, ammo.mag) - ammo.mag, ammo.spare);
  ammo.mag += take;
  ammo.spare -= take;
}

/** Shotgun: each shell goes in on its beat; the reload ends after the last one (and the pump if it was empty). */
function tickShells(p: PlayerState, now: number) {
  const ammo = p.inv.weapons.shotgun;
  if (!ammo) { p.reloadUntil = 0; p.reloadSec = 0; return; }
  const start = p.reloadUntil - p.reloadSec;
  const loaded = ammo.mag - p.reloadMag;
  // Spare at the start = spare now + what's gone in since.
  const due = shellsLoadedBy(p.reloadMag, ammo.spare + loaded, now - start);
  const add = Math.min(due - loaded, ammo.spare, WEAPONS.shotgun.mag - ammo.mag);
  if (add > 0) { ammo.mag += add; ammo.spare -= add; }
  if (now >= p.reloadUntil) { p.reloadUntil = 0; p.reloadSec = 0; }
}

/** Spawns a rocket just ahead of the shooter's eye (or bursts it at once against a wall in the way). */
function launchRocket(ctx: CombatCtx, p: PlayerState, dir: Vec3, now: number): MatchEvent[] {
  const eye = eyePos(p);
  const ahead = 0.6;
  const block = ctx.physics.raycast(eye, dir, ahead, p.id);
  const e: Explosive = {
    id: ctx.nextId(), kind: 'rocket', owner: p.id, pos: add(eye, scale(dir, block ? Math.max(0, block.dist - 0.05) : ahead)),
    vel: scale(dir, ROCKET.speed), explodeAt: block ? now : now + ROCKET.fuseSec,
  };
  if (block) return explode(ctx, e, now);
  ctx.explosives.push(e);
  return [];
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

/** Closest point of a player's body (capsule) to `at`, and the distance to it. */
function nearestOnBody(pl: PlayerState, at: Vec3): { point: Vec3; d: number } {
  const r = PLAYER.radius;
  const y = Math.min(pl.pos.y + PLAYER.height - r, Math.max(pl.pos.y + r, at.y));
  const axis = v3(pl.pos.x, y, pl.pos.z);
  const toward = sub(at, axis);
  const l = Math.hypot(toward.x, toward.y, toward.z);
  if (l <= r) return { point: at, d: 0 };
  return { point: add(axis, scale(toward, r / l)), d: l - r };
}

/** Closest point of a piece's box to `at` (ramps use their bounding box). */
function nearestOnPiece(pc: PieceState, at: Vec3): { point: Vec3; d: number } {
  const s = PIECES[pc.kind];
  const c = pieceCenter(pc);
  const local = rotateY(sub(at, c), -pc.rotY);
  const cl = v3(Math.max(-s.w / 2, Math.min(s.w / 2, local.x)), Math.max(-s.h / 2, Math.min(s.h / 2, local.y)), Math.max(-s.d / 2, Math.min(s.d / 2, local.z)));
  const point = add(c, rotateY(cl, pc.rotY));
  return { point, d: dist(point, at) };
}

function rocketBlast(ctx: CombatCtx, e: Explosive, now: number, out: MatchEvent[]) {
  const R = ROCKET.radius, full = ROCKET.fullRadius;
  const k = (d: number) => (d <= full ? 1 : Math.max(0, 1 - (d - full) / (R - full)));
  for (const pl of ctx.players.values()) {
    if (!pl.alive) continue;
    const { point, d } = nearestOnBody(pl, e.pos);
    if (d >= R) continue;
    // Something solid between the blast and the body takes most of it (a quarter gets through).
    let shield = 1;
    if (d > 0.3) {
      const block = ctx.physics.raycast(e.pos, norm(sub(point, e.pos)), d - 0.05);
      if (block && !(block.hit.type === 'player' && block.hit.id === pl.id)) shield = 0.25;
    }
    const f = k(d) * shield;
    const dmg = ROCKET.playerDmg * f * (pl.id === e.owner ? ROCKET.selfMult : 1);
    out.push(...applyPlayerDamage(ctx, pl, dmg, e.owner, now, { pos: rv(point), weapon: 'rocket' }));
    if (pl.alive && ctx.onKnockback) {
      const away = norm(sub(bodyCenter(pl), e.pos));
      ctx.onKnockback(pl.id, v3(away.x * ROCKET.knock * f, away.y * ROCKET.knock * f * 0.5 + ROCKET.knockUp * f, away.z * ROCKET.knock * f));
    }
  }
  for (const pc of [...ctx.pieces.values()]) {
    const { point, d } = nearestOnPiece(pc, e.pos);
    if (d < R) out.push(...hitPiece(ctx, pc.id, ROCKET.pieceDmg * k(d), 'explosive', now, e.owner, point));
  }
}

function explode(ctx: CombatCtx, e: Explosive, now: number): MatchEvent[] {
  const out: MatchEvent[] = [ev(now, 'explosion', { kind: e.kind, pos: e.pos, by: e.owner })];
  if (e.kind === 'rocket') {
    rocketBlast(ctx, e, now, out);
  } else if (e.kind === 'grenade') {
    for (const pl of ctx.players.values()) {
      const d = dist(bodyCenter(pl), e.pos);
      if (d < GRENADE.radius) out.push(...applyPlayerDamage(ctx, pl, GRENADE.dmg * (1 - d / GRENADE.radius), e.owner, now));
    }
    for (const pc of [...ctx.pieces.values()]) {
      const d = dist(pieceCenter(pc), e.pos);
      if (d < GRENADE.radius) out.push(...hitPiece(ctx, pc.id, GRENADE.dmg * (1 - d / GRENADE.radius), 'explosive', now, e.owner, pieceCenter(pc)));
    }
  } else {
    for (const pl of ctx.players.values())
      if (dist(bodyCenter(pl), e.pos) < CHARGE.playerRadius) out.push(...applyPlayerDamage(ctx, pl, CHARGE.playerDmg, e.owner, now));
    for (const pc of [...ctx.pieces.values()])
      if (dist(pieceCenter(pc), e.pos) < CHARGE.radius) out.push(...hitPiece(ctx, pc.id, CHARGE.pieceDmg, 'explosive', now, e.owner, pieceCenter(pc)));
  }
  return out;
}

/** Live explosives as the snapshot shows them. */
export function projectiles(explosives: Explosive[]): Projectile[] {
  return explosives.map((e) => ({ id: e.id, kind: e.kind, pos: { ...e.pos }, vel: { ...e.vel } }));
}

/** Rocket flight for one tick: slight drop; bursts on the first thing in its path (players too, not the shooter). */
function flyRocket(ctx: CombatCtx, e: Explosive, now: number) {
  e.vel.y -= ROCKET.gravity * DT;
  const step = scale(e.vel, DT);
  const stepLen = Math.hypot(step.x, step.y, step.z);
  const dir = scale(step, 1 / stepLen);
  const hit = ctx.physics.raycast(e.pos, dir, stepLen, e.owner);
  if (hit) {
    e.pos = add(e.pos, scale(dir, Math.max(0, hit.dist - 0.05)));
    e.explodeAt = now;
    return;
  }
  e.pos = add(e.pos, step);
}

/** Moves thrown grenades (simple gravity + stop on first surface) and rockets, and detonates anything due. */
export function tickExplosives(ctx: CombatCtx, now: number): MatchEvent[] {
  const out: MatchEvent[] = [];
  for (const e of ctx.explosives) {
    if (e.kind === 'rocket') { flyRocket(ctx, e, now); continue; }
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

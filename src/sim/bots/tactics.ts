import type { Difficulty, PlayerState, Vec3 } from '../types';
import { add, norm, right, scale, v3, yawOf } from '../vec';
import type { Memory } from './mind';
import type { BotParams } from './params';

/**
 * How well a player executes evasive movement (part of skill, like aim): how much of the juke they put in,
 * how long it takes them to notice they are being shot at, how often they jump, how unpredictable the rhythm is.
 */
export const DODGE_SKILL: Record<Difficulty, { amount: number; notice: number; jump: number; jitter: number }> = {
  easy: { amount: 0.3, notice: 0.9, jump: 0.2, jitter: 0.2 },
  medium: { amount: 0.6, notice: 0.55, jump: 0.5, jitter: 0.5 },
  hard: { amount: 0.8, notice: 0.35, jump: 0.75, jitter: 0.8 },
  pro: { amount: 1, notice: 0.2, jump: 1, jitter: 1 },
};
export type DodgeSkill = (typeof DODGE_SKILL)[Difficulty];

/** Where fire is coming from (hits and near-miss tracers only: what a human feels and sees), or null. */
export function incomingFire(mem: Memory, now: number, p: BotParams): Vec3 | null {
  let from: Vec3 | null = null, t = -Infinity;
  if (mem.shotAtMe && now - mem.shotAtMe.t <= p.underFireSec) { from = mem.shotAtMe.from; t = mem.shotAtMe.t; }
  if (now - mem.lastHurtAt <= p.underFireSec && mem.lastHurtBy !== null && mem.lastHurtAt >= t) {
    const s = mem.recent(mem.lastHurtBy, now, 3);
    if (s) from = v3(s.pos.x, s.pos.y + 1.6, s.pos.z);
  }
  return from;
}

/**
 * Strafe jukes against incoming fire: a lateral component (perpendicular to the shooter) whose side flips at
 * randomized intervals, sometimes with a jump. Skill scales how much of it a player puts in, how fast they
 * react and how random the rhythm is (an easy bot's is slow and regular, a PRO's short and erratic).
 */
export class Dodger {
  private sign = 1;
  private flipAt = -Infinity;
  private jumpAt = -Infinity;
  private fireSince: number | null = null;
  /** Lateral direction changes so far (tests / debug). */
  flips = 0;

  constructor(private readonly rng: () => number, readonly skill: DodgeSkill) {}

  /** Under fire long enough to have noticed it: the shooter's position, else null. */
  threat(mem: Memory, now: number, p: BotParams): Vec3 | null {
    const from = incomingFire(mem, now, p);
    if (!from) { this.fireSince = null; return null; }
    this.fireSince ??= now;
    return now - this.fireSince >= this.skill.notice ? from : null;
  }

  juke(dir: Vec3 | null, me: PlayerState, from: Vec3, now: number, p: BotParams): { dir: Vec3; jump: boolean } {
    if (now >= this.flipAt) {
      // Mostly alternate (a human rhythm), sometimes double back the same way.
      if (this.rng() >= 0.25 * this.skill.jitter) this.sign = -this.sign;
      const lo = Math.min(p.jukeMinSec, p.jukeMaxSec), hi = Math.max(p.jukeMinSec, p.jukeMaxSec);
      const span = (hi - lo) * this.skill.jitter;
      // Low skill: regular and slower; high skill: the full random range.
      this.flipAt = now + ((lo + hi) / 2 + (this.rng() - 0.5) * span) / (0.6 + 0.4 * this.skill.amount);
      this.flips++;
      if (this.rng() < p.jumpChance * this.skill.jump) this.jumpAt = now;
    }
    const toShooter = norm(v3(from.x - me.pos.x, 0, from.z - me.pos.z));
    const lateral = scale(right(yawOf(toShooter)), this.sign);
    const out = add(dir ?? v3(), scale(lateral, p.jukeWeight * this.skill.amount));
    const len = Math.hypot(out.x, out.z);
    return { dir: len < 1e-6 ? lateral : scale(out, 1 / len), jump: now - this.jumpAt < 0.05 };
  }
}

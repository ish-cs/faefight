import type { Goal } from './bot';
import { rivalScore, type RivalFacts } from './mind';
import type { BotParams } from './params';

/**
 * The plan layer: a strategic objective with a motive, above the per-tick goals.
 * A bot commits to a plan (hysteresis + minimum time), breaks it into steps
 * (gear up → bank → bridge → approach → act → retreat) and re-plans on events
 * (I died, the target was eliminated or sealed, the bridge was cut, someone else is fighting my target).
 * Plans only push goal utilities; the goals themselves still do the work, so every plan stays human-doable.
 */
export type PlanKind = 'turtle' | 'defend' | 'seal' | 'eliminate' | 'raid' | 'revenge' | 'center';
export type Step = 'gearUp' | 'bank' | 'bridge' | 'approach' | 'act' | 'retreat';
export type PlanEvent = 'died' | 'targetGone' | 'targetSealed' | 'bridgeCut' | 'targetBusy' | 'homeThreat';

export type Plan = {
  kind: PlanKind;
  /** Rival the plan is about (player id), if any. */
  target: number | null;
  /** Island the plan acts on, if any. */
  island: number | null;
  /** Why, in words (debug overlay). */
  motive: string;
  step: Step;
  since: number;
  utility: number;
};

/** What the plan layer knows; built by Bot from its BotView-only memory each rescore. */
export type PlanInput = {
  now: number;
  suddenDeath: boolean;
  /** HP fraction. */
  hp: number;
  home: number;
  /** Island I stand on, -1 on a bridge. */
  on: number;
  rivals: (RivalFacts & { island: number; openDoors: number; generator: number; guarded: boolean })[];
  gun: boolean;
  /** Better than a pistol. */
  upgraded: boolean;
  /** Doorways my carried pieces can plug. */
  kit: number;
  carried: number;
  banked: number;
  /** Cash still to put in the vault as death insurance. */
  insuranceDue: number;
  intruder: boolean;
  homeSealed: boolean;
  homePlugged: boolean;
  incomingBridge: boolean;
  /** Who killed me, seconds ago. */
  killedBy: { id: number; ago: number } | null;
  /** A potion seller I can walk to, and whether I'd buy there. */
  seller: boolean;
  wantShields: boolean;
  /** Two or fewer rivals left: only eliminations matter. */
  endgame: boolean;
};

const STEP_GOALS: Record<Step, Partial<Record<Goal, number>>> = {
  gearUp: { shop: 1, collect: 0.5 },
  bank: { bank: 1, collect: 0.3 },
  bridge: { bridge: 1, shop: 0.4 },
  approach: { attack: 1, loot: -0.3, collect: -0.4 },
  act: {},
  retreat: { heal: 1, bank: 0.4, collect: 0.3, attack: -0.5, seal: -0.3 },
};
const ACT_GOALS: Record<PlanKind, Partial<Record<Goal, number>>> = {
  turtle: { shop: 0.6, collect: 0.6, bank: 0.5, guard: 0.5, cut: 0.6, bridge: -0.5, attack: -0.6 },
  defend: { defend: 1.2, guard: 1, cut: 0.8, attack: -0.5, bridge: -0.4 },
  seal: { seal: 1.5, attack: 0.3 },
  eliminate: { attack: 1, fight: 0.4, seal: 0.4 },
  raid: { raid: 1.5, attack: 0.2 },
  revenge: { attack: 1, fight: 0.5 },
  center: { potions: 1.5 } as Partial<Record<Goal, number>>,
};
const RETREAT_MARGIN = 0.1;

export class Strategist {
  plan: Plan | null = null;
  private pending: PlanEvent[] = [];
  private last: { target: number | null; sealed: boolean; reach: boolean; busy: boolean; intruder: boolean } | null = null;
  /** Events seen this match (debug/tests). */
  readonly history: { t: number; event: PlanEvent }[] = [];

  constructor(private readonly rng: () => number) {}

  /** Something happened that makes the current plan questionable: re-plan next update without hysteresis. */
  notify(e: PlanEvent, now: number) {
    this.pending.push(e);
    this.history.push({ t: now, event: e });
    if (this.history.length > 50) this.history.shift();
  }

  /** Re-evaluate (called at the bot's rescore rate). `noise`: decision mistakes of this skill level. */
  update(inp: PlanInput, p: BotParams, noise: number): Plan {
    this.detectEvents(inp);
    const forced = this.pending.length > 0;
    this.pending = [];
    const cands = this.candidates(inp, p);
    let best: Plan | null = null, bestU = -Infinity, curU = -Infinity;
    for (const c of cands) {
      const u = c.utility + (this.rng() - 0.5) * noise;
      if (this.plan && c.kind === this.plan.kind && c.target === this.plan.target && c.island === this.plan.island) curU = u;
      if (u > bestU) { bestU = u; best = c; }
    }
    if (!best) throw new Error('Strategist: no plan candidates (turtle is always one)');
    const cur = this.plan;
    const keep = !!cur && curU > -Infinity && !forced &&
      (inp.now - cur.since < p.planMinSec || curU + p.planCommit >= bestU);
    if (keep && cur) {
      const fresh = cands.find((c) => c.kind === cur.kind && c.target === cur.target && c.island === cur.island)!;
      this.plan = { ...fresh, since: cur.since };
    } else {
      this.plan = { ...best, since: inp.now };
    }
    this.plan.step = this.stepOf(this.plan, inp, p);
    return this.plan;
  }

  /** Utility push this plan gives a goal right now. */
  bonus(g: Goal, p: BotParams): number {
    if (!this.plan) return 0;
    const step = this.plan.step;
    const w = step === 'act' ? ACT_GOALS[this.plan.kind][g] : STEP_GOALS[step][g];
    return (w ?? 0) * p.stepPush;
  }

  private detectEvents(inp: PlanInput) {
    const t = this.plan?.target ?? null;
    const r = t === null ? null : inp.rivals.find((x) => x.id === t) ?? null;
    const now = { target: t, sealed: !!r?.sealed, reach: !!r?.reach, busy: !!r?.busy, intruder: inp.intruder || inp.homeSealed };
    const was = this.last;
    if (was && t !== null && was.target === t) {
      if (!r) this.notify('targetGone', inp.now);
      else {
        if (now.sealed && !was.sealed) this.notify('targetSealed', inp.now);
        if (was.reach && !now.reach && this.plan && (this.plan.step === 'approach' || this.plan.step === 'act')) this.notify('bridgeCut', inp.now);
        if (now.busy && !was.busy) this.notify('targetBusy', inp.now);
      }
    }
    if (was && now.intruder && !was.intruder) this.notify('homeThreat', inp.now);
    this.last = now;
  }

  private candidates(inp: PlanInput, p: BotParams): Plan[] {
    const out: Plan[] = [];
    const mk = (kind: PlanKind, utility: number, motive: string, target: number | null = null, island: number | null = null) =>
      out.push({ kind, target, island, motive, utility, step: 'act', since: inp.now });

    // Bank and build up early; strike late with better gear.
    const early = Math.max(0, 1 - inp.now / p.turtleUntil);
    mk('turtle', p.planTurtle * early * (inp.upgraded ? 0.4 : 1) * (inp.suddenDeath ? 0 : 1) * (inp.endgame ? 0.2 : 1) + 0.05,
      inp.upgraded ? 'bank and build up for a late push' : 'gear up before going anywhere');

    const threat = (inp.intruder ? 1 : 0) + (inp.homeSealed ? 1.2 : inp.homePlugged ? 0.6 : 0) + (inp.incomingBridge ? 0.3 : 0);
    if (threat > 0 && !inp.suddenDeath)
      mk('defend', p.planDefend * threat, inp.homeSealed ? 'my bunker is sealed: clear it while alive' : inp.intruder ? 'someone is on my island' : 'a bridge leads into my island', null, inp.home);

    for (const r of inp.rivals) {
      const base = rivalScore(r, p);
      if (!r.sealed && r.openDoors > 0 && !inp.suddenDeath) {
        const why = r.respawning ? 'respawning' : r.away ? 'out of position' : r.seenHp !== null && r.seenHp < 50 ? 'hurt' : r.busy ? 'busy fighting' : 'weakest reachable';
        mk('seal', p.planSeal * base * (inp.endgame ? 1.4 : 1) + (r.respawning ? 0.4 : 0), `seal #${r.id}'s bunker (${why})`, r.id, r.island);
      }
      if (r.sealed || (r.respawning && inp.kit >= r.openDoors))
        mk('eliminate', p.planElim * (base + 0.3), r.sealed ? `#${r.id} is sealed: one kill eliminates them` : `#${r.id} respawning: seal and finish`, r.id, r.island);
      if (!inp.suddenDeath && inp.gun && r.generator >= 30 && !r.guarded)
        mk('raid', p.planRaid * (Math.min(r.generator, 500) / 250 - (r.reach ? 0 : r.scaffolds * 0.05) - r.dist / 200 + (r.kills >= r.leaderKills && r.kills > 0 ? 0.3 : 0)),
          `raid #${r.id}'s generator ($${Math.round(r.generator)}${r.kills >= r.leaderKills && r.kills > 0 ? ', the leader' : ''})`, r.id, r.island);
      if (inp.killedBy && inp.killedBy.id === r.id && inp.killedBy.ago < 90)
        mk('revenge', p.planRevenge * (1 - inp.killedBy.ago / 90) * (0.6 + Math.min(1, r.grudge / 35)) + 0.2 * base, `punish #${r.id} (killed me)`, r.id, r.island);
    }
    if (inp.seller && inp.wantShields && !inp.suddenDeath) mk('center', p.planCenter, 'stock shields at the potion seller');
    return out;
  }

  private stepOf(plan: Plan, inp: PlanInput, p: BotParams): Step {
    const r = plan.target === null ? null : inp.rivals.find((x) => x.id === plan.target) ?? null;
    const awayFromHome = inp.on !== inp.home;
    if (inp.hp < p.lowHp + RETREAT_MARGIN && awayFromHome && plan.kind !== 'defend') return 'retreat';
    if (plan.kind === 'turtle') return inp.insuranceDue > 0 || inp.carried > 250 ? 'bank' : inp.gun && inp.upgraded ? 'act' : 'gearUp';
    if (plan.kind === 'defend' || plan.kind === 'center') return 'act';
    if (!inp.gun) return 'gearUp';
    if (plan.kind === 'seal' && r && inp.kit < r.openDoors) return 'gearUp';
    if (!awayFromHome && inp.insuranceDue > 0) return 'bank';
    if (r && !r.reach) return 'bridge';
    if (r && inp.on !== r.island) return 'approach';
    return 'act';
  }
}

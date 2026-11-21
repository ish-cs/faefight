import { PIECES, WEAPONS } from '../constants';
import type { WeaponKind } from '../types';
import type { Goal } from './bot';
import { rivalScore, type RivalFacts } from './mind';
import type { BrainParams } from './params';

/**
 * The bot's brain: a human-like decision layer above the tick-level actions.
 *
 * 1. Self-assessment: my HP/shield, gear, ammo, cash and seal kit; the enemy in front of me (estimated HP and
 *    gun from what's on screen), distance, how many guns are on me → estimated odds of winning this fight.
 * 2. Goal choice for a reason: box in/seal a rival, finish a sealed one, upgrade guns, heal/shield up,
 *    retreat, bank cash, fortify, contest the center, defend home, raid a generator, hunt whoever killed me.
 *    Each candidate gets a utility from the assessment and the trained weights (params.ts), and a reason in words.
 *    The current goal is kept (hysteresis, minimum time) unless something clearly better comes up or an event
 *    breaks it (I died, target eliminated/sealed, bridge cut, the fight turned, the goal was achieved).
 * 3. Steps: each goal expands into concrete ordered steps (HTN-style), each with a done-condition and the action
 *    that makes progress on it. The current step is the first one not done, so a broken precondition (bridge
 *    cut, kit spent) sends the bot back to the step that fixes it.
 *
 * Only facts a human could know reach the brain (built from BotView + memory by Bot.brainInput).
 */
export type GoalKind =
  | 'seal' | 'finish' | 'upgrade' | 'heal' | 'retreat' | 'bank' | 'fortify' | 'center' | 'defend' | 'raid' | 'hunt';
export type BrainEvent = 'stuck' | 'died' | 'targetGone' | 'targetSealed' | 'bridgeCut' | 'targetBusy' | 'homeThreat' | 'goalDone' | 'losingFight';

export type StepInfo = { label: string; act: Goal; done: boolean; /** A shopping step for decks: they come before anything else on the list. */ decks?: boolean };

export type BrainGoal = {
  kind: GoalKind;
  /** Rival the goal is about (player id), if any. */
  target: number | null;
  /** Why, in words. */
  reason: string;
  utility: number;
  since: number;
  steps: StepInfo[];
  /** Index of the current step (first not done); steps.length when all are done. */
  step: number;
};

export type RivalInfo = RivalFacts & {
  island: number; name: string; openDoors: number; generator: number; guarded: boolean;
  /** Seen spawn-protected, or just respawned at home: a seal window. */
  protectedNow: boolean;
  /** Seen inside their own bunker recently: sealing them in now traps them (escape countdown). */
  inBunker?: boolean;
};

export type EnemyInfo = { id: number; dist: number; hp: number; weapon: WeaponKind };

export type BrainInput = {
  now: number;
  suddenDeath: boolean;
  /** HP and shield fractions (0..1). */
  hp: number;
  shield: number;
  home: number;
  /** Island I stand on, -1 on a bridge. */
  on: number;
  rivals: RivalInfo[];
  gun: boolean;
  /** Better than a pistol. */
  upgraded: boolean;
  /** Best gun I'd use at the enemy's range. */
  myWeapon: WeaponKind;
  /** Doorways my carried pieces can plug. */
  kit: number;
  scaffolds: number;
  /** Scaffolds the next bridge I'd build still needs (it may go to the center island first); 0 = none to build. */
  bridgeNeed: number;
  /** My shopping plan (vault cash included) would buy a scaffold now: false = carrying all I can get, go lay it. */
  scaffoldBuy?: boolean;
  medkits: number;
  carried: number;
  banked: number;
  insuranceDue: number;
  /** Carried cash beyond what my shopping plan needs (what a trip to the vault would deposit). */
  bankable: number;
  /** The rival I'm currently focused on (commitment), if any. */
  focus: number | null;
  /** My build planner (build.ts) has fortification work worth doing at home. */
  fortifyWanted?: boolean;
  /** Within a few steps of my vault. */
  nearVault: boolean;
  /** I carry what it takes to clear every plug in my doorways (gun for soft, charge/rocket for hard). */
  canClearHome: boolean;
  intruder: boolean;
  homeSealed: boolean;
  homePlugged: boolean;
  incomingBridge: boolean;
  killedBy: { id: number; ago: number } | null;
  seller: boolean;
  wantShields: boolean;
  endgame: boolean;
  /** The enemy I'm facing (in sight), if any. */
  enemy: EnemyInfo | null;
  /** Armed enemies in sight within fighting range. */
  armedNear: number;
  underFire: boolean;
};

const dps = (w: WeaponKind, dist: number) => {
  const s = WEAPONS[w];
  return dist > s.range ? 0 : s.dmg * s.pellets * s.rps;
};

/**
 * Estimated chance of winning the fight in front of me (0..1): who kills whom first, from effective HP and the
 * guns' damage per second at this range, with every extra gun on me adding its damage. Execution (aim) is left
 * out on purpose: a player judges the matchup, not their own reflexes.
 */
export function fightOdds(inp: BrainInput): number {
  const e = inp.enemy;
  if (!e) return 1;
  const mine = dps(inp.myWeapon, e.dist), theirs = dps(e.weapon, e.dist) * Math.max(1, inp.armedNear);
  const myHp = 100 * (inp.hp + inp.shield);
  const tMe = mine > 0 ? e.hp / mine : Infinity;
  const tThem = theirs > 0 ? myHp / theirs : Infinity;
  if (tMe === Infinity && tThem === Infinity) return 0.5;
  if (tMe === Infinity) return 0;
  if (tThem === Infinity) return 1;
  return tThem / (tMe + tThem);
}

const KIT_NAME = (n: number, rich: boolean) => `${n} ${rich ? 'steel/metal' : 'wood'} plug${n === 1 ? '' : 's'}`;
const pct = (x: number) => `${Math.round(100 * x)}%`;
/** Seconds a retreat or a heal-at-home may last before the bot goes back in (a human doesn't hide forever). */
const REENGAGE_SEC = 20;

export class Brain {
  goal: BrainGoal | null = null;
  private pending: BrainEvent[] = [];
  private last: { target: number | null; sealed: boolean; reach: boolean; busy: boolean; threat: boolean; losing: boolean } | null = null;
  /** Events seen this match (debug/tests). */
  readonly history: { t: number; event: BrainEvent }[] = [];
  /** A goal (kind + target) that got the bot stuck, set aside until `until`. */
  private banned: { kind: GoalKind; target: number | null; until: number } | null = null;

  /** The current goal isn't making progress (stuck): drop it for `sec` and re-plan. */
  giveUp(now: number, sec: number) {
    if (this.goal) this.banned = { kind: this.goal.kind, target: this.goal.target, until: now + sec };
    this.notify('stuck', now);
  }

  constructor(private readonly rng: () => number) {}

  notify(e: BrainEvent, now: number) {
    this.pending.push(e);
    this.history.push({ t: now, event: e });
    if (this.history.length > 50) this.history.shift();
  }

  /** The tick-level action of the current step (null when the goal has no step left). */
  get stepAct(): Goal | null {
    const g = this.goal;
    return g && g.step < g.steps.length ? g.steps[g.step].act : null;
  }

  /** The current step is a deck-buying trip: decks go before anything else on the shopping list. */
  get buyingDecks(): boolean {
    const g = this.goal;
    return !!g && g.step < g.steps.length && !!g.steps[g.step].decks;
  }

  /** "Goal: seal Wavy.Dan (he's away from home, I have 3 steel) — step 3/5 bridging". */
  get thought(): string {
    const g = this.goal;
    if (!g) return 'thinking…';
    const s = g.step < g.steps.length ? `step ${g.step + 1}/${g.steps.length} ${g.steps[g.step].label}` : 'done';
    return `Goal: ${g.kind} (${g.reason}) — ${s}`;
  }

  /** Re-evaluate (at the bot's rescore rate). `noise`: decision mistakes of this skill level. */
  update(inp: BrainInput, p: BrainParams, noise: number): BrainGoal {
    this.detectEvents(inp, p);
    const forced = this.pending.length > 0;
    this.pending = [];
    const cands = this.candidates(inp, p);
    let best: BrainGoal | null = null, bestU = -Infinity, curU = -Infinity;
    for (const c of cands) {
      const u = c.utility + (this.rng() - 0.5) * noise;
      if (this.goal && c.kind === this.goal.kind && c.target === this.goal.target) curU = u;
      if (u > bestU) { bestU = u; best = c; }
    }
    if (!best) throw new Error('Brain: no goal candidates (a fallback is always added)');
    const cur = this.goal;
    const keep = !!cur && curU > -Infinity && !forced && (inp.now - cur.since < p.planMinSec || curU + p.planCommit >= bestU);
    const chosen = keep && cur ? { ...cands.find((c) => c.kind === cur.kind && c.target === cur.target)!, since: cur.since } : { ...best, since: inp.now };
    this.goal = chosen;
    if (chosen.step >= chosen.steps.length) this.notify('goalDone', inp.now);
    this.last = this.snapshot(inp, chosen.target, p);
    return chosen;
  }

  private snapshot(inp: BrainInput, t: number | null, p: BrainParams) {
    const r = t === null ? null : inp.rivals.find((x) => x.id === t) ?? null;
    return {
      target: t, sealed: !!r?.sealed, reach: !!r?.reach, busy: !!r?.busy,
      threat: inp.intruder || inp.homeSealed, losing: !!inp.enemy && fightOdds(inp) < p.fleeOdds,
    };
  }

  private detectEvents(inp: BrainInput, p: BrainParams) {
    const was = this.last;
    if (!was) return;
    const t = was.target;
    const now = this.snapshot(inp, t, p);
    if (t !== null) {
      if (!inp.rivals.some((x) => x.id === t)) this.notify('targetGone', inp.now);
      else {
        if (now.sealed && !was.sealed) this.notify('targetSealed', inp.now);
        if (was.reach && !now.reach && this.goal && ['seal', 'finish', 'raid', 'hunt'].includes(this.goal.kind)) this.notify('bridgeCut', inp.now);
        if (now.busy && !was.busy) this.notify('targetBusy', inp.now);
      }
    }
    if (now.threat && !was.threat) this.notify('homeThreat', inp.now);
    if (now.losing && !was.losing) this.notify('losingFight', inp.now);
  }

  private candidates(inp: BrainInput, p: BrainParams): BrainGoal[] {
    const out: BrainGoal[] = [];
    const add = (kind: GoalKind, utility: number, reason: string, steps: StepInfo[], target: number | null = null) => {
      const b = this.banned;
      if (b && b.kind === kind && b.target === target && inp.now < b.until) return;
      const step = steps.findIndex((s) => !s.done);
      out.push({ kind, target, reason, utility, since: inp.now, steps, step: step < 0 ? steps.length : step });
    };
    const home = inp.on === inp.home;
    const total = inp.carried + inp.banked;
    const odds = fightOdds(inp);
    const visible = !!inp.enemy;

    // ---- retreat: the fight in front of me is lost (or I'm out of gas): break sight, fall back, heal, come back.
    // Running from a gun at close range just gets me shot in the back: only flee from distance, or when hurt.
    const losing = visible && odds < p.fleeOdds && (inp.enemy!.dist > 12 || inp.hp < 0.5) && !(inp.enemy!.dist < 3 && inp.myWeapon !== 'fists');
    const spent = (visible || inp.underFire) && inp.hp < p.lowHp;
    // A retreat is a breather, not a new home: back in after REENGAGE_SEC unless the losing fight is still in my face.
    if ((losing || spent) && !(this.goal?.kind === "retreat" && inp.now - this.goal.since > REENGAGE_SEC && !visible)) {
      const why = !inp.gun ? `no gun vs ${inp.enemy?.weapon ?? 'a gun'}` : spent ? `${pct(inp.hp)} HP` : `I'd lose this (${pct(odds)} odds${inp.armedNear > 1 ? `, ${inp.armedNear} on me` : ''})`;
      add('retreat', p.planRetreat * (1 + (p.fleeOdds - odds) + (spent ? p.lowHp - inp.hp : 0)), why, [
        { label: 'break line of sight', act: 'disengage', done: !visible && !inp.underFire },
        { label: 'fall back home', act: 'heal', done: home },
        { label: 'heal up', act: 'heal', done: inp.hp >= Math.min(0.9, p.healHp + 0.3) },
      ]);
    }

    // ---- heal / shield up when hurt and nobody is on me.
    if (inp.hp < p.healHp && !visible && !inp.suddenDeath && !(this.goal?.kind === "heal" && inp.now - this.goal.since > REENGAGE_SEC && inp.medkits === 0)) {
      add('heal', p.planHeal * (1 + 2 * (p.healHp - inp.hp)), `${pct(inp.hp)} HP${inp.medkits ? ', I have a medkit' : ''}`, [
        { label: 'get out of sight', act: 'disengage', done: !inp.underFire },
        { label: 'buy a medkit', act: 'shop', done: inp.medkits > 0 || total < 75 || !home },
        { label: 'patch up at home', act: 'heal', done: inp.hp >= Math.min(0.9, p.healHp + 0.25) },
      ]);
    }

    // ---- upgrade guns.
    // In sudden death the shop is usually out in the storm: survive with what I have.
    if (!inp.gun && !inp.suddenDeath) {
      add('upgrade', 3, 'I have no gun', [
        { label: 'collect cash', act: 'collect', done: total >= WEAPONS.pistol.price },
        { label: 'buy a pistol', act: 'shop', done: inp.gun },
      ]);
    } else if (!inp.upgraded && !inp.suddenDeath) {
      const price = WEAPONS.smg.price;
      add('upgrade', p.planUpgrade * (total >= price ? 1 : 0.15 + 0.35 * (total / price)), total >= price ? `I can afford better than a pistol ($${total})` : 'a pistol loses duels', [
        { label: `collect $${price}`, act: 'collect', done: total >= price },
        { label: 'buy an SMG/rifle', act: 'shop', done: inp.upgraded },
      ]);
    }

    // ---- bank cash (death drops everything carried).
    if (!inp.suddenDeath && (inp.insuranceDue > 0 || inp.bankable >= 100))
      // Danger near and the vault right here: two seconds to save it all from a death.
      add('bank', p.planBank * (inp.insuranceDue > 0 ? 1.2 : Math.min(1.5, inp.bankable / 400)) * (visible ? (inp.nearVault ? 2.5 : 0.3) : 1),
        inp.insuranceDue > 0 ? 'keep rebuy money in the vault' : visible && inp.nearVault ? `enemy around and I carry ${inp.carried}: bank it first` : `carrying ${inp.carried} I don't need right now`, [
          { label: 'deposit at the vault', act: 'bank', done: inp.bankable < 40 && inp.insuranceDue === 0 },
        ]);

    // ---- fortify: early on, build up and cut bridges into my island. Once that's done there's nothing to sit at
    // home for: the goal is complete and drops out (no hiding behind the bunker).
    const early = Math.max(0, 1 - inp.now / p.turtleUntil);
    const fortify: StepInfo[] = [
      { label: 'gear up', act: 'shop', done: inp.upgraded },
      { label: 'bank', act: 'bank', done: inp.bankable < 40 && inp.insuranceDue === 0 },
      { label: 'cut the bridge into my island', act: 'cut', done: !inp.incomingBridge },
      { label: 'build up my home (walls, plugs ready)', act: 'fortify', done: !inp.fortifyWanted },
    ];
    if (fortify.some((s) => !s.done))
      add('fortify', p.planTurtle * early * (inp.upgraded ? 0.4 : 1) * (inp.suddenDeath ? 0 : 1) * (inp.endgame ? 0.2 : 1) + 0.05,
        inp.upgraded ? 'build up for a late push' : 'gear up before going anywhere', fortify);

    // ---- defend home.
    const threat = (inp.intruder ? 1 : 0) + (inp.homeSealed ? 1.2 : inp.homePlugged ? 0.9 : 0) + (inp.incomingBridge ? 0.3 : 0);
    if (threat > 0 && !inp.suddenDeath)
      add('defend', p.planDefend * threat, inp.homeSealed ? 'my bunker is sealed: clear it while alive' : inp.intruder ? 'someone is on my island' : inp.homePlugged ? 'a plug in my doorway' : 'a bridge leads into my island', [
        { label: 'bank my cash first (the vault is right here)', act: 'bank', done: !(inp.nearVault && inp.bankable >= 100) },
        { label: 'get a charge (a hard plug blocks my door)', act: 'shop', done: inp.canClearHome },
        { label: 'clear my doorways', act: 'defend', done: !inp.homePlugged && !inp.homeSealed },
        { label: 'hunt the intruder', act: 'guard', done: !inp.intruder },
        { label: 'cut the bridge in', act: 'cut', done: !inp.incomingBridge },
      ]);

    // ---- per rival: box in / finish / raid / hunt.
    for (const r of inp.rivals) {
      const base = rivalScore(r, p) + (r.id === inp.focus ? p.rsCommit : 0);
      // A seal window: they're down/respawning, spawn-protected at home, away, holed up inside (sealing traps them),
      // or only one doorway is left open (just finish it).
      const window = r.respawning || r.protectedNow || r.away || !!r.inBunker || (r.openDoors <= 1 && inp.kit >= r.openDoors);
      // Leaving home with a plugged doorway is half a seal on myself: clear it first.
      const homeClear = { label: 'clear my own doorway first', act: 'defend' as Goal, done: !inp.homePlugged };
      const toBridge = (label: string) => [
        { label: 'get a gun', act: 'shop' as Goal, done: inp.gun },
        homeClear,
        // Standing at my vault with spare cash: two seconds to bank it before the trip (death drops what I carry).
        { label: 'bank spare cash (the vault is right here)', act: 'bank' as Goal, done: !(home && inp.nearVault && inp.bankable >= 150) },
        // Scaffolds I can afford now; with no cash, lay what I carry and come back for more.
        { label: `carry ${r.scaffolds} scaffolds`, act: 'shop' as Goal, decks: true, done: r.reach || inp.scaffolds >= (inp.bridgeNeed || r.scaffolds) || (inp.scaffolds > 0 && (total < PIECES.scaffold.price || inp.scaffoldBuy === false)) },
        { label, act: 'bridge' as Goal, done: r.reach },
      ];
      const kitStep = { label: `get a seal kit (${KIT_NAME(r.openDoors, total >= 3 * PIECES.metal.price)})`, act: 'shop' as Goal, done: inp.kit >= r.openDoors };
      // A bridge is a road into their island and mine: lay it up to the last deck, finish it only with a kit in hand.
      const partBridge = { label: `bridge toward ${r.name}'s island`, act: 'bridge' as Goal, done: r.reach || (r.scaffolds <= 1 && inp.kit < r.openDoors) || inp.scaffolds === 0 };
      if (!r.sealed && r.openDoors > 0 && !inp.suddenDeath) {
        const why = r.respawning ? `${r.name} is respawning` : r.protectedNow ? `${r.name} just respawned` : r.away ? `${r.name} is away from home` :
          r.seenHp !== null && r.seenHp < 50 ? `${r.name} is hurt` : r.busy ? `${r.name} is busy fighting` : `${r.name} is the best target`;
        const kitNote = inp.kit >= r.openDoors ? `I have ${inp.kit} plugs` : `need ${r.openDoors} plugs`;
        add('seal', p.planSeal * base * (inp.endgame ? 1.4 : 1) + (r.respawning || r.protectedNow ? 0.4 : 0), `${why}, ${kitNote}`, [
          ...toBridge(`bridge to ${r.name}'s island`).slice(0, 2),
          ...(inp.kit >= r.openDoors || total >= 3 * PIECES.wood.price ? [] : [partBridge]),
          kitStep,
          ...toBridge(`bridge to ${r.name}'s island`).slice(2),
          { label: `cross to ${r.name}'s bunker`, act: 'attack', done: inp.on === r.island },
          { label: `wait for ${r.name}'s window (down, away or respawning)`, act: 'attack', done: window },
          { label: `plug ${r.name}'s doors`, act: 'seal', done: r.sealed },
        ], r.id);
      }
      if (r.sealed && inp.suddenDeath)
        // Sudden death: everyone is sealed and squeezed into the ring; hunt them there, not on their island.
        add('finish', p.planElim * (base + 0.3) * 1.3 - r.dist / 300, `sudden death: ${r.name} is the closest to finish`, [
          { label: `hunt ${r.name} down in the ring`, act: 'attack', done: false },
        ], r.id);
      else if (r.sealed)
        add('finish', p.planElim * (base + 0.3) * (inp.endgame ? 1.3 : 1), `${r.name} is sealed: one kill eliminates them`, [
          ...toBridge(`bridge to ${r.name}'s island`),
          { label: `cross to ${r.name}'s island`, act: 'attack', done: inp.on === r.island },
          { label: `hold ${r.name}'s doors and finish them`, act: 'attack', done: false },
        ], r.id);
      if (!inp.suddenDeath && inp.gun && r.generator >= 30 && !r.guarded) {
        const leader = r.kills >= r.leaderKills && r.kills > 0;
        add('raid', p.planRaid * (Math.min(r.generator, 500) / 250 - (r.reach ? 0 : r.scaffolds * 0.05) - r.dist / 200 + (leader ? 0.3 : 0)),
          `${r.name}'s generator holds $${Math.round(r.generator)} and nobody is guarding it${leader ? ' (the leader)' : ''}`, [
            ...toBridge(`bridge to ${r.name}'s island`),
            { label: `steal ${r.name}'s generator`, act: 'raid', done: r.generator < 30 },
          ], r.id);
      }
      if (inp.killedBy && inp.killedBy.id === r.id && inp.killedBy.ago < 90 && inp.gun)
        add('hunt', p.planRevenge * (1 - inp.killedBy.ago / 90) * (0.6 + Math.min(1, r.grudge / 35)) + 0.2 * base, `${r.name} killed me ${Math.round(inp.killedBy.ago)} s ago`, [
          ...toBridge(`bridge to ${r.name}'s island`),
          { label: `hunt ${r.name} down`, act: 'attack', done: r.respawning },
        ], r.id);
    }

    // ---- contest the center: shields at the seller.
    if (inp.seller && inp.wantShields && !inp.suddenDeath)
      add('center', p.planCenter, 'shields win fights and I can afford them', [
        { label: 'go to the potion seller and stock shields', act: 'potions', done: !inp.wantShields },
      ]);
    if (!out.length) add('fortify', 0.01, 'nothing to go after right now', [{ label: 'collect', act: 'collect', done: false }]);
    return out;
  }
}

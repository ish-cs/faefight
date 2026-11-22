# Bot findings: low-hp pacing, bunker-corner flip-flop, realism3 ladder (Nov 2026)

Status: **none of the fixes below is merged.** Each one fixed its own case, but no version passed the ship gates
on top of realism3 (e0e97a0). They are kept on unmerged branches for the follow-up retune for the realism props.
All numbers are CI bot-measure, `all ×20` (`scripts/gh-measure.sh`, docs/bots-on-ci.md).

## 1. Seed-20 pacing at the door (ffa8-pro, 65 s home sit)

**Cause.** PRO #1 is at 9 hp at its own bunker door. Its low-hp `disengage` (bot.ts `score('disengage')`:
`hp < low → 1.15+`) fires whenever *any* enemy is in sight, at any range. Rival #8 was 45–60 m off across the
water and had stopped shooting 10–27 s earlier. When #8 was in view the bot backed off; when #8 dropped out of
sight, disengage scored 0 and the bot went back to `collect`/`shop`. That loop ran for about a minute while it
regenerated.

**Repro.** `tests/sim/botDither.test.ts` (on the branches below): ffa8-pro seed 20, seat 1's longest home sit
must be < 45 s. On main it is 64.5 s.

**Fix tried.** On `disengage`, a bot holding low hp stays in cover until healed (capped by `drive.reengageSec`)
instead of returning to its errand when the rival drops from view. `introspect.ts` mirrors it. A cover plan under
way overrides the hold. Without that exception the hold out-scored the `cover` goal and skilled bots stopped
building cover: botBuild seed 2 had PRO at 9 pieces vs easy at 14.

| variant (branch) | longest sit pro/hard/mixed | Hard 1v1 decisive | PRO-vs-Hard decisive | PRO beats Hard |
|---|---|---|---|---|
| main 61d840f (before realism3) | 65 / 62 / 41 s | 19 | 19 | 90% |
| A: back off only from a real threat (`ci/lowhp-commit`) | 36 / 28 / 37 | 16 | 20 | 95% |
| B: hold until healed (`ci/lowhp-hold`, eeb1c97) | 45 / 47 / 38 | 18 | 16 | 85% |
| C: B, home island only (`ci/lowhp-hold-home`) | 45 / 51 / 38 | 17 | 11 | 95% |

The coordinator picked B. On the old base it passed the full suite and CI. After merging realism3 (e0e97a0) it
broke botBuild seed 2. With the cover exception (`ci/lowhp-ship-2`, 861bf0b) it then broke botAim (finding 2).

## 2. Seed-1 bunker-corner flip-flop (botAim)

**Cause.** `withinIsland` (nav.ts) routes around a bunker through the cheapest corner (`dist(me→corner) +
dist(corner→dest)`). When the destination is roughly opposite, behind the bunker, two corners cost almost the
same. Each step re-picks, the other corner becomes nearer, and the walk direction flips 180° every few ticks. The
bot paces on the spot and its view swings ±240°/s. In botAim's seed-1 lobby a hard bot on a `seal` walk did
this at (−3, −115.9) around t = 134–139 s. That was 41 of 51 hard yaw reversals, 0.18/s against the 0.15/s bar.
The bug is pre-existing; the low-hp change only shifted the match into it.

**Fix tried.** Corner hysteresis: Nav remembers the last within-island waypoint and keeps that corner unless
another is shorter by `CORNER_STICK`.
- 1 m (`ci/lowhp-ship-3`, 894c227) broke teams seed 22 (assist 11 → 0, out-together 379 → 68) and hurt the ladder.
- 0.5 m (`ci/lowhp-ship-4`, 7af6602) is green on the full suite but misses the gates below.

| CI ×20 | main e0e97a0 (realism3) | 894c227 (1 m) | 7af6602 (0.5 m) | gate |
|---|---|---|---|---|
| Hard 1v1 decisive | 19 | 11 | 16 | ≥ 18 |
| PRO-vs-Hard decisive | 18 | 13 | 12 | ≥ 16 |
| PRO beats Hard | 75% | 85% | 75% | ≥ 80% |
| longest sit pro/hard/mixed | 61 / 62 / 46 s | 41 / 48 / 109 | 48 / 41 / 42 | ≤ 60 |

A follow-up could keep the corner only while the two costs are near-tied, or remember it per destination. It
should be measured against decisive games, not only the aim test.

## 3. realism3 on its own moved the ladder

Main at e0e97a0 (realism3 with gameplay props, no bot changes) measured **PRO beats Hard 75% ± 19**, against
90–100% on earlier mains. Its longest home sits were **61 s (pro) and 62 s (hard)**, over the 60 s bar. Every
variant above is judged against that moved baseline. The props (barrels, propane, crates, fire) change routes, cover
and fights enough that the hand-tuned bots need a retune for them first; the coordinator is starting that as a
separate task. Fixes 1 and 2 should be re-measured after that retune.

## Shipped in the same series (on main)

- 82fef31: PRO holds fire across water past `drive.crossFire.pro` = 25 m unless hit or last rival (ffa8-pro
  engagement 37 → 20 m); a bot walled into its own bunker deals with the plug first.
- b50b404: the center island counts as an island for that rule (nav nodes instead of `islandAt`).
- 61d840f: a lone sandbag in a doorway is a plug for the bunker escape (standing on it puts the head above the
  2.2 m lintel; seed 17, 81 s sit).

# Good-game profile (soft bands)

A sanity band for bot changes, measured in bot-measure series (`scripts/gh-measure.sh`). It is not a template to
reproduce. Variety between games is good; a series should mostly land inside these ranges, not hit exact numbers.

## Reference game

User replay `faefight-20261122-2029-fe150d`: 8-player FFA on the Container Yard map, genMult 2. Players: the user,
1 PRO, 1 hard and 5 medium bots. The bit-exact re-sim on main 9b12ae8 matches the recording (winner Pickle_10, medium,
16 kills).

The user called it "how I want every other game to play out": seals early and often, a steady trickle of
eliminations, and the last two players left as the storm came in.

| | |
|---|---|
| First kill / first seal | 0:23 / 1:12 |
| Seals before 15:00 (by a rival) | 29 (seals per player 7/6/5/4/3/3/1/0); 23 unseals |
| Kills | 73 (seals : kills ≈ 0.4) |
| Eliminations | 1:41, 5:23, 10:13, 11:09, 11:17, 15:01, 15:42 |
| Players left (not eliminated) at 5 / 10 / 12 / 14 min | 7 / 6 / 3 / 3 |
| Sealed islands at 5 / 10 / 14 min | 3 / 5 / 5 |
| Sudden death | 15:00 with 3 left; the final 2 were decided in the storm (15:01, 15:42). No storm deaths. |
| Seals per minute | 1-3 every minute from 1:00 to 11:00, peaking at 6/min around 7:00 |

Goal time split for the medium bots (share of time alive): seal 12-22%, attack 8-31%, bridge 6-21%, shop 6-19%,
defend 6-17%, collect 7-17%, fight 2-7%. The PRO bot (Falcon_14) was defending its own sealed bunker 26% of the time.

## The counter-example: the 1v1v1 with no seals

User replay `faefight-20261122-2001-fadd57`: harbor map, 3 PRO bots. 0 seals in 15 minutes, 33 kills.

- Goal split: bridge 35-39%, collect 21-25%, shop 11-17%, seal 0%, attack 0%.
- Every bot bridged to the center first (1 deck vs 10 to a rival).
- Every center bridge stopped 1.35 m short of the shore: a straight deck there runs into a barrier, and the nav wanted
  solid ground the whole way.
- Seal and attack need a walkable route, so neither ever scored.

### Why bridges worked in the good game and not there

| Map | Island to island | Island to center | Cheapest bridge |
|---|---|---|---|
| Yard, 8 players | 26 m | 52 m | a rival: offense starts at once |
| Harbor, 3 players | 36 m | 14 m | the center, a stepping stone that never finished |

Fixed on `ci/seal-center-gap`:
- gaps up to 1.5 m count as walkable (measured: players walk across 2.0 m);
- a blocked last deck tries sideways placements;
- a center lane that won't finish is banned for 90 s;
- a hook in reach counts as a route to seal/attack.

## Target bands (soft)

Checked per bot-measure series (20+ seeds). "Usually" means most games in the series, not every one.

| Metric | 8-player FFA | 3-player FFA |
|---|---|---|
| Games with a seal before 15:00 | ≥ 80% | ≥ 70% |
| Median first seal | ≤ 5:00 | ≤ 6:00 |
| Seals before 15:00 per game (median) | 6-35 | 2-10 |
| Seals : kills | ≥ 0.15 (kills don't drown out seals) | ≥ 0.15 |
| Players left at 10:00 | 4-7 | 2-3 |
| Players left at 12:00 | 2-5 | 1-3 |
| Games still going at sudden death | 20-60%, usually with 2-3 left (never more than 4) | 20-60% |
| Storm deaths per game | ≤ 1 | ≤ 1 |
| Medium+ bots' time in seal + attack + bridge | ≥ 25% | ≥ 25% |

- **Should usually happen:** seals come before eliminations (a player is sealed, then killed); the first elimination
  comes before 6:00; the endgame is tense, with the last two decided at or near the storm.
- **Should not happen:** a whole game with 0 seals while rivals are reachable; any bot at 0% seal/attack time for a full
  game; eliminations that are all storm deaths.
- **Existing gate:** "decisive before sudden death ≥ 60%" (ffa8 ship check) pulls the other way from the tense
  storm endgame. Both are soft: aim for a mix.

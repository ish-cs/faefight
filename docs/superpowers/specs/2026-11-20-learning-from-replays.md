# Learning from replays

Status: recording, storage, viewer, upload and extraction pipeline built (2026-11-20). `pnpm auto-improve` rebuilds the dataset in `.autoimprove/learning/` from uploaded replays every night (`scripts/autoimprove/learning.ts`); the trainer itself runs elsewhere and reads it.

## What gets recorded

Every match is recorded automatically, with no opt-out:

- **vs bot**: in the game worker (`src/client/worker.ts`).
- **online**: on the host only (the host's worker runs the sim). Guests' sanitized inputs are recorded on the host's
  machine. Guests record nothing.
- **self-play / training**: `recordHeadlessMatch(setup, seed, maxTicks, opts)` in `src/sim/replay/headless.ts`, or
  `npx tsx scripts/replays/selfplay.ts`.

A `.faereplay` (`src/sim/replay/format.ts`, codec in `codec.ts`) holds:

| Part | Content | Used for |
| --- | --- | --- |
| header | full `MatchSetup` + seed, the built map (islands, stations), players (name, bot, difficulty, island), build id, optional per-seat `bots` params and `tags` | re-running; analytics without re-running |
| ticks | each human's `PlayerInput` and movement commands exactly as `Match.tick` consumed them (delta coded) | exact re-run; human input statistics |
| ops | between-tick actions: bot takeover of a leaver, build previews (they can sync the physics world), debug helpers | exact re-run |
| hashes | `stateHash` of the snapshot every 30 ticks | divergence detection |
| events | kill, hit (+ attacker→target distance), sealed/unsealed (+ who), eliminated, win, suddenDeath, trapped/escaped, placed (+ position), destroyed, explosion, bought (derived from inventory changes) | statistics, scenario mining, viewer markers |
| seconds | per-second player tuples (pos, hp, shield, alive, cash, kills, deaths, weapon, ADS, eliminated), piece count, sealed, water | state snapshots for scenarios, analytics |

Sizes: a busy 15-minute match with 8 humans encodes to ~2.2 MB (test bound 3 MB); a vs-bot match is mostly
events + summaries (tens of KB per minute). Browser storage is IndexedDB, capped at 200 MB with LRU eviction.
Nothing is uploaded.

Exactness: bots need nothing beyond the seed (they draw from the match rng and read only sim state). A replay
re-runs bit-exactly on the same sim + bot code (tests: `tests/sim/replay.test.ts`, `tests/sim/matchFork.test.ts`).
After code changes (new bot params, physics tweaks) re-runs diverge; `ReplayRunner.divergedAt` reports where.
The **event log, summaries and human inputs never need a re-run**, so statistics stay valid across versions.
Bots built with non-default params must be recorded with `bots` in the header and replayed with the same
`makeBot` factory.

## Trainer hooks

```ts
import { loadReplays, extractStats, mineScenarios } from '../scripts/replays/extract';
import { recordHeadlessMatch, matchFromReplay } from '../src/sim/replay/headless';
import { writeReplay } from '../scripts/replays/selfplay';

const replays = await loadReplays(['.replays/exports', '.train/replays']); // dirs, files or .zip exports
const stats = extractStats(replays);        // per-player + pooled human decision statistics
const scenarios = mineScenarios(replays);   // situations where a bot lost to a human
```

- `loadReplays(dir | dir[])`: every `.faereplay` (recursive) plus `.zip` exports from the Replays screen.
- `extractStats(replays)`: per player-game `PlayerStats` (purchases with time and cost, builds by kind/time with
  bridge and enemy-bunker flags, first bridge time and target island, seal attempts/successes, engagement distance
  histogram and per weapon, outcome: place, kills, deaths, survival) and for humans `movement` (strafe share overall
  and in combat, strafe flips/min in combat, jumps/min, sprint, ADS overall and when firing). `stats.human` pools
  the humans (purchase order as mean rank + first time, builds/min by kind, mean first bridge time, seal success
  rate, engagement histogram, strafe/ADS rates).
- `mineScenarios(replays, { killLookback = 6 s, sealLookback = 20 s })`: one `Scenario` per human kill of a bot and
  per human seal of a bot's bunker: `startTick`, `eventTick`, the per-second state at the start, and what the human
  did in between (their events + input summary).
- `matchFromReplay(replay, tick, makeBot)`: re-runs the replay to `tick` with the bots that recorded it, then hands
  every remaining seat (humans included) to `makeBot`, returning a live `Match` to tick and `dispose()`.
- `recordHeadlessMatch(setup, seed, maxTicks, { makeBot, bots, tags, onSnapshot })` + `writeReplay(dir, bytes, header)`:
  record training games (pass the candidate params as `bots` so they can be re-run and watched).
- Own match loop (e.g. `scripts/train/runMatch.ts`): `const rec = new Recorder(m, { setup, kind: 'selfplay', localId: 0, bots })`
  (`src/sim/replay/recorder.ts`), call `rec.tick(new Map())` instead of `m.tick(new Map())`, then
  `const { bytes, header } = await rec.finish()` and `writeReplay(dir, bytes, header)`. Recording costs one
  `JSON.stringify` of a snapshot per simulated second; make it a flag (e.g. `--record-every N` games).

CLI: `npx tsx scripts/replays/extract.ts <dirs...> --out .replays-data` writes `stats.json` and `scenarios.jsonl`.

## How the trainer should use it

### (a) Imitation priors: fitness bonus for human-like statistics

Humans win by habits the hand-tuned bots don't have. Turn `stats.human` into target distributions and add a small
bonus to `seatFitness` for a candidate whose own statistics (computed with `extractStats` on its recorded
self-play games) are close to them:

- purchase order (rank correlation of first purchases) and timing (first SMG/rifle, first wood),
- builds per minute by kind, first bridge time,
- engagement distance histogram (e.g. 1 − total variation distance),
- seal attempt rate and success rate.

Keep the weight small (≤ 0.1 of the placement term) and only use statistics from humans who **won** or placed in
the top half (`stats.humans.filter(h => h.place <= n/2)`), so it imitates good play, not average play. Movement
habits (strafe/ADS) are inputs bots don't expose; they map onto tactics params (strafe frequency, ADS range) and
should be compared on the bot's simulated snapshots (the per-second `ads` flag and position deltas) rather than
inputs. Re-derive targets as more replays arrive; never let the prior outweigh winning.

### (b) Scenario mining: start training matches from mined states

`mineScenarios` finds the moments bots lost to humans. Each generation, run part of the evaluation games from
scenarios instead of from the start: `matchFromReplay(scenario.replay, scenario.startTick, candidateFactory)` and
score the candidate on whether the seat that lost (`scenario.bot`) survives / avoids being sealed over the next
`eventTick − startTick + 10 s`. Because re-runs need the recording's code, prefer recent replays (same `build`);
for older ones `divergedAt` tells you the state is approximate (still a plausible situation, just not the exact one).
Weight scenarios by recency and de-duplicate by (replay, human, kind) so one long fight doesn't dominate.

### (c) Evaluation: bots vs recorded human behaviour

Report, per trainer checkpoint:

1. **Behaviour gap**: the candidate's self-play `extractStats` vs `stats.human` on the same metrics as (a).
2. **Scenario survival**: share of mined scenarios where the candidate (seated as `scenario.bot`) survives the
   window. This is the closest thing to "would it have beaten that human here".
3. **Human outcomes over time**: from new solo replays, human win rate and the bots' places vs humans, by bot
   version (`header.build`, `header.bots`). Falling human win rates at fixed difficulty mean the bots improved.

## Privacy

Recordings are kept in IndexedDB in the browser and, in deployed builds, uploaded to `/api/replays` (private Vercel
Blob) automatically, with no opt-out. Online hosts record (and upload) their guests' inputs. Recordings carry player
names and gameplay only; chat is never recorded (`withoutChat` in `src/sim/replay/format.ts`).

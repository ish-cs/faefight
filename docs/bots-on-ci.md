# Bots on CI: measure and train on GitHub Actions, not the Mac

Bot measurement series and ES training run on GitHub's ubuntu runners (public repo, free minutes). Use these
**instead of** local `MEASURE=1` / `SHIP_CHECK=1` vitest series or local `pnpm train`, and instead of waiting
on the Mac heavy-test lock. Your Mac does nothing but `gh` calls.

Requirements: `gh` logged in, and the ref you measure **pushed to origin** (any branch name; agent branches
are fine — push with `git push origin HEAD:refs/heads/<your-branch>`, never force-push, never to main).
Pushing needs Ishaan's approval like any push; the coordinator/steward can grant a standing OK for bot
branches. Without one, ask for your branch to be pushed, or measure `main` / an already-pushed ref.
Until the `bots-on-ci` branch is merged, prefix the commands with `WORKFLOW_REF=bots-on-ci`.

## Measure

```bash
scripts/gh-measure.sh <ref> <scenario> [seeds=20] [params.json path in the ref]
# e.g.
scripts/gh-measure.sh my-branch ffa8-pro 20
scripts/gh-measure.sh my-branch 1v1-pro-vs-hard 40
scripts/gh-measure.sh my-branch all 20
scripts/gh-measure.sh my-branch ffa8-pro 20 tests/fixtures/run2-params.json
```

Scenarios: `1v1-hard`, `1v1-pro-vs-hard` (PRO seat alternates by seed, as botSeries), `ffa8-pro`, `ffa8-hard`,
`ffa8-mixed` (pro/hard/medium/easy ×2), `all`. Seeds are 1..N. Games are sharded over up to 20 parallel
jobs; 20 full 8-bot FFAs take **~2.5 min wall** (one FFA ≈ 1–2 min on a runner, 2.5 ms/tick).

It prints a markdown table (also in the run's job summary) and saves `.measure/<run id>/measure-summary.json`:
decisive-before-sudden-death count, median eliminations before 15:00, median engagement distance, attack %,
home %, median first-seal time, PRO-vs-Hard win share with 95% CI, and ship checks:

| scenario | ship check |
|---|---|
| ffa8-* | decisive < 15:00 in ≥ 60% of games · median engagement < 25 m · nobody sits at home geared > 60 s (tests/sim/shipChecks.test.ts FFA gate, minus the vs-hand comparisons) |
| 1v1-pro-vs-hard | PRO win share ≥ 70% (tests/sim/botSeries.test.ts bar) |
| 1v1-hard | n/a (numbers only) |

Exit code: 0 pass / n/a, 2 ship check failed, 1 the run broke. Metrics are computed by `scripts/ci/measure.ts`
(same definitions as `scripts/train/runMatch.ts`); it imports only `src/sim`, so it works on any ref.

Raw: `gh workflow run bot-measure.yml --ref main -f ref=<ref> -f scenario=ffa8-pro -f seeds=20`.
Other workflows can call it (`uses: ./.github/workflows/bot-measure.yml`, output `ship_check`).

## Train

```bash
label=$(scripts/gh-train.sh start <ref> <generations> ['{"evalGames":100}'] [--from-trained])
scripts/gh-train.sh watch $label     # follow the chain to the end, then download it
scripts/gh-train.sh fetch $label     # download the latest state at any time
scripts/gh-train.sh stop  $label     # cancel; no further generations are dispatched
```

The ref must contain the trainer (`scripts/train/`). One workflow run = one generation: its games
(λ×games/candSeats FFAs + duels, defaults as `scripts/train-bots.ts`) are sharded over 5 jobs, the ES update
runs in one job, then the next generation is dispatched with `gh workflow run` until the `generations` hard
stop (capped at 200). Every `evalEvery` generations and at the last one, the champion plays the hand-tuned
params head-to-head over `evalGames` games on 10 jobs; the job summary shows win share ± 95% CI.
Config keys (fixed at the start of a chain): `lambda, games, candSeats, players, maxSec, seed, duels,
duelWeight, evalEvery, evalGames`. Manual only — never scheduled (GitHub Actions terms).

`fetch` writes `.train-ci/<label>/` laid out like a trainer checkout:
`.train/state.json`, `.train/log.jsonl`, `.train/ci-config.json`, `src/sim/bots/trained-params.json` (champion). So:

- dashboard: `pnpm train:watch --dir .train-ci/<label>` (port 7802, charts from log.jsonl);
- continue locally: `tsx scripts/train-bots.ts --resume --dir .train-ci/<label>/.train`;
- ship the champion: copy `src/sim/bots/trained-params.json` into your branch, push, and
  `scripts/gh-measure.sh <branch> all 20`.

Artifacts per run: `train-state` (30 days), `champion`.

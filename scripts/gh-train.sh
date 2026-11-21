#!/usr/bin/env bash
# ES bot training on GitHub Actions (.github/workflows/bot-train.yml): one generation per run, chained until
# the generations hard stop. Zero local CPU.
#
#   scripts/gh-train.sh start <ref> <generations> ['<config json>'] [--from-trained]   start a chain, print its first run
#   scripts/gh-train.sh watch <label>      follow the chain to the end, then fetch it (as `fetch`)
#   scripts/gh-train.sh fetch <label>      download the latest state of a chain into .train-ci/<label>/
#   scripts/gh-train.sh stop <label>       cancel the chain's in-flight run (no further generations get dispatched)
#
# config keys: lambda, games, candSeats, players, maxSec, seed, duels, duelWeight, evalEvery, evalGames.
# fetch lays files out like a trainer checkout, so the local dashboard reads them:
#   pnpm train:watch --dir .train-ci/<label>      (.train/state.json, .train/log.jsonl, src/sim/bots/trained-params.json)
# and `tsx scripts/train-bots.ts --resume --dir .train-ci/<label>/.train` continues locally.
# Env: WORKFLOW_REF (branch holding the workflow, default main).
set -euo pipefail
REPO=ish-cs/faefight
WF=bot-train.yml
wf_ref=${WORKFLOW_REF:-main}
cmd=${1:-}

runs_of() { # all runs of a chain, newest first: id status conclusion
  gh run list --repo "$REPO" --workflow "$WF" --event workflow_dispatch --limit 200 --json databaseId,displayTitle,status,conclusion \
    --jq ".[] | select(.displayTitle | startswith(\"bot-train $1 @\")) | \"\(.databaseId) \(.status) \(.conclusion)\""
}

fetch() {
  local label=$1 out=.train-ci/$1 id=""
  # Newest run that produced a train-state artifact.
  for r in $(runs_of "$label" | awk '$3=="success"{print $1}'); do id=$r; break; done
  [ -n "$id" ] || { echo "gh-train: no finished run for '$label' yet" >&2; return 1; }
  rm -rf "$out/.dl" && mkdir -p "$out/.train" "$out/src/sim/bots"
  gh run download "$id" --repo "$REPO" -n train-state -D "$out/.dl"
  mv "$out/.dl/state.json" "$out/.dl/log.jsonl" "$out/.dl/ci-config.json" "$out/.train/"
  mv "$out/.dl/trained-params.json" "$out/src/sim/bots/"
  [ -f "$out/.dl/summary.md" ] && mv "$out/.dl/summary.md" "$out/.train/last-summary.md"
  rm -rf "$out/.dl"
  echo "gh-train: run $id → $out (generation $(jq .es.gen "$out/.train/state.json"), $(jq .games "$out/.train/state.json") games)" >&2
  [ -f "$out/.train/last-summary.md" ] && cat "$out/.train/last-summary.md"
  jq -r '.evals[] | "eval gen \(.gen): champion vs hand \(.share*100|round)% ± \(.ci95*100|round) (95% CI), decisive \(.decisive)/\(.games)"' "$out/.train/state.json"
}

case "$cmd" in
  start)
    ref=${2:?usage: gh-train.sh start <ref> <generations> [config] [--from-trained]}
    gens=${3:?usage: gh-train.sh start <ref> <generations> [config] [--from-trained]}
    config=${4:-'{}'}; ft=false
    [ "${5:-}" = --from-trained ] || [ "$config" = --from-trained ] && ft=true
    [ "$config" = --from-trained ] && config='{}'
    git ls-remote --exit-code origin "$ref" >/dev/null 2>&1 || [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]] || { echo "gh-train: '$ref' is not on origin — push it first" >&2; exit 1; }
    label="t$(date +%m%d-%H%M%S)"
    gh workflow run "$WF" --repo "$REPO" --ref "$wf_ref" -f ref="$ref" -f generations="$gens" -f config="$config" -f from_trained="$ft" -f label="$label" >/dev/null
    echo "gh-train: started chain '$label' ($gens generations @ $ref)" >&2
    for _ in $(seq 1 30); do id=$(runs_of "$label" | awk '{print $1}' | head -1); [ -n "${id:-}" ] && break; sleep 3; done
    echo "gh-train: https://github.com/$REPO/actions/runs/${id:-?}" >&2
    echo "$label"
    ;;
  watch)
    label=${2:?usage: gh-train.sh watch <label>}
    seen=""
    while :; do
      latest=$(runs_of "$label" | head -1)
      [ -n "$latest" ] || { echo "gh-train: no runs for '$label'" >&2; exit 1; }
      read -r id status concl <<<"$latest"
      if [ "$status" != completed ]; then
        [ "$id" = "$seen" ] || { echo "gh-train: run $id in progress (https://github.com/$REPO/actions/runs/$id)" >&2; seen=$id; }
        gh run watch "$id" --repo "$REPO" --interval 30 >/dev/null 2>&1 || true
        sleep 20 # the finished run dispatches the next one
        continue
      fi
      sleep 20
      [ "$(runs_of "$label" | head -1 | awk '{print $1}')" = "$id" ] || continue
      [ "$concl" = success ] || { echo "gh-train: run $id ended '$concl': gh run view $id --repo $REPO --log-failed" >&2; exit 1; }
      fetch "$label"
      st=.train-ci/$label/.train
      [ "$(jq .es.gen "$st/state.json")" -ge "$(jq .stopAtGen "$st/ci-config.json")" ] && exit 0
      echo "gh-train: waiting for the next generation's run…" >&2; sleep 30
    done
    ;;
  fetch) fetch "${2:?usage: gh-train.sh fetch <label>}" ;;
  stop)
    label=${2:?usage: gh-train.sh stop <label>}
    for id in $(runs_of "$label" | awk '$2!="completed"{print $1}'); do gh run cancel "$id" --repo "$REPO" && echo "gh-train: cancelled $id" >&2; done
    ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac

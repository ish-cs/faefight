#!/usr/bin/env bash
# Run a bot measurement series on GitHub Actions (.github/workflows/bot-measure.yml), wait, print the summary.
# Zero local CPU: the games run on up to 20 ubuntu runners.
#
#   scripts/gh-measure.sh <ref> <scenario> [seeds=20] [params-json-path-in-ref]
#   scenario: 1v1-hard | 1v1-pro-vs-hard | ffa8-pro | ffa8-hard | ffa8-mixed | all
#
# <ref> must be pushed to origin (a branch, tag or SHA). Env: WORKFLOW_REF (branch holding the workflow,
# default main), OUT (download dir, default .measure/<run id>). Exit code 0 = ship checks pass or n/a, 2 = fail.
set -euo pipefail
REPO=ish-cs/faefight
ref=${1:?usage: gh-measure.sh <ref> <scenario> [seeds] [params]}
scenario=${2:?usage: gh-measure.sh <ref> <scenario> [seeds] [params]}
seeds=${3:-20}
params=${4:-}
wf_ref=${WORKFLOW_REF:-main}
label="gh-measure-$(date +%s)-$$"

if ! git ls-remote --exit-code origin "$ref" >/dev/null 2>&1 && ! [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "gh-measure: '$ref' is not on origin — push it first" >&2; exit 1
fi
gh workflow run bot-measure.yml --repo "$REPO" --ref "$wf_ref" \
  -f ref="$ref" -f scenario="$scenario" -f seeds="$seeds" -f params="$params" -f label="$label" >/dev/null
echo "gh-measure: dispatched $scenario ×$seeds @ $ref (workflow from $wf_ref); finding the run…" >&2
run=""
for _ in $(seq 1 30); do
  run=$(gh run list --repo "$REPO" --workflow bot-measure.yml --event workflow_dispatch --limit 20 --json databaseId,displayTitle \
        --jq ".[] | select(.displayTitle | contains(\"$label\")) | .databaseId" | head -1)
  [ -n "$run" ] && break; sleep 3
done
[ -n "$run" ] || { echo "gh-measure: could not find the dispatched run" >&2; exit 1; }
echo "gh-measure: https://github.com/$REPO/actions/runs/$run" >&2
t0=$(date +%s)
gh run watch "$run" --repo "$REPO" --interval 20 --exit-status >/dev/null 2>&1 || true
concl=$(gh run view "$run" --repo "$REPO" --json conclusion --jq .conclusion)
out=${OUT:-.measure/$run}
mkdir -p "$out"
if ! gh run download "$run" --repo "$REPO" -n measure-summary -D "$out" 2>/dev/null; then
  echo "gh-measure: run $run ended '$concl' with no summary; logs: gh run view $run --repo $REPO --log-failed" >&2; exit 1
fi
cat "$out/summary.md"
echo "gh-measure: $concl in $(( $(date +%s) - t0 ))s · $out/measure-summary.json" >&2
[ "$concl" = success ] || { echo "gh-measure: run did not succeed (a shard failed?) — numbers may be partial" >&2; exit 1; }
[ "$(jq -r .shipCheckPass "$out/measure-summary.json")" != false ] || exit 2

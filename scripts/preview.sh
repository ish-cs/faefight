#!/usr/bin/env bash
# Deploys the current checkout as a Vercel PREVIEW (never production) and prints the preview URL.
#
#   scripts/preview.sh          # or: pnpm preview:deploy
#
# Needs the Vercel CLI logged in (`vercel whoami`). The project link lives in .vercel/ (gitignored):
# a worktree without it gets a copy from the main checkout. Vercel builds the uploaded files itself
# (pnpm build), so uncommitted changes are included. Only the last line of stdout is the URL, so
# agents can do: url=$(scripts/preview.sh | tail -1)
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

command -v vercel >/dev/null || { echo "preview: vercel CLI not found (npm i -g vercel)" >&2; exit 1; }
vercel whoami >/dev/null 2>&1 || { echo "preview: vercel CLI is not logged in (run: vercel login)" >&2; exit 1; }

if [ ! -f .vercel/project.json ]; then
  # Worktrees: the main checkout is the first entry of `git worktree list`.
  main=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
  if [ -f "$main/.vercel/project.json" ]; then
    cp -R "$main/.vercel" .vercel
    echo "preview: copied .vercel/ link from $main" >&2
  else
    echo "preview: no .vercel/project.json here or in $main; run 'vercel link' in the main checkout" >&2
    exit 1
  fi
fi
git check-ignore -q .vercel || { echo "preview: .vercel is not gitignored; refusing (it must never be committed)" >&2; exit 1; }

branch=$(git rev-parse --abbrev-ref HEAD)
echo "preview: deploying $branch @ $(git rev-parse --short HEAD) (preview, not production)..." >&2
# No --prod: this is always a preview deployment. vercel prints the deployment URL on stdout.
log=$(mktemp)
trap 'rm -f "$log"' EXIT
url=$(vercel deploy --yes --meta "branch=$branch" 2>"$log" | tail -1) || true
case "$url" in
  https://*) echo "$url" ;;
  *) cat "$log" >&2; echo "preview: deploy failed (no URL printed)" >&2; exit 1 ;;
esac

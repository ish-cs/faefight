#!/bin/bash
# Install (or reinstall) the nightly auto-improve launchd job for this checkout.
#   scripts/launchd/install.sh [repo-dir]      (default: the main checkout this script lives in)
# Disable: launchctl bootout gui/$(id -u)/com.faefight.autoimprove && rm ~/Library/LaunchAgents/com.faefight.autoimprove.plist
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${1:-$(cd "$HERE/../.." && pwd)}"
LABEL=com.faefight.autoimprove
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
PNPM="$(command -v pnpm)" || { echo "pnpm not on PATH" >&2; exit 1; }
NODE_BIN="$(dirname "$(command -v node)")"
CLAUDE_BIN="$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")"
VERCEL_BIN="$(dirname "$(command -v vercel 2>/dev/null || echo /opt/homebrew/bin/vercel)")"
JOB_PATH="$NODE_BIN:$CLAUDE_BIN:$VERCEL_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$REPO/.autoimprove/logs" "$HOME/Library/LaunchAgents"
sed -e "s#__REPO__#$REPO#g" -e "s#__PATH__#$JOB_PATH#g" -e "s#__PNPM__#$PNPM#g" -e "s#__HOME__#$HOME#g" "$HERE/$LABEL.plist" > "$DEST"
plutil -lint "$DEST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|path|program" | head -5
echo "installed $DEST (runs nightly at 03:00 in $REPO)"

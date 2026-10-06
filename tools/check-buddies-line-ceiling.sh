#!/usr/bin/env bash
# check-buddies-line-ceiling.sh — the Buddies code may not grow past tools/buddies-line-ceiling.
# Ratchet (same idea as client gate G8): non-test .ts/.rs lines under server/src/buddies and
# crates/unleashd-buddies/src. Runs as the first step of `pnpm typecheck` (CI + agents).
# Lower the ceiling in the same commit as any deletion so the cut cannot grow back.
set -euo pipefail
cd "$(dirname "$0")/.."

CEILING="$(tr -d '[:space:]' < tools/buddies-line-ceiling)"

# migrate.rs is excluded: it is one-time migration code, deleted after the live migration
# runs, so counting it would make the ceiling reward keeping it around.
LINES="$(
  find server/src/buddies crates/unleashd-buddies/src \
    \( -name '*.ts' -o -name '*.rs' \) ! -name '*.test.ts' ! -name 'migrate.rs' -print0 |
    xargs -0 cat | wc -l | tr -d ' '
)"

if [ "$LINES" -gt "$CEILING" ]; then
  echo "buddies-line-ceiling FAIL: $LINES lines, ceiling $CEILING."
  echo "  delete before you add; bump the ceiling only with a reason in the commit"
  echo "  (tools/buddies-line-ceiling)"
  exit 1
fi
echo "buddies-line-ceiling PASS ($LINES / $CEILING lines)"

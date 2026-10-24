#!/usr/bin/env bash
# check-line-ceilings-commit.sh [tree-ish] — the two line ratchets, judged on a COMMIT's tree.
# Default tree is the staged index (`git write-tree`), so this is the pre-commit hook
# (tools/install-git-hooks.sh). The typecheck-time checks (check-buddies-line-ceiling.sh, G8 in
# check-client-invariants.sh) read the working tree, which carries 150+ files from concurrent
# sessions, so on 2026-10-23 HEAD sat ~2k lines over the Buddies ceiling and every commit passed.
# Same file filters as those checks; the ceilings stay in their files.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
TREE="${1:-$(git write-tree)}"

# lines <include-regex> <exclude-regex>: `cat files | wc -l` over the tree's matching blobs.
# `cat-file --batch=''` frames each blob as an empty header line + content + newline: 2 extra.
lines() {
  local files n
  files="$(git ls-tree -r --name-only "$TREE" | grep -E "$1" | grep -vE "$2" || true)"
  [ -n "$files" ] || { echo 0; return; }
  n="$(printf '%s\n' "$files" | sed "s|^|$TREE:|" | git cat-file --batch='' | wc -l)"
  echo $((n - 2 * $(printf '%s\n' "$files" | wc -l)))
}

FAIL=0
judge() { # judge <name> <lines> <ceiling> <file holding the ceiling>
  if [ "$2" -gt "$3" ]; then
    echo "$1 FAIL: $2 lines in the commit, ceiling $3 ($4)."
    echo "  delete before you add; bump the ceiling only with a reason in the commit"
    FAIL=1
  else
    echo "$1 PASS ($2 / $3 lines)"
  fi
}

judge buddies-line-ceiling \
  "$(lines '^(server/src/buddies/.*\.ts|crates/unleashd-buddies/src/.*\.rs)$' '\.test\.ts$|/migrate\.rs$')" \
  "$(git cat-file blob "$TREE:tools/buddies-line-ceiling" | tr -d '[:space:]')" \
  tools/buddies-line-ceiling
judge G8-css "$(lines '^client/src/.*\.css$' '^$')" \
  "$(git cat-file blob "$TREE:tools/check-client-invariants.sh" | sed -nE 's/^CSS_LINE_CEILING=([0-9]+).*/\1/p')" \
  tools/check-client-invariants.sh
exit "$FAIL"

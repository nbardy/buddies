#!/usr/bin/env bash
# install-git-hooks.sh — installs the pre-commit line-ceiling check into the repo's COMMON hooks
# dir, so every worktree shares it. Run by `pnpm run bootstrap`; idempotent. The hook judges the
# staged tree (tools/check-line-ceilings-commit.sh), never the dirty working tree.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
HOOK="$(git rev-parse --path-format=absolute --git-common-dir)/hooks/pre-commit"
cat > "$HOOK" <<'HOOK'
#!/bin/sh
# Installed by tools/install-git-hooks.sh. Bypass for one commit: git commit --no-verify.
exec bash "$(git rev-parse --show-toplevel)/tools/check-line-ceilings-commit.sh"
HOOK
chmod +x "$HOOK"
echo "installed $HOOK"

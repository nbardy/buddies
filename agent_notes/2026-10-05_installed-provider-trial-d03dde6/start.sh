#!/bin/bash
# usage: start.sh <scenario: claude|codex|none> <port> <run-id>
# Starts the built clone in $T/repo against fresh temp stores. Pre-creates the first-boot
# markers so the async installer never downloads anything (and never writes into a real HOME).
set -euo pipefail
S=$1; PORT=$2; RUN=$3; T=/tmp/ipt; D=$T/$S-$RUN
NODEBIN=$(dirname "$(command -v node)")
[ ! -e "$D" ] || { echo "$D exists"; exit 1; }
B=$D/bin; ST=$D/state; H=$D/home
mkdir -p "$B" "$ST/data/dependency-setup" "$H"
for b in node pnpm; do ln -s "$NODEBIN/$b" "$B/$b"; done
for id in rust claude codex; do date -u +%FT%TZ > "$ST/data/dependency-setup/$id.attempted"; done
case $S in
  claude) ln -s "$(readlink -f ~/.local/bin/claude)" "$B/claude"; HOMEDIR=$HOME ;;   # real HOME: Claude auth; ~/.local/bin has no codex
  codex)  ln -s "$(readlink -f "$NODEBIN/codex")" "$B/codex"; HOMEDIR=$H ;;            # temp HOME so ~/.local/bin/claude is not appended
  none)   HOMEDIR=$H ;;
esac
openssl rand -hex 16 > "$D/token"
cd $T/repo
# Inherit the login environment (USER/TMPDIR: Claude reads its keychain login) minus this
# session's agent variables, so the trial server is not a nested Claude/Codex session.
UNSET=$(env | grep -oE '^(CLAUDE|CODEX|ANTHROPIC|OPENAI)[A-Z_]*' | sed 's/^/-u /' | tr '\n' ' ')
env $UNSET HOME="$HOMEDIR" CODEX_HOME="$HOME/.codex" PATH="$B:/usr/bin:/bin" PORT=$PORT \
  UNLEASHD_DATA_DIR=$ST/data UNLEASHD_BUDDIES_DB=$ST/buddies-v3.sqlite BUDDIES_HOME=$ST/buddies \
  UNLEASHD_AUTH_TOKEN=$(cat "$D/token") node server/dist/server.js > "$D/server.log" 2>&1 &
echo $! > "$D/server.pid"
echo "started $S pid $(cat $D/server.pid) port $PORT dir $D"

#!/bin/bash
# usage: run-claude.sh MODE PORT [HOLD_S] [REOPEN_S]
MODE=$1 PORT=$2 HOLD_S=${3:-60} REOPEN_S=${4:-0}
OUT=/tmp/outage-measure/claude-${TAG:-$MODE}
MODE=$MODE PORT=$PORT HOLD_S=$HOLD_S REOPEN_S=$REOPEN_S node /tmp/outage-measure/fake-mcp.mjs > $OUT.fake.log 2>&1 &
FP=$!
sleep 0.5
cd /tmp/outage-measure
START=$(date +%s)
command claude -p "Call the ping tool exactly once with note 'x'. Do not retry under any circumstances. Then reply with the exact tool result text or the exact error text." \
  --model claude-haiku-4-5 --dangerously-skip-permissions --strict-mcp-config \
  --mcp-config "{\"mcpServers\":{\"fake\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:$PORT/mcp\"}}}" \
  --output-format stream-json --verbose > $OUT.stream.jsonl 2> $OUT.stderr
echo "exit=$? elapsed=$(( $(date +%s) - START ))s" > $OUT.summary
kill $FP

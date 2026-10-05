#!/bin/bash
MODE=$1 PORT=$2 HOLD_S=${3:-60} REOPEN_S=${4:-0}
OUT=/tmp/outage-measure/codex-${TAG:-$MODE}
MODE=$MODE PORT=$PORT HOLD_S=$HOLD_S REOPEN_S=$REOPEN_S node /tmp/outage-measure/fake-mcp.mjs > $OUT.fake.log 2>&1 &
FP=$!
sleep 0.5
mkdir -p /tmp/outage-measure/cx && cd /tmp/outage-measure/cx
START=$(date +%s)
command codex exec --skip-git-repo-check --json -m gpt-5.6-luna -c model_reasoning_effort=low \
  --dangerously-bypass-approvals-and-sandbox \
  -c "mcp_servers.fake.url=\"http://127.0.0.1:$PORT/mcp\"" -c mcp_servers.fake.enabled=true \
  "Call the fake ping tool exactly once with note 'x'. Do not retry under any circumstances. Then reply with the exact tool result text or the exact error text." \
  > $OUT.stream.jsonl 2> $OUT.stderr < /dev/null
echo "exit=$? elapsed=$(( $(date +%s) - START ))s" > $OUT.summary
kill $FP

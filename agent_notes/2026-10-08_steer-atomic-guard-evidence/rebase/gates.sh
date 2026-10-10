#!/usr/bin/env bash
# Gates on the committed tree acf0a1a (rebased onto 4fcc0be) under the shared mkdir lock.
set -u
cd /Users/nicholasbardy/git/wt-steer-atomic-rebase
L=/tmp/steer-atomic-rebase
until mkdir /tmp/unleashd-test-ports.lock 2>/dev/null; do echo "waiting for lock $(date +%T)"; sleep 15; done
trap 'rmdir /tmp/unleashd-test-ports.lock' EXIT
echo "lock taken $(date +%T) HEAD=$(git rev-parse HEAD) parent=$(git rev-parse HEAD^) porcelain=$(git status --porcelain | wc -l | tr -d ' ')" | tee $L/meta.txt
: > $L/loop.log
fails=0
for i in $(seq 1 40); do
  out=$(pnpm exec tsx --test --test-name-pattern="an effort pick keeps the seat|latest thread reply model drives" server/test/buddies-v2.test.ts 2>&1)
  p=$(echo "$out" | grep -E '^ℹ pass' | awk '{print $3}'); f=$(echo "$out" | grep -E '^ℹ fail' | awk '{print $3}')
  echo "iter $i pass=$p fail=$f load=$(sysctl -n vm.loadavg)" >> $L/loop.log
  echo "$out" | grep -E '^✔|^✖' >> $L/loop.log
  if [ "$f" != "0" ] || [ "$p" != "2" ]; then fails=$((fails+1)); echo "$out" > $L/loop-fail-$i.log; fi
done
echo "LOOP DONE: 40 iterations x 2 tests, failing iterations=$fails" | tee -a $L/loop.log
pnpm exec tsx --test server/test/buddies-v2.test.ts > $L/buddies-v2.log 2>&1; echo "buddies-v2 exit $?" | tee -a $L/meta.txt
pnpm typecheck > $L/typecheck.log 2>&1; echo "typecheck exit $?" | tee -a $L/meta.txt
(cd crates/unleashd-buddies && pnpm test) > $L/crate.log 2>&1; echo "crate exit $?" | tee -a $L/meta.txt
bash tools/check-buddies-line-ceiling.sh > $L/line-gate.log 2>&1; echo "line gate exit $?" | tee -a $L/meta.txt
pnpm test:server > $L/server-full.log 2>&1; echo "test:server exit $?" | tee -a $L/meta.txt
echo "porcelain before mutations=$(git status --porcelain | wc -l | tr -d ' ')" | tee -a $L/meta.txt

M=$L/mutation-proof.log; : > $M
cp server/src/buddies/mcp.ts $L/mcp.ts.fix
git show HEAD^:server/src/buddies/mcp.ts > server/src/buddies/mcp.ts
echo "=== M1: server/src/buddies/mcp.ts replaced by 4fcc0be's (split listRuns guard + catchUpThread), crate fix kept ===" >> $M
pnpm exec tsx --test --test-name-pattern="an explicit pick posted inside the tool-call window is never steered" server/test/buddies-v2.test.ts 2>&1 | grep -E '^✔|^✖|^ℹ (pass|fail)|AssertionError|actual|expected' >> $M
cp $L/mcp.ts.fix server/src/buddies/mcp.ts
echo "=== M1 restored: fix ===" >> $M
pnpm exec tsx --test --test-name-pattern="an explicit pick posted inside the tool-call window is never steered" server/test/buddies-v2.test.ts 2>&1 | grep -E '^✔|^✖|^ℹ (pass|fail)' >> $M

D=crates/unleashd-buddies/src/deliveries.rs
cp $D $L/deliveries.rs.fix
python3 - "$D" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
k="pub(crate) fn redeliver_unanswered(tx: &Transaction, run: &Run, post_id: &str) -> Result<()> {\n"
assert k in s; s=s.replace(k, k+"    if true { return Ok(()); }\n"); open(p,'w').write(s)
PY
pnpm --dir crates/unleashd-buddies run build > $L/m2-build.log 2>&1
echo "=== M2: crate redeliver_unanswered disabled (returns Ok(()) before any work), rebuilt addon ===" >> $M
pnpm exec tsx --test --test-name-pattern="a post steered into a turn's last tool call is delivered again" server/test/buddies-v2.test.ts 2>&1 | grep -E '^✔|^✖|^ℹ (pass|fail)|Error' >> $M
cp $L/deliveries.rs.fix $D
pnpm --dir crates/unleashd-buddies run build > $L/m2-restore-build.log 2>&1
echo "=== M2 restored: fix, rebuilt ===" >> $M
pnpm exec tsx --test --test-name-pattern="a post steered into a turn's last tool call is delivered again" server/test/buddies-v2.test.ts 2>&1 | grep -E '^✔|^✖|^ℹ (pass|fail)' >> $M
echo "porcelain after=$(git status --porcelain | wc -l | tr -d ' ') HEAD=$(git rev-parse HEAD)" | tee -a $L/meta.txt
echo ALL DONE | tee -a $L/meta.txt

#!/usr/bin/env bash
# Gates on the committed tree d70d0a8 under the shared mkdir lock.
set -u
cd /Users/nicholasbardy/git/_wt/steer-atomic
L=/tmp/steer-atomic
until mkdir /tmp/unleashd-test-ports.lock 2>/dev/null; do echo "waiting for lock $(date +%T)"; sleep 15; done
trap 'rmdir /tmp/unleashd-test-ports.lock' EXIT
echo "lock taken $(date +%T) HEAD=$(git rev-parse HEAD) porcelain=$(git status --porcelain | wc -l | tr -d ' ')" | tee $L/meta.txt
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
echo "porcelain after=$(git status --porcelain | wc -l | tr -d ' ')" | tee -a $L/meta.txt
echo ALL DONE

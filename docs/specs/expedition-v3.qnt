// Expedition V3, minimal kernel (docs/expeditions/v3-first-principles-kernel.md). Revision 2.
//
// Models the concurrent core: Jobs on capacity-limited Pools (a job may hold SEVERAL pools), one
// budget meter with reservations and bounded overrun, per-family quotas of two kinds (refutations,
// starts), held judgment for multi-claim producers, judge-job failure as a typed outcome, serial
// re-checked integration with re-entry on restart, the plan trigger (E4) and stall (E5), the
// budget/quota prune, the deadline (bounds work, not judgment), owner gates that hold no slot,
// restart with adoption, and termination. LLM judgment (what a job emits, whether a judge passes)
// is a nondeterministic choice.
//
// Job table (ids 1..11):
//   1     work      pools {agent}       cost 2, maxClaims 2 -> claims 1, 2       family A
//   2     work      pools {agent}       cost 2, maxClaims 1 -> claim 3 (claim 4 is its refused excess)
//   3     inner     pools {agent, gpu}  cost 2  an agent turn running evals in-turn (multi-pool)  family R
//   4     replay    pools {gpu}         cost 1  a host command                                      family R
//   5,6,7 judge     pools {agent}       cost 1  judge of claim 1 / 2 / 3 (drawn from `held`)
//   8     owner     pools {owner}       cost 0  an owner gate: no agent slot, survives deadline
//   9,10,11 integrate pools {integ}     cost 0  merge + re-check + fast-forward of claim 1 / 2 / 3
// The plan job (E4) recurs, so it is a separate small state machine (`plan`), on pool agent.
// Family A counts REFUTATIONS (two strikes, quota QA). Family R counts STARTS (one replay, QR).
//
// FINDINGS kept as regression notes:
// - rev1 (seed 0x287581c0a591edc8): a producer spent the last budget, its judge could never
//   reserve, the run never finished. Fix: producers reserve their judgment; candidates move it
//   into `held`. Guard: notStuck (and rFinishedAllJudged).
// - rev2 critique probes, all violated on rev1: a failed judge JOB left a claim at candidate
//   (0x96c664cf36ac8874); an unaffordable pending spec idled the run to the deadline
//   (0xa488abb5063b34de); a restart lost the only integration (0xe9c7b722aee15a3b). Fixes: judge
//   failure -> claim `unjudged` (never a strike); the engine prunes specs that cannot ever start;
//   integration is judgment-class and re-entrant. Guards: rFinishedAllJudged, rNoRunningWedge,
//   rVerifiedIntegratedAtFinish.
module expedition_v3 {
  pure val JOBS = 1.to(11)
  pure val CLAIMS = 1.to(4)
  pure val POOLS = Set("agent", "gpu", "owner", "integ")
  pure val TOTAL = 8
  pure val OVER = 1          // usage-stream kill granularity: one usage event past the reservation
  pure val QA = 2            // family A: refutations before the family closes
  pure val QR = 1            // family R: starts ("exactly one replay")
  pure val SEATS = 1.to(3)   // providers
  pure val JUDGE_COST = 1
  pure val PLAN_COST = 1
  pure val MIN_INTERVAL = 5  // E4 minimum interval between plan starts (one cache TTL)
  pure val DEADLINE = 20

  pure def kind(j: int): str =
    if (j == 1 or j == 2) "work"
    else if (j == 3) "inner"
    else if (j == 4) "replay"
    else if (j >= 5 and j <= 7) "judge"
    else if (j == 8) "owner"
    else "integrate"

  pure def pools(j: int): Set[str] =
    if (kind(j) == "work" or kind(j) == "judge") Set("agent")
    else if (kind(j) == "inner") Set("agent", "gpu")
    else if (kind(j) == "replay") Set("gpu")
    else if (kind(j) == "owner") Set("owner")
    else Set("integ")

  pure def cap(p: str): int = if (p == "agent") 2 else if (p == "owner") 99 else 1

  pure def cost(j: int): int =
    if (kind(j) == "work" or kind(j) == "inner") 2
    else if (kind(j) == "replay" or kind(j) == "judge") 1
    else 0

  // Agent turns can overrun their reservation by at most OVER (killed on the usage stream);
  // commands are hard-capped by their own --max-usd / wall cap.
  pure def overrunnable(j: int): bool = pools(j).contains("agent")

  pure def family(j: int): str =
    if (kind(j) == "work") "A" else if (kind(j) == "inner" or kind(j) == "replay") "R" else "none"

  pure def producer(c: int): int = if (c <= 2) 1 else 2
  pure def rank(c: int): int = if (c == 1 or c == 3) 1 else 2       // emission order within its job
  pure def maxClaims(j: int): int = if (j == 1) 2 else if (j == 2) 1 else 0
  pure def judgeOf(c: int): int = c + 4                               // claims 1..3 -> jobs 5..7
  pure def claimOfJudge(j: int): int = j - 4
  pure def integOf(c: int): int = c + 8                               // claims 1..3 -> jobs 9..11
  pure def claimOfInteg(j: int): int = j - 8

  // What a start reserves: a producer also reserves maxClaims judgments (held on candidacy).
  pure def startCost(j: int): int = cost(j) + maxClaims(j) * JUDGE_COST
  // Judgment class: survives the deadline and drain. Integration is judgment class (rev2).
  pure def isJudgment(j: int): bool = kind(j) == "judge" or kind(j) == "owner" or kind(j) == "integrate"

  type S = {
    jstate: int -> str,     // none | pending | running | done | failed | lost | cancelled
    seat: int -> int,       // provider; 0 = not started
    reserved: int -> int,
    held: int,
    spent: int,
    overruns: int,
    claim: int -> str,      // none | claimed | candidate | verified | refuted | unjudged
    integ: int -> str,      // none | pending | landed | failed
    refutationsA: int,
    startsR: int,
    plan: str,              // idle | pending | running
    planReserved: int,
    planFp: int,            // fingerprint the last plan read at its start (-1: none yet)
    planAt: int,
    fp: int,                // ledger fingerprint: bumps on every settled row
    exp: str,               // running | draining | finished
    reason: str,            // "" | done | deadline | stopped | stalled | budget
    afterDeadline: bool,
    clock: int,
    // ghosts (for invariants and witnesses only)
    plans: int,
    adoptions: int,
    losts: int,
    judgeAfterDeadline: bool,
    ownerWithWork: bool,
    multiPoolRan: bool,
    prunedBudget: int,
    prunedQuota: int,
    spawnRefused: int,
    reintegrations: int,
    landedUnchecked: bool,
    reEntered: int,
  }

  var s: S

  def runningIn(st: S, p: str): int =
    JOBS.filter(j => st.jstate.get(j) == "running" and pools(j).contains(p)).size()
      + (if (p == "agent" and st.plan == "running") 1 else 0)
  def sumReserved(st: S): int = JOBS.fold(st.planReserved, (acc, j) => acc + st.reserved.get(j))
  def remaining(st: S): int = TOTAL - st.spent - sumReserved(st) - st.held
  def anyRunning(st: S): bool = JOBS.exists(j => st.jstate.get(j) == "running") or st.plan == "running"
  def anyPending(st: S): bool = JOBS.exists(j => st.jstate.get(j) == "pending") or st.plan == "pending"
  // Something running that can still release budget (owner gates cost 0 and release nothing).
  def budgetLive(st: S): bool =
    JOBS.exists(j => st.jstate.get(j) == "running" and kind(j) != "owner") or st.plan == "running"
  // A zero-cost job (owner gate, integration) reserves nothing, so it is affordable even after an
  // overrun drove `remaining` negative. FINDING rev2 (seed 0xdd3c4e2515d4c460, notStuck): with
  // `remaining >= 0` required, an overrun left a pending integration and owner gate unstartable
  // in drain forever.
  def affordable(st: S, j: int): bool =
    if (kind(j) == "judge") st.held >= JUDGE_COST
    else startCost(j) == 0 or remaining(st) >= startCost(j)
  def familyOpen(st: S, j: int): bool =
    if (family(j) == "A") st.refutationsA < QA
    else if (family(j) == "R") st.startsR < QR
    else true
  def capsFree(st: S, j: int): bool = pools(j).forall(p => runningIn(st, p) < cap(p))

  // The charter's Done predicate: any(claim 1 verified, all(claim 2 verified, claim 3 verified)).
  def donePred(st: S): bool =
    st.claim.get(1) == "verified" or (st.claim.get(2) == "verified" and st.claim.get(3) == "verified")

  pure def cancelWork(js: int -> str): int -> str =
    JOBS.mapBy(j => if (js.get(j) == "pending" and not(isJudgment(j))) "cancelled" else js.get(j))

  pure def drain(st: S, why: str): S =
    { ...st, exp: "draining", reason: why, jstate: cancelWork(st.jstate),
      plan: if (st.plan == "pending") "idle" else st.plan }

  // Engine reactions that run inside every commit (rev2):
  //  - overrun: spent + reserved + held past the budget drains `budget` at once;
  //  - quota prune: a pending spec of a closed family is cancelled{quota} at once;
  //  - budget prune: with nothing running that could release budget, a pending spec that cannot
  //    reserve (and a pending plan) is cancelled{budget}. Otherwise the run idles to the deadline.
  pure def react(st: S): S =
    if (st.exp != "running") st
    else if (st.spent + sumReserved(st) + st.held > TOTAL) drain(st, "budget")
    else
      val quotaDead = JOBS.filter(j =>
        st.jstate.get(j) == "pending" and not(isJudgment(j)) and not(familyOpen(st, j)))
      val js1 = JOBS.mapBy(j => if (quotaDead.contains(j)) "cancelled" else st.jstate.get(j))
      val st1 = { ...st, jstate: js1 }
      val idle = not(budgetLive(st1))
      val budgetDead = if (idle) JOBS.filter(j =>
        js1.get(j) == "pending" and not(isJudgment(j)) and not(affordable(st1, j))) else Set()
      val planDead = idle and st.plan == "pending" and remaining(st1) < PLAN_COST
      { ...st1,
        jstate: JOBS.mapBy(j => if (budgetDead.contains(j)) "cancelled" else js1.get(j)),
        plan: if (planDead) "idle" else st.plan,
        prunedQuota: st.prunedQuota + quotaDead.size(),
        prunedBudget: st.prunedBudget + budgetDead.size() + (if (planDead) 1 else 0),
      }

  action init = all {
    s' = {
      jstate: JOBS.mapBy(j => "none"),
      seat: JOBS.mapBy(j => 0),
      reserved: JOBS.mapBy(j => 0),
      held: 0, spent: 0, overruns: 0,
      claim: CLAIMS.mapBy(c => "none"),
      integ: CLAIMS.mapBy(c => "none"),
      refutationsA: 0, startsR: 0,
      plan: "pending",            // the seed is one plan job (case 7 would seed the whole DAG)
      planReserved: 0, planFp: -1, planAt: 0, fp: 0,
      exp: "running", reason: "", afterDeadline: false, clock: 0,
      plans: 0, adoptions: 0, losts: 0, judgeAfterDeadline: false, ownerWithWork: false,
      multiPoolRan: false, prunedBudget: 0, prunedQuota: 0, spawnRefused: 0, reintegrations: 0,
      landedUnchecked: false, reEntered: 0,
    }
  }

  // E4: plan only when the plan grant's fill pool (agent) is below its low-water mark, the
  // ledger changed since the last plan read it, and MIN_INTERVAL passed since the last plan.
  action planTick = all {
    s.exp == "running",
    s.plan == "idle",
    s.fp != s.planFp,
    runningIn(s, "agent") + JOBS.filter(j => s.jstate.get(j) == "pending" and pools(j).contains("agent")).size()
      < cap("agent"),
    s.plans == 0 or s.clock >= s.planAt + MIN_INTERVAL,
    remaining(s) >= PLAN_COST,
    s' = { ...s, plan: "pending", clock: s.clock + 1 },
  }

  action planStart = all {
    s.plan == "pending",
    s.exp == "running",
    runningIn(s, "agent") < cap("agent"),
    remaining(s) >= PLAN_COST,
    s' = react({ ...s, plan: "running", planReserved: PLAN_COST, planFp: s.fp, planAt: s.clock,
                 plans: s.plans + 1, clock: s.clock + 1 }),
  }

  // The plan settles: its spawns are a nondeterministic subset of the not-yet-spawned work, the
  // replay and the owner gate. Spawns are refused when the run is not running or the family is
  // closed (write path; a `refused` row bumps the fingerprint).
  action planSettle = all {
    s.plan == "running",
    val spawnable = JOBS.filter(j => s.jstate.get(j) == "none" and not(kind(j) == "judge" or kind(j) == "integrate"))
    nondet sp = spawnable.powerset().oneOf()
    nondet actual = 0.to(PLAN_COST + OVER).oneOf()
    val refused = if (s.exp != "running") sp else sp.filter(j => not(familyOpen(s, j)))
    val ok = sp.exclude(refused)
    s' = react({ ...s,
      plan: "idle", planReserved: 0, spent: s.spent + actual,
      overruns: if (actual > PLAN_COST) s.overruns + 1 else s.overruns,
      jstate: JOBS.mapBy(j => if (ok.contains(j)) "pending" else s.jstate.get(j)),
      spawnRefused: s.spawnRefused + refused.size(),
      fp: s.fp + 1, clock: s.clock + 1 }),
  }

  // Start: every pool in the job's pool set has capacity (reserved together), the budget
  // reservation fits, the family is open, the deadline has not passed for work.
  action start(j: int): bool = all {
    s.jstate.get(j) == "pending",
    s.exp == "running" or (s.exp == "draining" and isJudgment(j)),
    capsFree(s, j),
    affordable(s, j),
    familyOpen(s, j),
    nondet st = SEATS.oneOf()
    all {
      // judge: a provider different from its producer's
      kind(j) != "judge" or st != s.seat.get(producer(claimOfJudge(j))),
      val isWork = not(isJudgment(j))
      val workRunning = JOBS.exists(w => s.jstate.get(w) == "running" and not(isJudgment(w)))
      val ownerRunning = JOBS.exists(w => s.jstate.get(w) == "running" and kind(w) == "owner")
      s' = react({ ...s,
        jstate: s.jstate.set(j, "running"),
        clock: s.clock + 1,
        seat: s.seat.set(j, st),
        reserved: s.reserved.set(j, if (kind(j) == "judge") JUDGE_COST else startCost(j)),
        held: if (kind(j) == "judge") s.held - JUDGE_COST else s.held,
        startsR: if (family(j) == "R") s.startsR + 1 else s.startsR,
        multiPoolRan: s.multiPoolRan or pools(j).size() > 1,
        judgeAfterDeadline: s.judgeAfterDeadline or (kind(j) == "judge" and s.afterDeadline),
        ownerWithWork: s.ownerWithWork or (kind(j) == "owner" and workRunning) or (isWork and ownerRunning),
      }),
    },
  }

  // A producer settles: emitted claims beyond maxClaims are refused (kept at `claimed`, no
  // judgment held); each candidate moves one judgment into `held` and spawns its judge in the
  // same commit. A failed producer writes no claim and is never a strike.
  action settleWork(j: int): bool = all {
    kind(j) == "work",
    s.jstate.get(j) == "running",
    nondet ok = Set(true, false).oneOf()
    nondet emitted = CLAIMS.filter(c => producer(c) == j).powerset().oneOf()
    nondet actual = 0.to(cost(j) + OVER).oneOf()
    val cands = if (ok) emitted.filter(c => rank(c) <= maxClaims(j)) else Set()
    val excess = if (ok) emitted.exclude(cands) else Set()
    val js1 = s.jstate.set(j, if (ok) "done" else "failed")
    s' = react({ ...s,
      jstate: JOBS.mapBy(k => if (cands.exists(c => judgeOf(c) == k)) "pending" else js1.get(k)),
      reserved: s.reserved.set(j, 0),
      held: s.held + cands.size() * JUDGE_COST,
      spent: s.spent + actual,
      overruns: if (actual > cost(j)) s.overruns + 1 else s.overruns,
      claim: CLAIMS.mapBy(c => if (cands.contains(c)) "candidate" else if (excess.contains(c)) "claimed" else s.claim.get(c)),
      fp: s.fp + 1, clock: s.clock + 1 }),
  }

  // Inner (agent holding gpu) and replay (host command): a measurement, no claim in this model.
  action settleEval(j: int): bool = all {
    kind(j) == "inner" or kind(j) == "replay",
    s.jstate.get(j) == "running",
    nondet ok = Set(true, false).oneOf()
    nondet actual = 0.to(cost(j) + (if (overrunnable(j)) OVER else 0)).oneOf()
    s' = react({ ...s,
      jstate: s.jstate.set(j, if (ok) "done" else "failed"),
      reserved: s.reserved.set(j, 0),
      spent: s.spent + actual,
      overruns: if (actual > cost(j)) s.overruns + 1 else s.overruns,
      fp: s.fp + 1, clock: s.clock + 1 }),
  }

  // A judge settles with one of three outcomes. pass -> verified (+ its integration, E3, in the
  // same commit); fail -> refuted (a family-A strike); the judge JOB failed (malformed, timeout,
  // cannot_run) -> unjudged, never a strike.
  action settleJudge(j: int): bool = all {
    kind(j) == "judge",
    s.jstate.get(j) == "running",
    nondet outcome = Set("pass", "fail", "cannot").oneOf()
    nondet actual = 0.to(JUDGE_COST + OVER).oneOf()
    val c = claimOfJudge(j)
    val js1 = s.jstate.set(j, if (outcome == "cannot") "failed" else "done")
    s' = react({ ...s,
      jstate: if (outcome == "pass") js1.set(integOf(c), "pending") else js1,
      reserved: s.reserved.set(j, 0),
      spent: s.spent + actual,
      overruns: if (actual > JUDGE_COST) s.overruns + 1 else s.overruns,
      claim: s.claim.set(c, if (outcome == "pass") "verified" else if (outcome == "fail") "refuted" else "unjudged"),
      integ: if (outcome == "pass") s.integ.set(c, "pending") else s.integ,
      refutationsA: if (outcome == "fail") s.refutationsA + 1 else s.refutationsA,
      fp: s.fp + 1, clock: s.clock + 1 }),
  }

  // Owner gate: answered or expired (typed; the owner question's optional expiry).
  action settleOwner(j: int): bool = all {
    kind(j) == "owner",
    s.jstate.get(j) == "running",
    nondet answered = Set(true, false).oneOf()
    s' = react({ ...s, jstate: s.jstate.set(j, if (answered) "done" else "failed"),
                 fp: s.fp + 1, clock: s.clock + 1 }),
  }

  // Integrate = merge onto the branch head, re-run the claim's command-judge chain on the MERGED
  // sha, fast-forward only if both pass. A conflict or a re-check failure is a typed failure.
  action settleInteg(j: int): bool = all {
    kind(j) == "integrate",
    s.jstate.get(j) == "running",
    nondet merged = Set(true, false).oneOf()
    nondet recheck = Set(true, false).oneOf()
    val c = claimOfInteg(j)
    val landed = merged and recheck
    s' = react({ ...s,
      jstate: s.jstate.set(j, if (landed) "done" else "failed"),
      integ: s.integ.set(c, if (landed) "landed" else "failed"),
      landedUnchecked: s.landedUnchecked or (landed and not(recheck)),
      fp: s.fp + 1, clock: s.clock + 1 }),
  }

  // Backend restart. Each running process is adopted from its journal, or found dead. Dead work
  // and dead plans are `lost` with their reservation charged. A dead judge is charged and its
  // claim becomes `unjudged{lost}`. A dead integration is re-entered (pending again): it is
  // idempotent by (claim, merged sha). Owner gates are not processes.
  action restart = all {
    anyRunning(s),
    val procs = JOBS.filter(j => s.jstate.get(j) == "running" and kind(j) != "owner")
    nondet dead = procs.powerset().oneOf()
    nondet planDies = Set(true, false).oneOf()
    val planLost = s.plan == "running" and planDies
    val lostJobs = dead.filter(j => kind(j) != "integrate")
    val reentered = dead.filter(j => kind(j) == "integrate")
    val charge = lostJobs.fold(0, (acc, j) => acc + s.reserved.get(j)) + (if (planLost) s.planReserved else 0)
    s' = react({ ...s,
      jstate: JOBS.mapBy(j => if (lostJobs.contains(j)) "lost" else if (reentered.contains(j)) "pending" else s.jstate.get(j)),
      reserved: JOBS.mapBy(j => if (dead.contains(j)) 0 else s.reserved.get(j)),
      spent: s.spent + charge,
      plan: if (planLost) "idle" else s.plan,
      planReserved: if (planLost) 0 else s.planReserved,
      claim: CLAIMS.mapBy(c => if (c <= 3 and lostJobs.contains(judgeOf(c))) "unjudged" else s.claim.get(c)),
      adoptions: s.adoptions + procs.exclude(dead).size(),
      losts: s.losts + lostJobs.size() + (if (planLost) 1 else 0),
      reEntered: s.reEntered + reentered.size(),
      fp: s.fp + lostJobs.size(),
    }),
  }

  action deadline = all {
    not(s.afterDeadline),
    s.clock >= DEADLINE,
    s' = if (s.exp == "running") { ...drain(s, "deadline"), afterDeadline: true }
         else { ...s, afterDeadline: true },
  }

  action ownerStop = all {
    s.exp == "running",
    s.clock >= DEADLINE / 2,
    s' = drain(s, "stopped"),
  }

  // E6: the Done predicate holds.
  action declareDone = all {
    s.exp == "running",
    donePred(s),
    s' = drain(s, "done"),
  }

  // E5: nothing runs or waits. Budget if not even a plan fits; stalled if the last plan read the
  // current ledger (nothing changed since, so planning again would see the same thing).
  action quiesce = all {
    s.exp == "running",
    not(anyRunning(s)),
    not(anyPending(s)),
    remaining(s) < PLAN_COST or s.planFp == s.fp,
    s' = drain(s, if (remaining(s) < PLAN_COST) "budget" else "stalled"),
  }

  action finish = all {
    s.exp == "draining",
    not(anyRunning(s)),
    not(anyPending(s)),
    s' = { ...s, exp: "finished" },
  }

  // Owner act on a FINISHED record: re-integrate a verified claim whose integration failed.
  // Re-opens the record to draining (reason kept) until the integration settles.
  action ownerReintegrate(c: int): bool = all {
    s.exp == "finished",
    c <= 3,
    s.claim.get(c) == "verified",
    s.integ.get(c) == "failed",
    s' = { ...s, exp: "draining", jstate: s.jstate.set(integOf(c), "pending"),
           integ: s.integ.set(c, "pending"), reintegrations: s.reintegrations + 1 },
  }

  // Wall time passes (the deadline and E4's interval need it).
  action tick = all { s.exp != "finished", s' = { ...s, clock: s.clock + 1 } }

  action step = any {
    nondet j = JOBS.oneOf()
    any { start(j), settleWork(j), settleEval(j), settleJudge(j), settleOwner(j), settleInteg(j) },
    nondet c = CLAIMS.oneOf()
    ownerReintegrate(c),
    planTick, planStart, planSettle,
    restart, deadline, ownerStop, declareDone, quiesce, finish, tick,
  }

  // ---------------- outcome invariants ----------------
  // I1 restated: the budget can be exceeded only by bounded overrun, one OVER per overrunning job.
  val budgetBounded = s.spent + sumReserved(s) + s.held <= TOTAL + OVER * s.overruns and s.held >= 0
  // I2 with multi-pool jobs: no pool is over capacity, counting a job in every pool it holds.
  val poolCaps = POOLS.forall(p => runningIn(s, p) <= cap(p))
  val finishedQuiet = (s.exp == "finished") implies not(anyRunning(s) or anyPending(s))
  // Done is the predicate at finish, not merely at drain (claims never regress).
  val doneHonest = (s.exp == "finished" and s.reason == "done") implies donePred(s)
  // Probe 1: a finished run leaves no claim at candidate.
  val rFinishedAllJudged = (s.exp == "finished") implies CLAIMS.forall(c => s.claim.get(c) != "candidate")
  // Probe 2: a running run is never idle (nothing that releases budget running) while holding a
  // pending spec it can never start.
  val rNoRunningWedge = (s.exp == "running" and not(budgetLive(s))) implies all {
    JOBS.forall(j => s.jstate.get(j) == "pending" implies
      (isJudgment(j) or (affordable(s, j) and familyOpen(s, j)))),
    s.plan == "pending" implies remaining(s) >= PLAN_COST,
  }
  // Probe 3: at finish every verified claim has landed or carries a typed integration failure.
  val rVerifiedIntegratedAtFinish = (s.exp == "finished") implies
    CLAIMS.forall(c => s.claim.get(c) == "verified" implies (s.integ.get(c) == "landed" or s.integ.get(c) == "failed"))
  // Probe 4: held judgment is fully drawn by the end.
  val rHeldReleased = (s.exp == "finished") implies s.held == 0
  // Strikes are refutations only: unjudged (cannot_run, lost) never counts.
  val strikesAreRefutations = s.refutationsA == CLAIMS.filter(c => s.claim.get(c) == "refuted").size()
  // Starts quota: the replay family started at most QR times.
  val startsQuota = s.startsR <= QR
  // Nothing lands on the branch without the re-check on the merged sha.
  val landedChecked = not(s.landedUnchecked)
  // Draining never wedges on a judgment it cannot afford.
  val notStuck = not(s.exp == "draining" and not(anyRunning(s)) and
    JOBS.exists(j => s.jstate.get(j) == "pending" and not(affordable(s, j))))
  // E4 rate bound: plan starts are at least MIN_INTERVAL apart, so wakes <= 1 + time / interval.
  val planWakesBounded = s.plans <= 1 + s.planAt / MIN_INTERVAL

  val safety = budgetBounded and poolCaps and finishedQuiet and doneHonest and rFinishedAllJudged
    and rNoRunningWedge and rVerifiedIntegratedAtFinish and rHeldReleased and strikesAreRefutations
    and startsQuota and landedChecked and notStuck and planWakesBounded

  // ---------------- non-vacuity witnesses (each is EXPECTED to be violated) ----------------
  val wNeverVerified = CLAIMS.forall(c => s.claim.get(c) != "verified")
  val wNeverRefuted = CLAIMS.forall(c => s.claim.get(c) != "refuted")
  val wNeverUnjudged = CLAIMS.forall(c => s.claim.get(c) != "unjudged")
  val wNeverExcessClaim = s.claim.get(4) != "claimed"
  val wNeverTwoCandidates = not(s.claim.get(1) != "none" and s.claim.get(2) != "none")
  val wNeverLanded = CLAIMS.forall(c => s.integ.get(c) != "landed")
  val wNeverTwoLanded = CLAIMS.filter(c => s.integ.get(c) == "landed").size() < 2
  val wNeverIntegFailed = CLAIMS.forall(c => s.integ.get(c) != "failed")
  val wNeverReintegrated = s.reintegrations == 0
  val wNeverReEntered = s.reEntered == 0
  val wNeverFinishedDone = not(s.exp == "finished" and s.reason == "done")
  val wNeverFinishedDeadline = not(s.exp == "finished" and s.reason == "deadline")
  val wNeverFinishedBudget = not(s.exp == "finished" and s.reason == "budget")
  val wNeverFinishedStalled = not(s.exp == "finished" and s.reason == "stalled")
  val wNeverAdopted = s.adoptions == 0
  val wNeverLost = s.losts == 0
  val wStrikeQuotaNeverClosed = s.refutationsA < QA
  val wNeverPrunedQuota = s.prunedQuota == 0
  val wNeverPrunedBudget = s.prunedBudget == 0
  val wNeverSpawnRefused = s.spawnRefused == 0
  val wNoJudgeAfterDeadline = not(s.judgeAfterDeadline)
  val wOwnerBlocksWork = not(s.ownerWithWork)
  val wNeverMultiPool = not(s.multiPoolRan)
  val wNeverOverrun = s.overruns == 0
  val wStrictBudget = s.spent + sumReserved(s) + s.held <= TOTAL   // I1 without overrun: must break
  val wNeverHeld = s.held == 0
  val wSinglePlan = s.plans <= 1
}

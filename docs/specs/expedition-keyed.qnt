// Expeditions v1 KEYED KERNEL: the concurrent core of docs/expeditions/keyed/v1/DESIGN.md
// (§2 reconcile by key, §4 types, §5 rewrite, §6 I1–I8), over the canonical types in
// server/src/expedition-kernel/types.ts and the Executor port in ports.ts. Written 2026-11-10,
// before the kernel code, to check the design.
//
// What is modelled. Three keys, two hashes each, so six (key, hash) calls:
//   key 1  agent, JUDGED (producer run, then judge run), pool P, reserves usd 2
//   key 2  command, unjudged, pool P, reserves usd 1
//   key 3  ask: reserves nothing, holds no slot; the owner answers it
// Budget 4, pool P cap 2. The plan is a set of (key, hash) with at most one hash per key; a
// rewrite replaces it with any such set (27 plans). Plan dependencies (inputs) are not modelled:
// reconcile may take the asked calls in any order, an over-approximation of a real plan.
// The LOG is the only durable host state: a list of entries; every host decision is a fold over
// it. The EXECUTOR is outside the backend (it survives a crash); its start is idempotent on the
// runKey (key, hash, role) and the host can ask the status of a runKey (runIds derived from it).
// A crash loses host memory: in-memory reservations and start RPCs in flight. Each start RPC in
// flight at a crash has landed, was lost, or is in LIMBO (lands later, from the dead process).
//
// Aligned with the pure core (server/src/expedition-kernel/core/, 2026-11-10): `cancelling`
// holds its slot and reservation until it settles; replace cancels only an ATTACHED rival
// (draining/cancelling runs keep their standing); every settled outcome, refused included, is
// reused under the same hash; budget refuses only when spent + max > budget, else waits; past the
// deadline producers are cut off (cutOff), judges and asks are not. Pause is NOT modelled.
//
// FLAGS. The defaults are the design PLUS the smallest rules the model needed to hold. Flipping
// a FIX flag shows the flaw in the design as written; flipping a MECHANISM flag is a mutant.
//
//   diff (mutants/keyed/)        flag                      target (caught, 20000 samples)
//   k-f1_execfirst               LOG_FIRST=false           I4_runningIsAsked, I2b_noOrphan
//   k-f2_askcancel               ASK_SURVIVES=false        I6_askSurvives
//   k-f3_notomb                  EXEC_TOMBSTONE=false      I2b_noOrphan
//   k-f4_refusenow               BUDGET_QUEUE=false        not(wStaleRefusal)  (stale refusal reachable)
//   k-f5_nojudgeafterdeadline    JUDGE_AFTER_DEADLINE=false not(wStrandedJudge) (stranded call reachable)
//   k-q1_rewritewaits            LOG_FIRST=false + REWRITE_WAITS=true: I4 holds, I2b_noOrphan fails
//   k-m1_noreserve               RESERVE_COUNTS_OPEN=false I2_budget
//   k-m2_nonidempotent           IDEMPOTENT=false          I1_startOnce
//   k-m3_nodisposition           GATE_DISPOSITIONS=false   I4_runningIsAsked
//   k-m4_judgecancelled          JUDGE_NEEDS_OK=false      I7_noJudgeOfBadProducer
//   k-m5_resettle                SETTLE_ONCE=false         I3_settledOnce
//   k-m6_noslot                  SLOT_COUNTS_OPEN=false    poolCap (needs DEADLINE_AFTER_LOG=10)
//   k-m7_drainreleases           DRAIN_RELEASES=true       I2_budget (and drainKeeps)
//
// Run (from the repo root; quint via pnpm dlx, Rust backend; the file goes BEFORE --witnesses,
// which is variadic):
//   Q="pnpm dlx @informalsystems/quint"
//   $Q typecheck docs/specs/expedition-keyed.qnt
//   $Q run docs/specs/expedition-keyed.qnt --backend=rust --max-samples=50000 --max-steps=40 \
//      --invariant=safety --witnesses wCancelAndDrain wDrainedSettled wReattach ...
// A mutant: apply to a copy, run its target (add --mbt --out-itf=x.json for a readable trace):
//   patch -o /tmp/m.qnt docs/specs/expedition-keyed.qnt < docs/specs/mutants/keyed/k-m1_noreserve.diff
//   $Q run /tmp/m.qnt --backend=rust --max-samples=20000 --max-steps=40 --invariant=I2_budget
// Random simulation only (no JVM here, so no `quint verify`): bounded evidence, not proof.
module expedition_keyed {
  // ---------------- flags: fixes (true = the rule is in) ----------------
  pure val LOG_FIRST = true            // `started` (with its reservation) is logged BEFORE executor.start
  pure val ASK_SURVIVES = true         // an ask is never cancelled: dropped or reworded => draining
  pure val BUDGET_QUEUE = true         // short only because of reservations => queue, not refuse
  pure val JUDGE_AFTER_DEADLINE = true // a started call's judge is part of it and runs after the deadline
  pure val EXEC_TOMBSTONE = true       // settling a call closes its runKeys at the executor
  pure val REWRITE_WAITS = false       // a rewrite applies only when no start RPC is in flight
  pure val LIMBO = true                // a crashed process's start RPC may land later
  // Simulation aid, not a rule: the deadline may pass only once the log has this many entries
  // (0 = any time). Random runs otherwise spend most traces with the deadline at step 2.
  pure val DEADLINE_AFTER_LOG = 0
  // ---------------- flags: mechanisms (false = mutant) ----------------
  pure val IDEMPOTENT = true           // executor.start is idempotent on runKey
  pure val GATE_DISPOSITIONS = true    // rules gate: a cancel/finish for every running call dropped
  pure val RESERVE_COUNTS_OPEN = true  // affordability counts outstanding reservations
  pure val SLOT_COUNTS_OPEN = true     // pool check counts slots held by running calls
  pure val DRAIN_RELEASES = false      // (mutant when true) a draining call gives its reservation back
  pure val JUDGE_NEEDS_OK = true       // the judge starts only on a producer that answered ok
  pure val SETTLE_ONCE = true          // the host settles only an open call

  pure val KEYS = 1.to(3)
  pure val HASHES = 1.to(2)
  pure val KHS = tuples(KEYS, HASHES)
  pure val ROLES = Set("p", "j")
  pure val RKS = tuples(KEYS, HASHES, ROLES)
  pure val BUDGET = 4
  pure val CAP = 2
  pure val MAX_VER = 2
  pure val MAX_RESTARTS = 2
  // Every plan: per key, not asked (0) or one hash.
  pure val PLANS = tuples(0.to(2), 0.to(2), 0.to(2))
    .map(t => Set((1, t._1), (2, t._2), (3, t._3)).filter(x => x._2 > 0))

  pure def usd(k: int): int = if (k == 1) 2 else if (k == 2) 1 else 0
  pure def pooled(k: int): bool = k != 3
  pure def judged(k: int): bool = k == 1
  pure def isAsk(k: int): bool = k == 3
  pure def pRk(kh: (int, int)): (int, int, str) = (kh._1, kh._2, "p")
  pure def jRk(kh: (int, int)): (int, int, str) = (kh._1, kh._2, "j")
  pure def khOf(rk: (int, int, str)): (int, int) = (rk._1, rk._2)
  // What a raw run can end as (executor side). An agent producer can also be stopped from outside.
  pure def outsOf(rk: (int, int, str)): Set[str] =
    if (rk._1 == 3) Set("ok")
    else if (rk._1 == 1 and rk._3 == "p") Set("ok", "errored", "cancelled")
    else Set("ok", "no", "errored")

  // ---------------- the log ----------------
  type KH = (int, int)
  type RK = (int, int, str)
  type PlanE = { ver: int, asks: Set[KH], drop: Set[(int, str)] }   // drop: key -> cancel|finish
  type SettledE = { kh: KH, out: str, spent: int }
  type Entry =
    | EPlan(PlanE)
    | EStarted(KH)          // carries its reservation: usd(key) and the key's pools
    | ESettled(SettledE)    // passed|failed|errored|cancelled|refused-budget|refused-deadline
  type Run = { st: str, spent: int }   // st: none|running|ok|no|errored|cancelled

  var log: List[Entry]
  var ex: RK -> Run                    // the executor's runs, by runKey (survives a crash)
  var starts: RK -> int                // ghost: executor runs created per runKey (I1)
  var calling: Set[RK]                 // host memory: start RPCs in flight
  var intents: KH -> str               // host memory, LOG_FIRST=false only: none|reserved|called|landed
  var limbo: Set[RK]                   // start RPCs of a dead process that may still land
  var tomb: Set[RK]                    // executor: runKeys settled unstarted; a late start is a no-op
  var afterDeadline: bool
  var exSpent: int                     // ghost: every dollar any executor run spent
  var g: {
    restarts: int, idemHit: int, tombBlocked: int, queued: Set[KH], queueStarted: int,
    refBudget: int, refDeadline: int, drainSettled: int, drainJudged: int, judgeCancelled: int,
    reattach: int, crashWindow: int, liveAtRestart: Set[RK], replaceStart: int,
    askOpenAtDeadline: Set[KH], askAfterDeadline: int, askAfterRewrite: int,
    rwDuringJudge: int, rwDuringStart: int, cancelDrain: int, rewrites: int,
  }

  // ---------------- folds over the log ----------------
  pure def curPlan(l: List[Entry]): PlanE =
    l.foldl({ ver: 0, asks: Set(), drop: Set() }, (a, e) => match e { | EPlan(p) => p | _ => a })
  pure def isStarted(l: List[Entry], kh: KH): bool =
    l.foldl(false, (a, e) => match e { | EStarted(x) => a or x == kh | _ => a })
  pure def settleCount(l: List[Entry], kh: KH): int =
    l.foldl(0, (a, e) => match e { | ESettled(s) => if (s.kh == kh) a + 1 else a | _ => a })
  pure def firstOut(l: List[Entry], kh: KH): str =
    l.foldl("", (a, e) => match e { | ESettled(s) => if (s.kh == kh and a == "") s.out else a | _ => a })
  pure def spentLog(l: List[Entry]): int =
    l.foldl(0, (a, e) => match e { | ESettled(s) => a + s.spent | _ => a })
  pure def isOpen(l: List[Entry], kh: KH): bool = isStarted(l, kh) and settleCount(l, kh) == 0

  // A started call's standing under the plans logged after it. Forward-folded, so a restart
  // derives exactly what the running host knew. `undisposed` = running, not asked, no decision.
  pure def trans(st: str, p: PlanE, kh: KH): str =
    val k = kh._1
    if (p.asks.contains(kh)) "asked"
    // Replace (same key, new hash): only an ATTACHED run is a rival (core/state.ts rivalOf); a
    // draining or cancelling run keeps its standing and finishes on its own reservation.
    else if (HASHES.exists(h2 => p.asks.contains((k, h2))))
      (if (st != "asked" and st != "undisposed") st
       else if (isAsk(k) and ASK_SURVIVES) "draining" else "cancelling")
    else if (p.drop.contains((k, "finish"))) "draining"
    else if (p.drop.contains((k, "cancel"))) "cancelling"
    else if (st == "asked") "undisposed"
    else st
  pure def status(l: List[Entry], kh: KH): str =
    l.foldl({ asks: Set(), st: "none" }, (a, e) => match e {
      | EPlan(p) => { asks: p.asks, st: if (a.st == "none") "none" else trans(a.st, p, kh) }
      | EStarted(x) => if (x == kh) { ...a, st: if (a.asks.contains(kh)) "asked" else "undisposed" } else a
      | ESettled(_) => a
    }).st

  // ---------------- the ledger (host view) ----------------
  pure def holds(l: List[Entry], kh: KH): bool =
    isOpen(l, kh) and not(DRAIN_RELEASES and status(l, kh) == "draining")
  def ledgerRes: int =
    KHS.fold(0, (a, kh) => a + (if (holds(log, kh)) usd(kh._1) else 0))
      + KHS.fold(0, (a, kh) => a + (if (intents.get(kh) != "none") usd(kh._1) else 0))
  def affordable(k: int): bool =
    spentLog(log) + (if (RESERVE_COUNTS_OPEN) ledgerRes else 0) + usd(k) <= BUDGET
  def slotsUsed: int =
    (if (SLOT_COUNTS_OPEN) KHS.filter(kh => pooled(kh._1) and holds(log, kh)).size() else 0)
      + KHS.filter(kh => pooled(kh._1) and intents.get(kh) != "none").size()
  def poolFree(k: int): bool = not(pooled(k)) or slotsUsed < CAP

  def spentSoFar(kh: KH): int = ex.get(pRk(kh)).spent + ex.get(jRk(kh)).spent
  def live(kh: KH): bool = ex.get(pRk(kh)).st == "running" or ex.get(jRk(kh)).st == "running"
  // A start RPC still in flight that would create a run: not tombstoned, and (idempotent
  // executor) no run exists for its runKey yet. (Counting every pending RPC was a false I2 alarm:
  // a late duplicate start of a run that already exists is a no-op.)
  def mayLand(kh: KH): bool =
    ROLES.exists(r => val rk = (kh._1, kh._2, r)
      (calling.contains(rk) or limbo.contains(rk)) and not(tomb.contains(rk))
        and (not(IDEMPOTENT) or ex.get(rk).st == "none"))

  action init = all {
    nondet p0 = PLANS.oneOf()
    log' = [EPlan({ ver: 0, asks: p0, drop: Set() })],
    ex' = RKS.mapBy(rk => { st: "none", spent: 0 }),
    starts' = RKS.mapBy(rk => 0),
    calling' = Set(), intents' = KHS.mapBy(kh => "none"), limbo' = Set(), tomb' = Set(),
    afterDeadline' = false, exSpent' = 0,
    g' = { restarts: 0, idemHit: 0, tombBlocked: 0, queued: Set(), queueStarted: 0,
           refBudget: 0, refDeadline: 0, drainSettled: 0, drainJudged: 0, judgeCancelled: 0,
           reattach: 0, crashWindow: 0, liveAtRestart: Set(), replaceStart: 0,
           askOpenAtDeadline: Set(), askAfterDeadline: 0, askAfterRewrite: 0,
           rwDuringJudge: 0, rwDuringStart: 0, cancelDrain: 0, rewrites: 0 },
  }

  // ---------------- reconcile (one asked call at a time, atomic against the log) ----------------
  def wanted(kh: KH): bool =
    curPlan(log).asks.contains(kh) and not(isStarted(log, kh)) and settleCount(log, kh) == 0
      and intents.get(kh) == "none"

  // Reserve budget + slot and start. LOG_FIRST: `started` is appended now, the executor is called
  // after (execCall). Literal design: the reservation lives in memory until the executor answers.
  action reconcileStart(kh: KH): bool = all {
    wanted(kh),
    isAsk(kh._1) or (not(afterDeadline) and affordable(kh._1) and poolFree(kh._1)),
    val replacing = HASHES.exists(h2 => h2 != kh._2 and isOpen(log, (kh._1, h2)))
    all {
      if (LOG_FIRST) all { log' = log.append(EStarted(kh)), intents' = intents }
      else all { log' = log, intents' = intents.set(kh, "reserved") },
      g' = { ...g, queueStarted: g.queueStarted + (if (g.queued.contains(kh)) 1 else 0),
             replaceStart: g.replaceStart + (if (replacing) 1 else 0) },
    },
    ex' = ex, starts' = starts, calling' = calling, limbo' = limbo, tomb' = tomb,
    afterDeadline' = afterDeadline, exSpent' = exSpent,
  }
  action reconcileRefuseDeadline(kh: KH): bool = all {
    wanted(kh), not(isAsk(kh._1)), afterDeadline,
    log' = log.append(ESettled({ kh: kh, out: "refused-deadline", spent: 0 })),
    g' = { ...g, refDeadline: g.refDeadline + 1 },
    ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo, tomb' = closeRunKeys(kh),
    afterDeadline' = afterDeadline, exSpent' = exSpent,
  }
  // Literal design: refuse when it does not fit now. BUDGET_QUEUE: refuse only when spending
  // alone leaves no room (that never heals: spent only grows); otherwise wait like a full pool.
  action reconcileRefuseBudget(kh: KH): bool = all {
    wanted(kh), not(isAsk(kh._1)), not(afterDeadline), not(affordable(kh._1)),
    not(BUDGET_QUEUE) or spentLog(log) + usd(kh._1) > BUDGET,
    log' = log.append(ESettled({ kh: kh, out: "refused-budget", spent: 0 })),
    g' = { ...g, refBudget: g.refBudget + 1 },
    ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo, tomb' = closeRunKeys(kh),
    afterDeadline' = afterDeadline, exSpent' = exSpent,
  }
  def blocked(kh: KH): bool =
    not(isAsk(kh._1)) and not(afterDeadline) and
      (not(poolFree(kh._1)) or
        (BUDGET_QUEUE and not(affordable(kh._1)) and spentLog(log) + usd(kh._1) <= BUDGET))
  action reconcileQueue(kh: KH): bool = all {   // ghost only: the call waits
    wanted(kh), blocked(kh), not(g.queued.contains(kh)),
    g' = { ...g, queued: g.queued.union(Set(kh)) },
    log' = log, ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo,
    tomb' = tomb, afterDeadline' = afterDeadline, exSpent' = exSpent,
  }

  // ---------------- executor calls ----------------
  def pCallOk(kh: KH): bool =
    if (LOG_FIRST)
      isOpen(log, kh) and ex.get(pRk(kh)).st == "none" and status(log, kh) != "cancelling"
        and (not(afterDeadline) or isAsk(kh._1))
    else intents.get(kh) == "reserved" and (not(afterDeadline) or isAsk(kh._1))
  def jCallOk(kh: KH): bool =
    judged(kh._1) and isOpen(log, kh) and ex.get(jRk(kh)).st == "none"
      and (if (JUDGE_NEEDS_OK) ex.get(pRk(kh)).st == "ok"
           else Set("ok", "no", "cancelled").contains(ex.get(pRk(kh)).st))
      and status(log, kh) != "cancelling"
      and (JUDGE_AFTER_DEADLINE or not(afterDeadline))

  action execCall(rk: RK): bool = all {
    not(calling.contains(rk)),
    if (rk._3 == "p") pCallOk(khOf(rk)) else jCallOk(khOf(rk)),
    calling' = calling.union(Set(rk)),
    intents' = if (not(LOG_FIRST) and rk._3 == "p") intents.set(khOf(rk), "called") else intents,
    log' = log, ex' = ex, starts' = starts, limbo' = limbo, tomb' = tomb,
    afterDeadline' = afterDeadline, exSpent' = exSpent, g' = g,
  }
  // Literal design, after a crash: the start is never logged; an intent whose RPC was lost is
  // dropped after the deadline (reconcile then refuses it).
  action dropIntent(kh: KH): bool = all {
    not(LOG_FIRST), intents.get(kh) == "reserved", afterDeadline, not(isAsk(kh._1)),
    intents' = intents.set(kh, "none"),
    log' = log, ex' = ex, starts' = starts, calling' = calling, limbo' = limbo, tomb' = tomb,
    afterDeadline' = afterDeadline, exSpent' = exSpent, g' = g,
  }

  // The executor receives a start. Idempotent: an existing runKey returns its run.
  pure def landRun(exm: RK -> Run, st: RK -> int, tb: Set[RK], rk: RK): { ex: RK -> Run, starts: RK -> int, hit: int, blocked: int } =
    if (tb.contains(rk)) { ex: exm, starts: st, hit: 0, blocked: 1 }
    else if (exm.get(rk).st != "none" and IDEMPOTENT) { ex: exm, starts: st, hit: 1, blocked: 0 }
    else { ex: exm.set(rk, { st: "running", spent: 0 }), starts: st.set(rk, st.get(rk) + 1), hit: 0, blocked: 0 }

  action execLand(rk: RK): bool = all {
    calling.contains(rk),
    val r = landRun(ex, starts, tomb, rk)
    all {
      ex' = r.ex, starts' = r.starts,
      g' = { ...g, idemHit: g.idemHit + r.hit, tombBlocked: g.tombBlocked + r.blocked },
    },
    calling' = calling.exclude(Set(rk)),
    intents' = if (not(LOG_FIRST) and rk._3 == "p" and intents.get(khOf(rk)) == "called")
                 intents.set(khOf(rk), "landed") else intents,
    log' = log, limbo' = limbo, tomb' = tomb, afterDeadline' = afterDeadline, exSpent' = exSpent,
  }
  action limboLand(rk: RK): bool = all {
    limbo.contains(rk),
    val r = landRun(ex, starts, tomb, rk)
    all {
      ex' = r.ex, starts' = r.starts,
      g' = { ...g, idemHit: g.idemHit + r.hit, tombBlocked: g.tombBlocked + r.blocked },
    },
    limbo' = limbo.exclude(Set(rk)),
    log' = log, calling' = calling, intents' = intents, tomb' = tomb,
    afterDeadline' = afterDeadline, exSpent' = exSpent,
  }
  // Literal design: the executor answered with a runId; now `started` is appended. No check that
  // the plan still asks for it (nothing in the design says to).
  action logStarted(kh: KH): bool = all {
    not(LOG_FIRST), intents.get(kh) == "landed",
    log' = log.append(EStarted(kh)), intents' = intents.set(kh, "none"),
    ex' = ex, starts' = starts, calling' = calling, limbo' = limbo, tomb' = tomb,
    afterDeadline' = afterDeadline, exSpent' = exSpent, g' = g,
  }

  // A raw run ends: an agent answers, a command exits, the owner answers. Spend never passes the
  // call's reservation (the harness enforces max.usd; producer + judge share it).
  action exFinish(rk: RK): bool = all {
    ex.get(rk).st == "running",
    nondet o = outsOf(rk).oneOf()
    nondet sp = 0.to(usd(rk._1) - spentSoFar(khOf(rk))).oneOf()
    all { ex' = ex.set(rk, { st: o, spent: sp }), exSpent' = exSpent + sp },
    log' = log, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo,
    tomb' = tomb, afterDeadline' = afterDeadline, g' = g,
  }
  // Level-triggered from the log: every running run of a `cancelling` call is cancelled.
  action sendCancel(rk: RK): bool = all {
    ex.get(rk).st == "running", isOpen(log, khOf(rk)), status(log, khOf(rk)) == "cancelling",
    nondet sp = 0.to(usd(rk._1) - spentSoFar(khOf(rk))).oneOf()
    all { ex' = ex.set(rk, { st: "cancelled", spent: sp }), exSpent' = exSpent + sp },
    log' = log, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo,
    tomb' = tomb, afterDeadline' = afterDeadline, g' = g,
  }

  // Every settle closes the call's runKeys at the executor: a start with a closed runKey that
  // arrives later (a dead process's RPC, LIMBO) is a no-op. Without it the model found an orphan
  // JUDGE: judge RPC in flight at a crash, a rewrite cancels the call, the host settles it
  // cancelled (no judge run visible), then the judge start lands and runs outside every ledger.
  def closeRunKeys(kh: KH): Set[RK] = if (EXEC_TOMBSTONE) tomb.union(Set(pRk(kh), jRk(kh))) else tomb

  // ---------------- settle (the host observes the executor; also how a restart re-attaches) ----------------
  action settleGhosts(kh: KH, out: str, viaJudge: bool): bool = all {
    val st = status(log, kh)
    val rk = if (viaJudge) jRk(kh) else pRk(kh)
    g' = { ...g,
      drainSettled: g.drainSettled + (if (st == "draining" and (out == "passed" or out == "failed")) 1 else 0),
      drainJudged: g.drainJudged + (if (st == "draining" and viaJudge and out != "cancelled") 1 else 0),
      judgeCancelled: g.judgeCancelled + (if (viaJudge and out == "cancelled") 1 else 0),
      reattach: g.reattach + (if (g.liveAtRestart.contains(rk)) 1 else 0),
      askAfterDeadline: g.askAfterDeadline + (if (isAsk(kh._1) and g.askOpenAtDeadline.contains(kh)) 1 else 0),
      askAfterRewrite: g.askAfterRewrite + (if (isAsk(kh._1) and st == "draining") 1 else 0) },
  }
  def settleable(kh: KH): bool =
    if (SETTLE_ONCE) isOpen(log, kh) else isStarted(log, kh)

  // The producer ended and no judge will run: an unjudged call settles on its raw outcome; a
  // judged call that answered ok settles only if it is being cancelled (cancelled{partial}).
  action observeP(kh: KH): bool = all {
    settleable(kh),
    val o = ex.get(pRk(kh)).st
    val cancelling = status(log, kh) == "cancelling"
    val out = if (o == "ok") (if (judged(kh._1)) "cancelled" else "passed") else if (o == "no") "failed" else o
    all {
      o != "none", o != "running",
      ex.get(jRk(kh)).st == "none", not(calling.contains(jRk(kh))),
      not(o == "ok" and judged(kh._1) and not(cancelling)),
      log' = log.append(ESettled({ kh: kh, out: out, spent: spentSoFar(kh) })),
      settleGhosts(kh, out, false),
    },
    ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo, tomb' = closeRunKeys(kh),
    afterDeadline' = afterDeadline, exSpent' = exSpent,
  }
  action observeJ(kh: KH): bool = all {
    settleable(kh),
    val o = ex.get(jRk(kh)).st
    val out = if (o == "ok") "passed" else if (o == "no") "failed" else o
    all {
      o != "none", o != "running",
      log' = log.append(ESettled({ kh: kh, out: out, spent: spentSoFar(kh) })),
      settleGhosts(kh, out, true),
    },
    ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo, tomb' = closeRunKeys(kh),
    afterDeadline' = afterDeadline, exSpent' = exSpent,
  }
  // LOG_FIRST: a logged start whose run never landed (status `unknown`) and must not run now
  // (cancelled by a rewrite, or the deadline passed): settle it with nothing spent.
  action settleUnstarted(kh: KH): bool = all {
    LOG_FIRST, isOpen(log, kh), ex.get(pRk(kh)).st == "none", not(calling.contains(pRk(kh))),
    val cancelling = status(log, kh) == "cancelling"
    all {
      cancelling or (afterDeadline and not(isAsk(kh._1))),
      log' = log.append(ESettled({ kh: kh, out: if (cancelling) "cancelled" else "refused-deadline", spent: 0 })),
    },
    tomb' = closeRunKeys(kh),
    ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo,
    afterDeadline' = afterDeadline, exSpent' = exSpent, g' = g,
  }

  // ---------------- rewrite ----------------
  // Gates 1–2 and the rules other than dispositions are not modelled (they reject; I8). Apply
  // appends one `plan` entry. Running calls whose KEY the new plan does not ask for, and that are
  // not already draining or cancelling, each get a disposition; the leader chooses.
  action rewrite = all {
    g.rewrites < MAX_VER,
    not(REWRITE_WAITS) or (calling == Set() and KHS.forall(kh => intents.get(kh) == "none")),
    nondet asks = PLANS.oneOf()
    val cur = curPlan(log)
    val needs = KEYS.filter(k => not(HASHES.exists(h => asks.contains((k, h)))) and
      HASHES.exists(h => isOpen(log, (k, h)) and Set("asked", "undisposed").contains(status(log, (k, h)))))
    nondet fin = needs.powerset().oneOf()
    val drop = if (GATE_DISPOSITIONS)
        needs.map(k => (k, if ((isAsk(k) and ASK_SURVIVES) or fin.contains(k)) "finish" else "cancel"))
      else Set()
    val droppedKh = KHS.filter(kh => not(asks.contains(kh)))
    all {
      log' = log.append(EPlan({ ver: cur.ver + 1, asks: asks, drop: drop })),
      g' = { ...g, rewrites: g.rewrites + 1,
        rwDuringJudge: g.rwDuringJudge + (if (droppedKh.exists(kh => isOpen(log, kh) and ex.get(jRk(kh)).st == "running")) 1 else 0),
        rwDuringStart: g.rwDuringStart + (if (droppedKh.exists(kh => calling.contains(pRk(kh)) or intents.get(kh) != "none")) 1 else 0),
        cancelDrain: g.cancelDrain + (if (drop.exists(d => d._2 == "cancel") and drop.exists(d => d._2 == "finish")) 1 else 0) },
    },
    ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo, tomb' = tomb,
    afterDeadline' = afterDeadline, exSpent' = exSpent,
  }

  // ---------------- crash and restart ----------------
  // Host memory is lost. Each start RPC in flight landed, was lost, or (LIMBO) lands later.
  // Nothing else happens at boot: the actions above re-derive everything from the log and the
  // executor's status by runKey, which is the re-attach.
  action restart = all {
    g.restarts < MAX_RESTARTS,
    nondet landed = calling.powerset().oneOf()
    nondet lim = (if (LIMBO) calling.exclude(landed) else Set()).powerset().oneOf()
    val r = landed.fold({ ex: ex, starts: starts, hit: 0, blocked: 0 },
      (a, rk) => val x = landRun(a.ex, a.starts, tomb, rk)
                 { ex: x.ex, starts: x.starts, hit: a.hit + x.hit, blocked: a.blocked + x.blocked })
    all {
      ex' = r.ex, starts' = r.starts, limbo' = limbo.union(lim),
      g' = { ...g, restarts: g.restarts + 1, idemHit: g.idemHit + r.hit,
        liveAtRestart: RKS.filter(rk => r.ex.get(rk).st == "running"),
        crashWindow: g.crashWindow + (if (calling != Set() or KHS.exists(kh => intents.get(kh) == "landed")) 1 else 0) },
    },
    calling' = Set(), intents' = KHS.mapBy(kh => "none"),
    log' = log, tomb' = tomb, afterDeadline' = afterDeadline, exSpent' = exSpent,
  }

  // Past the deadline the host cancels producers of agents and commands (core/finish.ts cutOff);
  // never a judge or an ask. The call then settles `cancelled` through observeP.
  action deadlineCut(rk: RK): bool = all {
    afterDeadline, rk._3 == "p", not(isAsk(rk._1)), ex.get(rk).st == "running",
    nondet sp = 0.to(usd(rk._1) - spentSoFar(khOf(rk))).oneOf()
    all { ex' = ex.set(rk, { st: "cancelled", spent: sp }), exSpent' = exSpent + sp },
    log' = log, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo,
    tomb' = tomb, afterDeadline' = afterDeadline, g' = g,
  }

  action deadline = all {
    not(afterDeadline), log.length() >= DEADLINE_AFTER_LOG,
    afterDeadline' = true,
    g' = { ...g, askOpenAtDeadline: KHS.filter(kh => isAsk(kh._1) and isOpen(log, kh)) },
    log' = log, ex' = ex, starts' = starts, calling' = calling, intents' = intents, limbo' = limbo,
    tomb' = tomb, exSpent' = exSpent,
  }

  action step = any {
    nondet kh = KHS.oneOf()
    any { reconcileStart(kh), reconcileRefuseDeadline(kh), reconcileRefuseBudget(kh), reconcileQueue(kh),
          dropIntent(kh), logStarted(kh), observeP(kh), observeJ(kh), settleUnstarted(kh) },
    nondet rk = RKS.oneOf()
    any { execCall(rk), execLand(rk), limboLand(rk), exFinish(rk), sendCancel(rk), deadlineCut(rk) },
    rewrite, restart, deadline,
  }

  // ---------------- invariants (names as in DESIGN.md §6) ----------------
  // I1: a (key, hash) starts at most once (per role: one producer run, one judge run), across
  // restarts and rewrites. Counted at the executor, which is what costs money.
  val I1_startOnce = RKS.forall(rk => starts.get(rk) <= 1)
  // I2 (ledger): what the host's log says.
  val I2_ledger = spentLog(log) + ledgerRes <= BUDGET
  // I2 (truth): every dollar spent by any run, plus what every call that can still spend may
  // spend, including runs the log does not know about.
  val I2_budget = I2_ledger and
    exSpent + KHS.fold(0, (a, kh) => a +
      (if (isOpen(log, kh) or live(kh) or mayLand(kh) or intents.get(kh) != "none")
         usd(kh._1) - spentSoFar(kh) else 0)) <= BUDGET
  // I3: a settled outcome never changes (the log is append-only, so: one settle per call).
  val I3_settledOnce = KHS.forall(kh => settleCount(log, kh) <= 1)
  // I4: after reconcile quiesces, every running call is asked for by the current plan, draining,
  // or being cancelled (the cancel is in flight).
  val quiesced = calling == Set() and KHS.forall(kh => intents.get(kh) == "none") and
    curPlan(log).asks.forall(kh => settleCount(log, kh) > 0 or isOpen(log, kh) or blocked(kh))
  val I4_runningIsAsked = quiesced implies
    KHS.forall(kh => isOpen(log, kh) implies Set("asked", "draining", "cancelling").contains(status(log, kh)))
  // I2b: after quiescence, no executor run is running that the log does not hold open (an orphan
  // spends and occupies a pool slot outside every ledger, and nothing will ever cancel it).
  val I2b_noOrphan = (quiesced and limbo == Set()) implies
    RKS.forall(rk => ex.get(rk).st == "running" implies isOpen(log, khOf(rk)))
  // I6: a pending ask survives the deadline and any rewrite: it ends only by being answered.
  val I6_askSurvives = HASHES.forall(h =>
    Set("", "passed").contains(firstOut(log, (3, h))) and ex.get((3, h, "p")).st != "cancelled")
  // I7: an errored or cancelled producer is never judged.
  val I7_noJudgeOfBadProducer = KHS.forall(kh =>
    ex.get(jRk(kh)).st != "none" implies ex.get(pRk(kh)).st == "ok")
  // Pools: slots in use never exceed the cap, in the host's ledger and in running reality.
  val poolCap = slotsUsed <= CAP and KHS.filter(kh => pooled(kh._1) and live(kh)).size() <= CAP
  // A draining call keeps its reservation and slot until it settles.
  val drainKeeps = KHS.forall(kh => (isOpen(log, kh) and status(log, kh) == "draining") implies holds(log, kh))

  val safety = I1_startOnce and I2_budget and I3_settledOnce and I4_runningIsAsked and I2b_noOrphan
    and I6_askSurvives and I7_noJudgeOfBadProducer and poolCap and drainKeeps

  // ---------------- witnesses (each must be reachable; --witnesses counts traces) ----------------
  val wCancelAndDrain = g.cancelDrain > 0           // one rewrite cancels one call and drains another
  val wDrainedSettled = g.drainSettled > 0          // a draining call ran to passed/failed
  val wDrainedJudged = g.drainJudged > 0            // ... and its judge ran after the rewrite
  val wRewriteDuringJudge = g.rwDuringJudge > 0     // a rewrite dropped a call while its judge ran
  val wJudgeCancelled = g.judgeCancelled > 0        // a judge was cancelled (by a rewrite)
  val wRewriteDuringStart = g.rwDuringStart > 0     // a rewrite dropped a call mid-start
  val wReattach = g.reattach > 0                    // a run live at a restart settled after it
  val wCrashInStart = g.crashWindow > 0             // a crash with a start RPC in flight
  val wIdempotentHit = g.idemHit > 0                // a second start returned the first run
  val wTombBlocked = g.tombBlocked > 0              // a late (limbo) start was a no-op
  val wPoolQueue = g.queueStarted > 0               // a call waited on the pool (or budget), then started
  val wReplace = g.replaceStart > 0                 // same key, new hash, while the old one still runs
  val wRefuseBudget = g.refBudget > 0
  val wRefuseDeadline = g.refDeadline > 0
  val wAskAfterDeadline = g.askAfterDeadline > 0    // an ask open at the deadline was answered
  val wAskAfterRewrite = g.askAfterRewrite > 0      // an ask a rewrite dropped was answered
  val wReuseCancelled = curPlan(log).asks.exists(kh => firstOut(log, kh) == "cancelled")
  // Literal design (BUDGET_QUEUE=false): a call the plan asks for is refused{budget} forever,
  // although it fits now.
  val wStaleRefusal = curPlan(log).asks.exists(kh =>
    firstOut(log, kh) == "refused-budget" and spentLog(log) + ledgerRes + usd(kh._1) <= BUDGET)
  // Literal design (JUDGE_AFTER_DEADLINE=false): a produced call that nothing can ever settle.
  val wStrandedJudge = afterDeadline and KHS.exists(kh => judged(kh._1) and isOpen(log, kh)
    and ex.get(pRk(kh)).st == "ok" and ex.get(jRk(kh)).st == "none" and not(calling.contains(jRk(kh)))
    and status(log, kh) != "cancelling" and not(JUDGE_AFTER_DEADLINE))
}

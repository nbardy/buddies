// Expedition HOST model (docs/expeditions/final/expedition.d.ts). The script and LLM judgment
// are not modelled: what the script calls next and what a judge, owner or leader returns are
// nondeterministic choices. Only the host primitives are: calls with all-or-nothing pool
// reservation, the budget, the deadline, journal replay, owner asks, objective revision (CAS on
// the version the owner saw), finish, and reflection grading.
//
// Calls (journal keys 1..3):  1 agent {agent} usd 2 | 2 agent + alsoHolds {agent, gpu} usd 2 |
//                             3 check {gpu} usd 1
// Finish: criterion 1 is a check on gpu (usd 1, runs after the deadline); criterion 2 is owner.
// Integration: one `x.integrate`, its recheck on gpu (usd 1, runs after the deadline).
// Asks: the revision ask (weaken/redirect) and the finish owner ask. Neither holds a slot.
//
// API GAPS found by modelling (each marked `API GAP` / `HOST RULE` at its action):
// - no result for a call whose reservation cannot be made (budget left < usd): refuseBudget;
// - revise() has no `stale` outcome for an owner yes on a version that has since moved;
// - nothing reserves finish's own criterion checks, so a spent run cannot judge (finStarve);
// - finish may be called forever after the deadline (no reflect needed): host allows one;
// - FinishResult `met` names no objective version; the model requires ver == finVer.
module expedition_host {
  pure val CALLS = 1.to(3)
  pure val POOLS = Set("agent", "gpu")
  pure val CRITS = 1.to(2)
  pure val SHAS = 1.to(2)
  pure val TOTAL = 4         // below the calls' total (5), so the budget binds
  pure val JUDGE_USD = 1     // a finish criterion check or an integration recheck
  pure val POST_K = 12       // most host steps possible after the deadline (see postDeadlineBounded)

  pure def pools(c: int): Set[str] = if (c == 1) Set("agent") else if (c == 2) Set("agent", "gpu") else Set("gpu")
  pure def cost(c: int): int = if (c == 3) 1 else 2
  pure def cap(p: str): int = 1

  type S = {
    cs: int -> str,         // idle | pending | running | done   (done = journaled result)
    issued: int -> bool,    // the current script incarnation has called it
    res: int -> str,        // "" | ok | reservation | deadline | cancelled | harness-error | refused-budget
    reserved: int -> int,
    used: str -> int,       // the host's slot counters (what start/settle write)
    spent: int,
    afterDeadline: bool,
    ended: str,             // "" | met | owner-declined | deadline
    ver: int,               // objective version
    revAsk: bool,           // a weaken/redirect ask is open
    revSeen: int,           // the version the owner was shown
    fin: str,               // none | pendingCheck | checkRunning | asking
    finSha: int,
    finVer: int,
    finRes: int,
    finPostDeadline: int,   // finish proposals after the deadline (host allows one)
    passed: Set[(int, int)], // (criterion, sha) that passed
    integ: str,             // none | pending | running | done | starved
    integRes: int,
    predPending: bool,      // the previous accepted Decision carried predictions
    streak: int,            // consecutive graded reflections whose predictions all missed
    // ghosts
    runs: int -> int,
    replays: int, restarts: int, adoptions: int, deaths: int,
    workAfterDeadline: bool, finProposals: int, finResolved: int, integRequested: bool,
    weakens: int, staleRevs: int, weakenedUnseen: bool,
    refusals: int, contAfterTwoMisses: bool,
    askWhileFull: bool, reservationStops: int, budgetRefusals: int,
    finStarved: bool, finCheckPostDeadline: bool, integPostDeadline: bool,
    notMets: int, afterWork: int,
  }

  var s: S

  pure def runningOn(st: S, p: str): int =
    CALLS.filter(c => st.cs.get(c) == "running" and pools(c).contains(p)).size()
      + (if (p == "gpu" and st.fin == "checkRunning") 1 else 0)
      + (if (p == "gpu" and st.integ == "running") 1 else 0)
  pure def sumReserved(st: S): int = CALLS.fold(st.finRes + st.integRes, (a, c) => a + st.reserved.get(c))
  pure def affordable(st: S, usd: int): bool = st.spent + sumReserved(st) + usd <= TOTAL
  pure def free(st: S, ps: Set[str]): bool = ps.forall(p => st.used.get(p) + 1 <= cap(p))
  pure def take(u: str -> int, ps: Set[str], d: int): str -> int = POOLS.mapBy(p => if (ps.contains(p)) u.get(p) + d else u.get(p))
  pure def anyOpenAsk(st: S): bool = st.revAsk or st.fin == "asking"
  pure def post(st: S): int = if (st.afterDeadline) st.afterWork + 1 else st.afterWork

  // The run ends (met, owner-declined, deadline): running calls are cancelled and charged their
  // reservation, their slots are released, an open revision ask closes `unanswered`. An
  // integration already requested still completes (judgment class).
  pure def closeAll(st: S, why: str): S =
    val live = CALLS.filter(c => st.cs.get(c) == "running")
    val st2 = { ...st, ended: why, revAsk: false,
      cs: CALLS.mapBy(c => if (st.cs.get(c) == "idle") "idle" else "done"),
      res: CALLS.mapBy(c => if (live.contains(c)) "cancelled" else if (st.cs.get(c) == "pending") "cancelled" else st.res.get(c)),
      spent: st.spent + live.fold(0, (a, c) => a + st.reserved.get(c)),
      reserved: CALLS.mapBy(c => 0) }
    { ...st2, used: POOLS.mapBy(p => runningOn(st2, p)) }

  action init = all {
    s' = {
      cs: CALLS.mapBy(c => "idle"), issued: CALLS.mapBy(c => false), res: CALLS.mapBy(c => ""),
      reserved: CALLS.mapBy(c => 0), used: POOLS.mapBy(p => 0), spent: 0,
      afterDeadline: false, ended: "", ver: 0, revAsk: false, revSeen: 0,
      fin: "none", finSha: 0, finVer: 0, finRes: 0, finPostDeadline: 0, passed: Set(),
      integ: "none", integRes: 0, predPending: false, streak: 0,
      runs: CALLS.mapBy(c => 0), replays: 0, restarts: 0, adoptions: 0, deaths: 0,
      workAfterDeadline: false, finProposals: 0, finResolved: 0, integRequested: false,
      weakens: 0, staleRevs: 0, weakenedUnseen: false, refusals: 0, contAfterTwoMisses: false,
      askWhileFull: false, reservationStops: 0, budgetRefusals: 0,
      finStarved: false, finCheckPostDeadline: false, integPostDeadline: false,
      notMets: 0, afterWork: 0,
    }
  }

  // ---------------- calls ----------------
  // The script calls x.agent/x.check with key c. A journaled result is REPLAYED (no start, no
  // spend); a running call is re-attached; otherwise the call waits for slots and budget. After
  // the deadline a new call resolves at once as stopped{deadline}.
  action issue(c: int): bool = all {
    s.ended == "", not(s.issued.get(c)),
    val st = { ...s, issued: s.issued.set(c, true) }
    if (s.cs.get(c) == "done") s' = { ...st, replays: s.replays + 1 }
    else if (s.cs.get(c) == "running") s' = st
    else if (s.afterDeadline) s' = { ...st, cs: s.cs.set(c, "done"), res: s.res.set(c, "deadline") }
    else s' = { ...st, cs: s.cs.set(c, "pending") },
  }

  // All-or-nothing: every pool the call names (agent + alsoHolds) has a slot, and the reservation
  // fits: spent + reserved + usd <= budget.
  action start(c: int): bool = all {
    s.cs.get(c) == "pending", not(s.afterDeadline), free(s, pools(c)), affordable(s, cost(c)),
    s' = { ...s, cs: s.cs.set(c, "running"), reserved: s.reserved.set(c, cost(c)),
           used: take(s.used, pools(c), 1), runs: s.runs.set(c, s.runs.get(c) + 1),
           workAfterDeadline: s.workAfterDeadline or s.afterDeadline,
           askWhileFull: s.askWhileFull or (anyOpenAsk(s) and pools(c).contains("agent")),
           afterWork: post(s) },
  }

  // API GAP: the reservation cannot be made (budget left < usd). The d.ts has no result for this;
  // the model resolves the call as `refused-budget` with no spend, rather than waiting forever.
  action refuseBudget(c: int): bool = all {
    s.cs.get(c) == "pending", not(affordable(s, cost(c))),
    s' = { ...s, cs: s.cs.set(c, "done"), res: s.res.set(c, "refused-budget"),
           budgetRefusals: s.budgetRefusals + 1, afterWork: post(s) },
  }

  // Settle: ok/malformed spend at most the slice; hitting the slice is stopped{reservation}.
  action settle(c: int): bool = all {
    s.cs.get(c) == "running",
    nondet stop = Set(true, false).oneOf()
    nondet actual = 0.to(cost(c) - 1).oneOf()
    s' = { ...s, cs: s.cs.set(c, "done"), res: s.res.set(c, if (stop) "reservation" else "ok"),
           spent: s.spent + (if (stop) cost(c) else actual), reserved: s.reserved.set(c, 0),
           used: take(s.used, pools(c), -1),
           reservationStops: s.reservationStops + (if (stop) 1 else 0), afterWork: post(s) },
  }

  // Backend restart. The script re-runs from the top (issued resets). Each running turn is
  // adopted or found dead (journaled as harness-error, charged its reservation). A pending call
  // has no journal entry and is forgotten. Asks, finish and integration are journaled and survive.
  action restart = all {
    s.ended == "",
    val live = CALLS.filter(c => s.cs.get(c) == "running")
    nondet dead = live.powerset().oneOf()
    s' = { ...s, issued: CALLS.mapBy(c => false),
           cs: CALLS.mapBy(c => if (dead.contains(c)) "done" else if (s.cs.get(c) == "pending") "idle" else s.cs.get(c)),
           res: CALLS.mapBy(c => if (dead.contains(c)) "harness-error" else s.res.get(c)),
           spent: s.spent + dead.fold(0, (a, c) => a + s.reserved.get(c)),
           reserved: CALLS.mapBy(c => if (dead.contains(c)) 0 else s.reserved.get(c)),
           used: POOLS.mapBy(p => s.used.get(p) - dead.filter(c => pools(c).contains(p)).size()),
           restarts: s.restarts + 1, adoptions: s.adoptions + live.exclude(dead).size(),
           deaths: s.deaths + dead.size() },
  }

  // The deadline stops running agent/check work and resolves pending work as stopped{deadline}.
  // Finish checks, asks and integration are untouched.
  action deadline = all {
    s.ended == "", not(s.afterDeadline),
    val live = CALLS.filter(c => s.cs.get(c) == "running")
    val hit = CALLS.filter(c => s.cs.get(c) == "running" or s.cs.get(c) == "pending")
    s' = { ...s, afterDeadline: true,
           cs: CALLS.mapBy(c => if (hit.contains(c)) "done" else s.cs.get(c)),
           res: CALLS.mapBy(c => if (hit.contains(c)) "deadline" else s.res.get(c)),
           spent: s.spent + live.fold(0, (a, c) => a + s.reserved.get(c)),
           reserved: CALLS.mapBy(c => if (live.contains(c)) 0 else s.reserved.get(c)),
           used: POOLS.mapBy(p => s.used.get(p) - live.filter(c => pools(c).contains(p)).size()) },
  }

  // ---------------- objective revision ----------------
  action reviseLeader = all {     // clarify / tighten: applied now
    s.ended == "", not(s.afterDeadline),
    s' = { ...s, ver: s.ver + 1 },
  }
  action reviseOwner = all {      // weaken / redirect: an owner ask on this exact version
    s.ended == "", not(s.afterDeadline), not(s.revAsk),
    s' = { ...s, revAsk: true, revSeen: s.ver },
  }
  // API GAP: the owner said yes but the version moved (a clarify landed meanwhile). revise()
  // returns 'applied' | 'owner-declined' | 'unanswered'; this outcome (`stale`) has no variant.
  action answerRev = all {
    s.ended == "", s.revAsk,
    nondet yes = Set(true, false).oneOf()
    val apply = yes and s.ver == s.revSeen
    s' = { ...s, revAsk: false, ver: if (apply) s.ver + 1 else s.ver,
           weakens: s.weakens + (if (apply) 1 else 0),
           staleRevs: s.staleRevs + (if (yes and not(apply)) 1 else 0),
           weakenedUnseen: s.weakenedUnseen or (apply and s.ver != s.revSeen), afterWork: post(s) },
  }

  // ---------------- reflection ----------------
  // The host grades the previous Decision's predictions (all missed: nondeterministic). A
  // Decision without predictions (revise-objective, finish) leaves nothing to grade and the
  // streak unchanged. With streak >= 2, continue/modify are refused and the leader asked again.
  action reflect = all {
    s.ended == "", not(s.afterDeadline),
    nondet allMissed = Set(true, false).oneOf()
    nondet d = Set("continue", "modify", "restructure", "other").oneOf()
    val st = if (s.predPending) (if (allMissed) s.streak + 1 else 0) else s.streak
    val refused = st >= 2 and (d == "continue" or d == "modify")
    s' = { ...s, streak: st,
           predPending: not(refused) and d != "other",
           refusals: s.refusals + (if (refused) 1 else 0),
           contAfterTwoMisses: s.contAfterTwoMisses or (not(refused) and st >= 2 and (d == "continue" or d == "modify")) },
  }

  // ---------------- finish ----------------
  // HOST RULE (not in the d.ts): after the deadline the script may propose finish once, or a
  // finish loop runs forever after the deadline (see postDeadlineBounded).
  action proposeFinish(h: int): bool = all {
    s.ended == "", s.fin == "none", not(s.afterDeadline) or s.finPostDeadline == 0,
    s' = { ...s, fin: "pendingCheck", finSha: h, finVer: s.ver,
           finPostDeadline: s.finPostDeadline + (if (s.afterDeadline) 1 else 0),
           finProposals: s.finProposals + 1, afterWork: post(s) },
  }
  action finStart = all {
    s.fin == "pendingCheck", free(s, Set("gpu")), affordable(s, JUDGE_USD),
    s' = { ...s, fin: "checkRunning", finRes: JUDGE_USD, used: take(s.used, Set("gpu"), 1),
           finCheckPostDeadline: s.finCheckPostDeadline or s.afterDeadline, afterWork: post(s) },
  }
  // API GAP: nothing reserves the finish's own judgment, so a run that spent its budget cannot
  // judge finished work: finish is not-met with no criterion run.
  action finStarve = all {
    s.fin == "pendingCheck", not(affordable(s, JUDGE_USD)),
    s' = { ...s, fin: "none", finStarved: true, notMets: s.notMets + 1, finResolved: s.finResolved + 1,
           afterWork: post(s) },
  }
  action finSettle = all {
    s.fin == "checkRunning",
    nondet pass = Set(true, false).oneOf()
    s' = { ...s, fin: "asking", finRes: 0, spent: s.spent + JUDGE_USD, used: take(s.used, Set("gpu"), -1),
           passed: if (pass) s.passed.union(Set((1, s.finSha))) else s.passed, afterWork: post(s) },
  }
  // The owner criterion is an ask (no slot). met iff every criterion passed on finSha and the
  // objective is still the version finish was proposed against.
  action finAnswer = all {
    s.fin == "asking",
    nondet ans = Set("yes", "no", "unanswered").oneOf()
    val p2 = if (ans == "yes") s.passed.union(Set((2, s.finSha))) else s.passed
    val met = CRITS.forall(k => p2.contains((k, s.finSha))) and s.ver == s.finVer
    val st = { ...s, fin: "none", passed: p2, finResolved: s.finResolved + 1, afterWork: post(s) }
    if (ans == "no") s' = closeAll(st, "owner-declined")
    else if (met) s' = closeAll(st, "met")
    else s' = { ...st, notMets: s.notMets + 1 },
  }

  // ---------------- integration (serial, survives the deadline) ----------------
  action integRequest = all { s.ended == "", s.integ == "none", s' = { ...s, integ: "pending", integRequested: true, afterWork: post(s) } }
  action integStart = all {
    s.integ == "pending", free(s, Set("gpu")), affordable(s, JUDGE_USD),
    s' = { ...s, integ: "running", integRes: JUDGE_USD, used: take(s.used, Set("gpu"), 1),
           integPostDeadline: s.integPostDeadline or s.afterDeadline, afterWork: post(s) },
  }
  action integStarve = all {
    s.integ == "pending", not(affordable(s, JUDGE_USD)),
    s' = { ...s, integ: "starved", afterWork: post(s) },
  }
  action integSettle = all {
    s.integ == "running",
    s' = { ...s, integ: "done", integRes: 0, spent: s.spent + JUDGE_USD,
           used: take(s.used, Set("gpu"), -1), afterWork: post(s) },
  }

  // After the deadline, once no judgment is in flight, the host ends the run.
  action hostEnd = all {
    s.ended == "", s.afterDeadline, s.fin == "none",
    s.integ != "pending", s.integ != "running",
    s' = closeAll(s, "deadline"),
  }

  action step = any {
    nondet c = CALLS.oneOf()
    any { issue(c), start(c), refuseBudget(c), settle(c) },
    nondet h = SHAS.oneOf()
    proposeFinish(h),
    restart, deadline, reviseLeader, reviseOwner, answerRev, reflect,
    finStart, finStarve, finSettle, finAnswer,
    integRequest, integStart, integStarve, integSettle, hostEnd,
  }

  // ---------------- invariants ----------------
  val poolCaps = POOLS.forall(p => s.used.get(p) <= cap(p))
  // Asks hold no slot: the host's slot counters equal what is actually running on each pool.
  val asksHoldNoSlot = POOLS.forall(p => s.used.get(p) == runningOn(s, p))
  // Every start reserved first, so spent + reserved never passes the budget.
  val budgetHard = s.spent + sumReserved(s) <= TOTAL and s.spent >= 0
  // Replay: a call starts at most once across restarts (so it also spends at most once).
  val noDoubleRun = CALLS.forall(c => s.runs.get(c) <= 1)
  val noWorkAfterDeadline = not(s.workAfterDeadline)
  // Judgment is never dropped (by the deadline or the run ending): every finish proposal resolves
  // with a typed result or is still in flight, and a requested integration is never forgotten.
  val judgmentSurvivesDeadline = s.finProposals == s.finResolved + (if (s.fin != "none") 1 else 0)
    and (s.integRequested implies s.integ != "none")
  val weakenOnSeenVersion = not(s.weakenedUnseen) and s.weakens <= s.ver
  val metHonest = (s.ended == "met") implies (CRITS.forall(k => s.passed.contains((k, s.finSha))) and s.ver == s.finVer)
  val noContinueAfterTwoMisses = not(s.contAfterTwoMisses)
  val endedQuiet = (s.ended != "") implies
    (CALLS.forall(c => s.cs.get(c) != "running" and s.cs.get(c) != "pending") and not(s.revAsk) and s.fin == "none")
  // Termination after the deadline: a bounded number of host steps (restarts and replays aside).
  val postDeadlineBounded = s.afterWork <= POST_K

  val safety = poolCaps and asksHoldNoSlot and budgetHard and noDoubleRun and noWorkAfterDeadline
    and judgmentSurvivesDeadline and weakenOnSeenVersion and metHonest and noContinueAfterTwoMisses
    and endedQuiet and postDeadlineBounded

  // ---------------- non-vacuity witnesses (quint --witnesses: each must hold in some trace) ----------------
  val wMet = s.ended == "met"
  val wDeclined = s.ended == "owner-declined"
  val wDeadlineEnd = s.ended == "deadline"
  val wNotMet = s.notMets > 0
  val wReplay = s.replays > 0
  val wAdopted = s.adoptions > 0
  val wDied = s.deaths > 0
  val wMultiPool = s.runs.get(2) > 0
  val wReservationStop = s.reservationStops > 0
  val wBudgetRefusal = s.budgetRefusals > 0
  val wAskWhileAgentStarts = s.askWhileFull
  val wWeakened = s.weakens > 0
  val wStale = s.staleRevs > 0
  val wRefused = s.refusals > 0
  val wFinCheckPostDeadline = s.finCheckPostDeadline
  val wIntegPostDeadline = s.integPostDeadline
  val wFinStarved = s.finStarved
  val wStoppedByDeadline = CALLS.exists(c => s.res.get(c) == "deadline")
  val wMetAfterDeadline = s.ended == "met" and s.afterDeadline
}

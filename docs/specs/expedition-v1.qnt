// Expeditions V1 (revision 2, 2026-11-09): the leader loop, rounds with host-graded outer
// reflection, node lifecycle, budget ledger with reservations and carving, patch-vs-start CAS,
// gates with carry and parking, objective revisions with owner-signed v0 and id+base CAS,
// owner interrupts, restart adoption, termination and the closing report.
// Design: docs/expeditions/v1-leader-rounds.md (§9 has every command and result).
//
// Scope: the structural core only. LLM judgment (what the leader plans, whether a check passes,
// whether a round met its prediction, how much a node really spends) is a nondeterministic
// choice. Bounded: 6 node slots, 3 rounds, money 14 (+4 per extend), 2 scarce evaluations,
// work deadline 12 ticks, park allowance 4 ticks, round wall cap 4 ticks.
//
// Run (no JVM, so random simulation, not Apalache):
//   quint typecheck docs/specs/expedition-v1.qnt
//   quint run docs/specs/expedition-v1.qnt --invariant=<name> --max-samples=3000 --max-steps=80
// Safety invariants are listed in `safety`; `w_*` are non-vacuity witnesses and MUST be violated;
// each `step<Ablation>` removes one guard and MUST violate the invariant named at it.
// `quint run` has no temporal properties: liveness is written as bounded-response safety
// (roundBounded, hardStop, noDeadGate, gateFree). Real liveness needs `quint verify` (JVM).
module expedition {
  // ---------------------------------------------------------------- types
  type Status = Free | Pending | Waiting | Running | Done | Failed | Cancelled
  // Work = any LLM node (agent, list-fan child, population child). Check = host-run evaluation
  // (planned, or carved by an agent's run_eval). Gate = owner question. Fan = typed fan-out:
  // over a list-typed input (arch = false) or a host-refilled population over an archive (arch).
  type Kind = Work | Check | Gate | Fan
  type Cls = Cpu | Gpu
  // `by` of a finish. There is no Leader value: the leader cannot finish, by type.
  type Who = Owner | Host | Nobody
  type Reason = NotYet | Met | Deadline | Budget | Stopped
  type Verdict = NoVerdict | Accepted | Rejected
  type Phase = Live | Paused | Parked | Finished
  type LeaderSt = Asleep | Awake
  type Mode = OnMet | ToDeadline
  // Outer reflection. Rewrite / Finish / Ask are structural; Continue / Revise are not.
  type Dec = Continue | Revise | Rewrite | ProposeFin | Ask

  type Node = {
    st: Status, round: int, kind: Kind, cls: Cls,
    est: int,         // money reserved at start: the node's hard cap (a population: its budget)
    ev: int,          // scarce evaluations reserved at start (1 for a Check)
    rev: int,         // spec revision; a patch bumps it
    startedRev: int,  // the revision that started (-1 never started)
    starts: int,      // how many times the node was started (adoption keeps it at 1)
    pass: bool,       // Check outcome
    objV: int,        // objective version the node was planned under (a Check checks it)
    crit: int,        // Check: the criterion it tests (1 or 2)
    sha: int,         // Check: the candidate sha it ran on (1 or 2)
    src: int,         // input ref (-1 none). Fan: the list it fans out over. Others: dependency
    parent: int,      // carved child -> its parent (-1 none)
    outList: bool,    // declared output schema is a list
    arch: bool,       // Fan: population over an archive, refilled by the host
    carried: bool,    // belongs to no open round (gate-dependent, or left over when a round closed)
    gate: int         // Gate kind: which gate id it asks
  }
  type Obj = { crit: Set[int], byOwner: bool, against: int, seen: Set[int] }
  type Pend = { active: bool, base: int, id: int, crit: Set[int] }
  type Seen = { valid: bool, base: int, id: int, crit: Set[int] }
  type Spec = { kind: Kind, cls: Cls, est: int, outList: bool, src: int, gate: int }

  type S = {
    nodes: int -> Node,
    curRound: int, roundOpen: bool, roundAt: int, roundExt: int,
    phase: Phase, reason: Reason, by: Who, verdict: Verdict, mode: Mode,
    mBudget: int, mSpent: int, mRes: int,
    eBudget: int, eSpent: int, eRes: int,
    time: int, work: int, deadline: int,
    leader: LeaderSt, inbox: int,
    plans: List[Set[int]],          // meta-plan versions; each carries the gates it keeps
    answered: Set[int],             // gates the owner has answered
    objs: List[Obj],                // effective objective versions, appended only; [0] owner-signed
    pend: Pend, nextId: int,        // one weaken/redirect in flight, with its id
    seen: Seen,                     // what the owner's screen shows of the pending revision
    grades: List[bool],             // per closed round: prediction met (graded by host/judge, never the leader)
    decs: List[Dec],                // per closed round: the leader's reflection
    streak: int,                    // consecutive missed rounds since the last structural change
    wantPark: bool,
    proposed: bool, propV: int,     // leader's finish proposal and the objective version it names
    metSha: int, metV: int,         // what a Met finish was certified against
    reported: bool,                 // closing report written
    patchProps: Set[(int, int)],    // leader patches in flight: (node, rev the leader read)
    everDone: Set[int],             // ghost: nodes that ever reached Done
    extends: int,
    // witness counters (ghosts)
    staleRejects: int, gateDropRejects: int, mistypedRejects: int, staleRatifies: int,
    idRefusals: int, revBlocked: int, staleAccepts: int, forcedChanges: int, g10Refusals: int,
    restartsWithRunning: int, deadAdopted: int, checksAfterFinish: int, applied: int,
    mapChildren: int, popChildren: int, runEvals: int, rewrites: int, ratified: int,
    orphansCancelled: int, extended: int, carriedDone: int, parks: int, capCloses: int,
    gateShortcuts: int
  }

  // ---------------------------------------------------------------- constants
  pure val NODES = 0.to(5)
  pure val MAXROUNDS = 3
  pure val W = 2              // reservation for one leader wake
  pure val CLOSE = 2          // money set aside for the closing report; never reservable by work
  pure val MAXLIVE = 3        // live Work/Check nodes (gates and populations never count)
  pure val CPU_CAP = 2
  pure val GPU_CAP = 1        // e.g. the one local GPU runner
  pure val CHARTER_GATES = Set(1)
  pure val ALL_GATES = Set(1, 2)
  pure val ADHOC = 2          // the gate id an `ask` reflection raises
  pure val OWNER_CRIT = 3     // criteria 1,2 are checks; 3 needs the owner
  pure val ALL_CRIT = Set(1, 2, 3)
  pure val SHAS = Set(1, 2)
  pure val MAXTIME = 26
  pure val PARKMAX = 4        // wall ticks the expedition may sit parked in total (hard stop)
  pure val ROUNDMAX = 4       // round wall cap (work ticks); then unfinished members are carried
  pure val MAXEXT = 2         // extend_round acts per round

  pure val FREE: Node = {
    st: Free, round: 0, kind: Work, cls: Cpu, est: 0, ev: 0, rev: 0, startedRev: -1,
    starts: 0, pass: false, objV: 0, crit: 1, sha: 1, src: -1, parent: -1, outList: false,
    arch: false, carried: false, gate: 0
  }

  pure val SPECS: Set[Spec] =
    Set(Work, Check, Gate, Fan).map(k =>
      Set(Cpu, Gpu).map(c =>
        1.to(3).map(e =>
          Set(true, false).map(l =>
            (-1).to(5).map(r =>
              Set(1, 2).map(g => { kind: k, cls: c, est: e, outList: l, src: r, gate: g })
            ).flatten()
          ).flatten()
        ).flatten()
      ).flatten()
    ).flatten()

  var s: S

  // ---------------------------------------------------------------- helpers
  def nd(n: int): Node = s.nodes.get(n)
  def isTerminal(st: Status): bool = st == Done or st == Failed or st == Cancelled
  def usesCapacity(k: Kind): bool = k == Work or k == Check
  def live(n: int): bool = nd(n).st == Running and usesCapacity(nd(n).kind)
  def runningIn(c: Cls): int = NODES.filter(n => live(n) and nd(n).cls == c).size()
  def liveCount: int = NODES.filter(n => live(n)).size()
  def anyRunning: bool = NODES.exists(n => nd(n).st == Running)
  def moneyFree: int = s.mBudget - CLOSE - s.mSpent - s.mRes
  def evFree: int = s.eBudget - s.eSpent - s.eRes
  def effV: int = s.objs.length() - 1
  def eff: Obj = s.objs[effV]
  def freeSlots: Set[int] = NODES.filter(n => nd(n).st == Free)
  def capOf(c: Cls): int = if (c == Gpu) GPU_CAP else CPU_CAP
  def structural(d: Dec): bool = d == Rewrite or d == ProposeFin or d == Ask
  // A member of the open round: planned in it and not carried out of it.
  def member(n: int): bool = nd(n).round == s.curRound and not(nd(n).carried) and nd(n).st != Free

  // A dependency is satisfied when the input is Done, and, for a fan, all its children ended.
  def depOk(n: int): bool =
    val r = nd(n).src
    r == -1 or (nd(r).st == Done and (nd(r).kind != Fan or
      NODES.forall(c => nd(c).parent != r or isTerminal(nd(c).st))))

  // The certificate for a host Met: one sha on which every check criterion of version v passed,
  // each by a Check node planned under v and testing that criterion.
  def certified(v: int, sha: int): bool =
    not(s.objs[v].crit.contains(OWNER_CRIT)) and
    s.objs[v].crit.forall(c => NODES.exists(n =>
      nd(n).kind == Check and nd(n).st == Done and nd(n).pass and nd(n).crit == c and
      nd(n).sha == sha and nd(n).objV == v))

  // Plan-time carry: a node whose input is a gate (or something carried) belongs to no round.
  // Fix for review 2026-11-09 (r_roundNotHeldByGate, seed 0x6873ae08db175bf): a pending
  // dependent of a waiting gate held the round open, which blocked plan_round on owner latency.
  def carryIn(draft: int -> Node, n: int): bool =
    val r = draft.get(n).src
    r != -1 and (draft.get(r).kind == Gate or draft.get(r).carried)
  def withCarry(draft: int -> Node, ids: Set[int]): int -> Node =
    val p1 = NODES.mapBy(n => if (ids.contains(n)) { ...draft.get(n), carried: carryIn(draft, n) } else draft.get(n))
    NODES.mapBy(n => if (ids.contains(n)) { ...p1.get(n), carried: carryIn(p1, n) } else p1.get(n))

  // Cancel settles at the journaled usage `a` (at most the cap); unknown usage is the full cap.
  def cancelNode(n: int, a: int): S =
    val x = nd(n)
    val used = if (a > x.est) x.est else a
    if (x.st == Running)
      { ...s, nodes: s.nodes.set(n, { ...x, st: Cancelled }),
        mSpent: s.mSpent + used, mRes: s.mRes - x.est,
        eSpent: s.eSpent + x.ev, eRes: s.eRes - x.ev }
    else { ...s, nodes: s.nodes.set(n, { ...x, st: Cancelled }) }

  def stopWork(n: int): bool =
    (nd(n).st == Pending) or (nd(n).st == Running and nd(n).kind != Check)

  // Finish: work stops (pending/running work cancelled, charged its cap as unknown usage),
  // judgment continues (running Checks complete, waiting gates may be answered, the verdict
  // and the closing report land later).
  def finishWith(r: Reason, who: Who, v: Verdict, sha: int, mv: int): S =
    val charge = NODES.filter(n => nd(n).st == Running and nd(n).kind != Check)
                      .fold(0, (acc, n) => acc + nd(n).est)
    val evCharge = NODES.filter(n => nd(n).st == Running and nd(n).kind != Check)
                        .fold(0, (acc, n) => acc + nd(n).ev)
    val wake = if (s.leader == Awake) W else 0
    { ...s,
      nodes: NODES.mapBy(n => if (stopWork(n)) { ...nd(n), st: Cancelled } else nd(n)),
      mSpent: s.mSpent + charge + wake, mRes: s.mRes - charge - wake,
      eSpent: s.eSpent + evCharge, eRes: s.eRes - evCharge,
      leader: Asleep, roundOpen: false, patchProps: Set(), wantPark: false,
      phase: Finished, reason: r, by: who, verdict: v, metSha: sha, metV: mv }

  // A round closes with a grade the host (check-typed predictions) or a judge seat (judged
  // predictions) computed. Its unfinished members are carried, never cancelled.
  def closeState(met: bool): S =
    { ...s, roundOpen: false,
      nodes: NODES.mapBy(n => if (member(n) and not(isTerminal(nd(n).st))) { ...nd(n), carried: true } else nd(n)),
      grades: s.grades.append(met),
      streak: if (met) 0 else s.streak + 1,
      inbox: s.inbox + 1 }

  // end_round: pending and running members are cancelled (unknown usage: full cap).
  def endRoundState(met: bool): S =
    val gone = NODES.filter(n => member(n) and (nd(n).st == Pending or nd(n).st == Running))
    val charge = gone.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).est)
    val evc = gone.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).ev)
    { ...s, nodes: NODES.mapBy(n => if (gone.contains(n)) { ...nd(n), st: Cancelled } else nd(n)),
      mSpent: s.mSpent + charge, mRes: s.mRes - charge,
      eSpent: s.eSpent + evc, eRes: s.eRes - evc, roundOpen: false,
      grades: s.grades.append(met), streak: if (met) 0 else s.streak + 1, inbox: s.inbox + 1 }

  // ---------------------------------------------------------------- init
  // v0 of the objective is part of the owner-signed charter (basis: charter), so its criteria
  // carry owner authority; the leader never writes v0.
  action init = all {
    nondet v0 = Set(Set(1), Set(1, 2), Set(1, 3)).oneOf()
    nondet m = Set(OnMet, ToDeadline).oneOf()
    s' = {
      nodes: NODES.mapBy(_ => FREE),
      curRound: 0, roundOpen: false, roundAt: 0, roundExt: 0,
      phase: Live, reason: NotYet, by: Nobody, verdict: NoVerdict, mode: m,
      mBudget: 14, mSpent: 0, mRes: 0,
      eBudget: 2, eSpent: 0, eRes: 0,
      time: 0, work: 0, deadline: 12,
      leader: Asleep, inbox: 1,               // the launch event wakes the leader
      plans: [CHARTER_GATES],
      answered: Set(),
      objs: [{ crit: v0, byOwner: true, against: -1, seen: v0 }],
      pend: { active: false, base: 0, id: 0, crit: Set() }, nextId: 1,
      seen: { valid: false, base: 0, id: 0, crit: Set() },
      grades: [], decs: [], streak: 0, wantPark: false,
      proposed: false, propV: 0, metSha: 0, metV: -1, reported: false,
      patchProps: Set(), everDone: Set(), extends: 0,
      staleRejects: 0, gateDropRejects: 0, mistypedRejects: 0, staleRatifies: 0,
      idRefusals: 0, revBlocked: 0, staleAccepts: 0, forcedChanges: 0, g10Refusals: 0,
      restartsWithRunning: 0, deadAdopted: 0, checksAfterFinish: 0, applied: 0,
      mapChildren: 0, popChildren: 0, runEvals: 0, rewrites: 0, ratified: 0,
      orphansCancelled: 0, extended: 0, carriedDone: 0, parks: 0, capCloses: 0,
      gateShortcuts: 0
    }
  }

  // ---------------------------------------------------------------- leader (only while awake)
  // While paused the leader may still be finishing a turn it started while live (pause does not
  // kill a turn); every act it attempts is refused because leaderMay needs Live. It never wakes
  // while paused, parked or finished.
  def leaderMay: bool = s.leader == Awake and s.phase == Live

  // Events are batched in the inbox; one wake consumes them all and reserves its own cost.
  action wake = all {
    s.leader == Asleep, s.phase == Live, s.inbox > 0, moneyFree >= W,
    s' = { ...s, leader: Awake, mRes: s.mRes + W, inbox: 0 }
  }

  action sleep = all {
    s.leader == Awake,
    nondet actual = 1.to(W).oneOf()
    s' = { ...s, leader: Asleep, mSpent: s.mSpent + actual, mRes: s.mRes - W }
  }

  def mk(sp: Spec, r: int, c: int, h: int, ar: bool): Node = { ...FREE, st: Pending, round: r,
    kind: sp.kind, cls: sp.cls,
    est: if (sp.kind == Gate or (sp.kind == Fan and not(ar))) 0 else sp.est,
    ev: if (sp.kind == Check) 1 else 0,
    objV: effV, crit: c, sha: h, src: sp.src, outList: sp.outList,
    arch: sp.kind == Fan and ar, gate: sp.gate }

  def graphOk(draft: int -> Node, ids: Set[int]): bool =
    ids.forall(n => draft.get(n).src == -1 or
      (draft.get(n).src != n and draft.get(draft.get(n).src).st != Free and
       // no 2-cycles inside one act
       not(ids.contains(draft.get(n).src) and draft.get(draft.get(n).src).src == n)))
  // I5: a list fan's input must be a list-typed node. A population names an archive, not a ref.
  def typedOk(draft: int -> Node, ids: Set[int]): bool =
    ids.forall(n => draft.get(n).kind != Fan or draft.get(n).arch or
      (draft.get(n).src != -1 and draft.get(n).src != n and draft.get(draft.get(n).src).st != Free
        and draft.get(draft.get(n).src).outList))

  // plan_round: one atomic act with up to two nodes. Requires no open round and EVERY closed
  // round reflected (outer reflection is mandatory, G3).
  action planRound = all {
    leaderMay, not(s.roundOpen), s.curRound < MAXROUNDS, freeSlots.size() >= 2,
    s.decs.length() == s.grades.length(),
    nondet i = freeSlots.oneOf()
    nondet j = freeSlots.exclude(Set(i)).oneOf()
    nondet a = SPECS.oneOf()
    nondet b = SPECS.oneOf()
    nondet two = Set(true, false).oneOf()
    nondet ca = Set(1, 2).oneOf()
    nondet cb = Set(1, 2).oneOf()
    nondet ha = SHAS.oneOf()
    nondet hb = SHAS.oneOf()
    nondet aa = Set(true, false).oneOf()
    nondet ab = Set(true, false).oneOf()
    // Half the time the second node is a check of the first (an agent and its check: the common
    // shape). Check is already in SPECS, so this changes probabilities, not reachable states.
    nondet bk = Set(true, false).oneOf()
    val r = s.curRound + 1
    val b2 = if (bk) { ...b, kind: Check, src: i } else b
    val raw = if (two) s.nodes.set(i, mk(a, r, ca, ha, aa)).set(j, mk(b2, r, cb, hb, ab))
              else s.nodes.set(i, mk(a, r, ca, ha, aa))
    val ids = if (two) Set(i, j) else Set(i)
    val draft = withCarry(raw, ids)
    val mistyped = ids.exists(n => draft.get(n).kind == Fan) and not(typedOk(draft, ids))
    if (graphOk(draft, ids) and typedOk(draft, ids))
      s' = { ...s, nodes: draft, curRound: r, roundOpen: true, roundAt: s.work, roundExt: 0,
             wantPark: false }
    else
      s' = { ...s, mistypedRejects: s.mistypedRejects + (if (mistyped) 1 else 0) }
  }

  // extend_round: a running round grows by one pending node under the same graph checks, at most
  // MAXEXT times per round (charter `extendsPerRound`): a leader cannot dodge reflection forever.
  action extendRound = all {
    leaderMay, s.roundOpen, s.roundExt < MAXEXT, freeSlots.size() >= 1,
    nondet i = freeSlots.oneOf()
    nondet a = SPECS.oneOf()
    nondet c = Set(1, 2).oneOf()
    nondet h = SHAS.oneOf()
    nondet ar = Set(true, false).oneOf()
    val draft = withCarry(s.nodes.set(i, mk(a, s.curRound, c, h, ar)), Set(i))
    if (graphOk(draft, Set(i)) and typedOk(draft, Set(i)))
      s' = { ...s, nodes: draft, extended: s.extended + 1, roundExt: s.roundExt + 1 }
    else
      s' = { ...s, mistypedRejects: s.mistypedRejects + (if (a.kind == Fan) 1 else 0) }
  }

  // reflect: after a round closes, the leader records ONE decision. It never writes the grade
  // (the host/judge did, at close). Two consecutive missed rounds since the last structural
  // change refuse Continue and Revise (G10): only Rewrite, ProposeFin or Ask remain.
  action reflect = all {
    leaderMay, not(s.roundOpen), s.decs.length() < s.grades.length(),
    nondet d = Set(Continue, Revise, Rewrite, ProposeFin, Ask).oneOf()
    nondet g = ALL_GATES.powerset().oneOf()
    nondet slot = NODES.oneOf()
    if (s.streak >= 2 and not(structural(d)))
      s' = { ...s, g10Refusals: s.g10Refusals + 1 }
    else if (d == Rewrite)
      all { CHARTER_GATES.subseteq(g),
            s' = { ...s, plans: s.plans.append(g), rewrites: s.rewrites + 1, decs: s.decs.append(d),
                   streak: 0, forcedChanges: s.forcedChanges + (if (s.streak >= 2) 1 else 0) } }
    else if (d == ProposeFin)
      s' = { ...s, proposed: true, propV: effV, decs: s.decs.append(d), streak: 0,
             forcedChanges: s.forcedChanges + (if (s.streak >= 2) 1 else 0) }
    else if (d == Ask)
      // ask: an ad-hoc gate node is raised and the expedition asks to park until it is answered
      all { nd(slot).st == Free, not(s.answered.contains(ADHOC)),
            s' = { ...s, nodes: s.nodes.set(slot, { ...FREE, st: Waiting, round: s.curRound, kind: Gate,
                                                     gate: ADHOC, carried: true, objV: effV }),
                   wantPark: true, decs: s.decs.append(d), streak: 0,
                   forcedChanges: s.forcedChanges + (if (s.streak >= 2) 1 else 0) } }
    else
      s' = { ...s, decs: s.decs.append(d) }
  }

  // patch, step 1: the leader reads a pending node's revision and decides (an LLM turn: slow).
  action proposePatch = all {
    leaderMay,
    nondet n = NODES.oneOf()
    all { nd(n).st == Pending, s' = { ...s, patchProps: s.patchProps.union(Set((n, nd(n).rev))) } }
  }

  // patch, step 2: the host commits it with compare-and-swap on status AND revision (I4).
  action commitPatch = all {
    s.patchProps.size() > 0,
    nondet p = s.patchProps.oneOf()
    nondet newEst = 1.to(3).oneOf()
    val n = p._1
    val rest = s.patchProps.exclude(Set(p))
    if (nd(n).st == Pending and nd(n).rev == p._2)
      s' = { ...s, patchProps: rest, applied: s.applied + 1,
             nodes: s.nodes.set(n, { ...nd(n), rev: nd(n).rev + 1,
               est: if (nd(n).kind == Work or nd(n).kind == Check) newEst else nd(n).est }) }
    else
      s' = { ...s, patchProps: rest, staleRejects: s.staleRejects + 1 }
  }

  action leaderCancel = all {
    leaderMay,
    nondet n = NODES.oneOf()
    nondet a = 0.to(3).oneOf()
    all { nd(n).st == Pending or nd(n).st == Running or nd(n).st == Waiting, s' = cancelNode(n, a) }
  }

  action leaderEndRound = all {
    leaderMay, s.roundOpen,
    nondet met = Set(true, false).oneOf()
    s' = endRoundState(met)
  }

  // rewrite_meta outside reflection: the host refuses a plan that drops a charter gate (I6).
  // It does NOT count as G10's structural change (only a reflection's Rewrite does).
  action rewriteMeta = all {
    leaderMay,
    nondet g = ALL_GATES.powerset().oneOf()
    if (CHARTER_GATES.subseteq(g))
      s' = { ...s, plans: s.plans.append(g), rewrites: s.rewrites + 1 }
    else
      s' = { ...s, gateDropRejects: s.gateDropRejects + 1 }
  }

  // revise_objective: the HOST classifies by diff. A superset applies now (even while a
  // weakening is pending: that makes the pending base stale, and ratify's base CAS refuses it).
  // Anything else becomes THE pending revision with a fresh id, and is refused while one is
  // pending: one non-additive revision in flight, never overwritten.
  // Fix for review 2026-11-09 (r_pendNotSwapped, seed 0x3ae2a100eef4e362).
  action reviseObjective = all {
    leaderMay,
    nondet c = ALL_CRIT.powerset().exclude(Set(Set())).oneOf()
    if (eff.crit.subseteq(c))
      s' = { ...s, objs: s.objs.append({ crit: c, byOwner: false, against: effV, seen: Set() }) }
    else if (s.pend.active)
      s' = { ...s, revBlocked: s.revBlocked + 1 }
    else
      s' = { ...s, pend: { active: true, base: effV, id: s.nextId, crit: c }, nextId: s.nextId + 1 }
  }

  action proposeFinish = all {
    leaderMay, not(s.proposed) or s.propV != effV,
    s' = { ...s, proposed: true, propV: effV }
  }

  // ---------------------------------------------------------------- host
  action startNode = all {
    s.phase == Live,
    nondet n = NODES.oneOf()
    // Hoisted on purpose: a `nondet` written inside the Fan branch of the if/else below
    // silently disabled that branch in `quint run` (0 fan-outs in 3000 traces), so the
    // fan-out witness was vacuous. Keep every nondet at the top of the action.
    nondet kids = freeSlots.powerset().filter(k => k.size() <= 2).oneOf()
    val x = nd(n)
    all {
      x.st == Pending, depOk(n), x.carried or (s.roundOpen and x.round == s.curRound),
      if (x.kind == Gate)
        // Asking the owner holds no slot and no budget. A gate answered BEFORE its node started
        // is Done at once. Fix for review 2026-11-09 (r_noDeadGate, seed 0x714b86d90102cba8):
        // the node used to enter Waiting and could never be answered again.
        if (s.answered.contains(x.gate))
          s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Done, startedRev: x.rev, starts: x.starts + 1 }),
                 everDone: s.everDone.union(Set(n)), gateShortcuts: s.gateShortcuts + 1 }
        else
          s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Waiting, startedRev: x.rev, starts: x.starts + 1 }) }
      else if (x.kind == Fan and not(x.arch))
        // typed fan-out: width comes from the runtime list; each child is its own node
        val withKids = NODES.mapBy(c =>
          if (kids.contains(c))
            { ...FREE, st: Pending, round: x.round, kind: Work, cls: Cpu, est: 1,
              objV: x.objV, parent: n, carried: x.carried }
          else if (c == n) { ...x, st: Done, startedRev: x.rev, starts: x.starts + 1 }
          else nd(c))
        s' = { ...s, nodes: withKids, everDone: s.everDone.union(Set(n)),
               mapChildren: s.mapChildren + kids.size() }
      else if (x.kind == Fan)
        // a population reserves its whole budget; it holds no slot (its children do)
        all { x.est <= moneyFree,
              s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev, starts: x.starts + 1 }),
                     mRes: s.mRes + x.est } }
      else all {
        // reservation at start (I3): money, scarce evaluations, class cap, live cap
        x.est <= moneyFree, x.ev <= evFree,
        runningIn(x.cls) < capOf(x.cls), liveCount < MAXLIVE,
        s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev,
                                              starts: x.starts + 1 }),
               mRes: s.mRes + x.est, eRes: s.eRes + x.ev }
      }
    }
  }

  // carve: a running node funds a child from its OWN reservation, so the ledger total is
  // unchanged and every dollar stays metered. Two uses:
  //  - run_eval: an agent (Work) asks the host to run a charter evaluator; the child is a Check
  //    that also reserves a scarce eval and a pool slot. Paid/GPU compute never runs in the
  //    agent's own shell (charter Limit `no-paid-compute`, enforced by env + sandbox).
  //  - population refill: the host starts the next generator child of a population (arch Fan)
  //    from its archive without waking the leader.
  action carve = all {
    s.phase == Live,
    nondet p = NODES.oneOf()
    nondet c = NODES.oneOf()
    nondet cls = Set(Cpu, Gpu).oneOf()
    nondet cr = Set(1, 2).oneOf()
    nondet h = SHAS.oneOf()
    val x = nd(p)
    val evalChild = x.kind == Work
    all {
      x.st == Running, (x.kind == Work and x.est >= 2) or (x.kind == Fan and x.arch and x.est >= 1),
      nd(c).st == Free,
      runningIn(cls) < capOf(cls), liveCount < MAXLIVE,
      if (evalChild) evFree >= 1 else true,
      s' = { ...s,
        nodes: s.nodes.set(p, { ...x, est: x.est - 1 })
                      .set(c, { ...FREE, st: Running, round: x.round, carried: x.carried,
                                kind: if (evalChild) Check else Work, cls: cls, est: 1,
                                ev: if (evalChild) 1 else 0, startedRev: 0, starts: 1,
                                objV: x.objV, crit: cr, sha: h, parent: p }),
        eRes: s.eRes + (if (evalChild) 1 else 0),
        runEvals: s.runEvals + (if (evalChild) 1 else 0),
        popChildren: s.popChildren + (if (evalChild) 0 else 1) }
    }
  }

  // A population ends (budget used, or plateau) once no child runs: the unspent rest returns.
  action popDone = all {
    nondet p = NODES.oneOf()
    val x = nd(p)
    all {
      x.st == Running, x.kind == Fan, x.arch,
      NODES.forall(c => nd(c).parent != p or isTerminal(nd(c).st)),
      s' = { ...s, nodes: s.nodes.set(p, { ...x, st: Done }), everDone: s.everDone.union(Set(p)),
             mRes: s.mRes - x.est, inbox: s.inbox + 1 }      // `plateau` wakes the leader
    }
  }

  // A node ends. Spend is at most the reservation: the host kills a node at its cap.
  // An agent ends only after its run_eval children ended.
  action complete = all {
    nondet n = NODES.oneOf()
    nondet actual = 1.to(3).oneOf()
    nondet ok = Set(true, false).oneOf()
    val x = nd(n)
    all {
      x.st == Running, usesCapacity(x.kind), actual <= x.est,
      NODES.forall(c => nd(c).parent != n or isTerminal(nd(c).st)),
      s' = { ...s,
        nodes: s.nodes.set(n, { ...x, st: Done, pass: ok }),
        everDone: s.everDone.union(Set(n)),
        mSpent: s.mSpent + actual, mRes: s.mRes - x.est,
        eSpent: s.eSpent + x.ev, eRes: s.eRes - x.ev,
        carriedDone: s.carriedDone + (if (x.carried) 1 else 0),
        inbox: s.inbox + (if (x.carried and s.phase == Live) 1 else 0),
        checksAfterFinish: s.checksAfterFinish + (if (s.phase == Finished) 1 else 0) }
    }
  }

  action failNode = all {
    nondet n = NODES.oneOf()
    nondet actual = 1.to(3).oneOf()
    val x = nd(n)
    all {
      x.st == Running, usesCapacity(x.kind), actual <= x.est,
      s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Failed }),
        mSpent: s.mSpent + actual, mRes: s.mRes - x.est,
        eSpent: s.eSpent + x.ev, eRes: s.eRes - x.ev,
        inbox: s.inbox + 1 }                        // nodeFailed wakes the leader
    }
  }

  // A pending node whose input failed or was cancelled can never start: the host cancels it.
  action cancelOrphan = all {
    nondet n = NODES.oneOf()
    val x = nd(n)
    all {
      x.st == Pending, x.src != -1,
      nd(x.src).st == Failed or nd(x.src).st == Cancelled,
      s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Cancelled }), orphansCancelled: s.orphansCancelled + 1,
             inbox: s.inbox + 1 }
    }
  }

  // roundDone: every member ended or is a waiting gate (carried nodes are not members). The
  // grade (prediction met or missed) is computed here by host/judge, never by the leader.
  action closeRound = all {
    s.roundOpen,
    NODES.forall(n => not(member(n)) or isTerminal(nd(n).st) or nd(n).st == Waiting),
    nondet met = Set(true, false).oneOf()
    s' = closeState(met)
  }

  // The clock. `work` stops while parked; the deadline is on `work`, and a hard stop on wall
  // time bounds parking (q5). The round wall cap closes a round and carries its stragglers.
  action tick = all {
    s.time < MAXTIME,
    nondet met = Set(true, false).oneOf()
    val t2 = s.time + 1
    val w2 = if (s.phase == Parked or s.phase == Finished) s.work else s.work + 1
    if (s.phase != Finished and (w2 >= s.deadline or t2 >= s.deadline + PARKMAX))
      s' = { ...finishWith(Deadline, Host, NoVerdict, 0, -1), time: t2, work: w2 }
    else if (s.phase != Finished and s.roundOpen and w2 - s.roundAt >= ROUNDMAX)
      s' = { ...closeState(met), time: t2, work: w2, capCloses: s.capCloses + 1 }
    else
      // a tick wakes the leader only while capacity work runs (§3.5)
      s' = { ...s, time: t2, work: w2,
             inbox: s.inbox + (if (s.phase == Live and liveCount > 0) 1 else 0) }
  }

  // Host finish against the objective (charter finish = on_met only): one candidate sha on which
  // every check criterion of the CURRENT version passed, and every charter gate answered.
  // Fix for review 2026-11-09 (r_hostMetOnePassMulti, seed 0x504acf67ff16e9e6): one passing
  // check used to finish a multi-criterion objective.
  action hostFinishMet = {
    // nondet hoisted above the guards: written after them inside `all`, this act never fired
    // in 20,000 traces although its guard state was reachable (w_noHostMet stayed vacuous).
    nondet h = SHAS.oneOf()
    all {
      s.phase == Live, s.mode == OnMet, CHARTER_GATES.subseteq(s.answered), certified(effV, h),
      s' = finishWith(Met, Host, Accepted, h, effV)
    }
  }

  action exhaust = all {
    s.phase == Live, s.leader == Asleep, not(anyRunning), moneyFree < W,
    s' = finishWith(Budget, Host, NoVerdict, 0, -1)
  }

  // park: the leader's last reflection asked the owner, and nothing else can move. The work
  // clock stops; the hard stop still bounds it.
  action park = all {
    s.phase == Live, s.wantPark, not(s.roundOpen), s.leader == Asleep, not(anyRunning),
    NODES.exists(n => nd(n).st == Waiting),
    s' = { ...s, phase: Parked, parks: s.parks + 1 }
  }

  // The closing report: one bounded host-started turn after finish, paid from closeReserve.
  action closeReport = all {
    s.phase == Finished, not(s.reported),
    nondet a = 1.to(CLOSE).oneOf()
    s' = { ...s, reported: true, mSpent: s.mSpent + a }
  }

  // Backend restart: running nodes are ADOPTED from their execution journals (not re-run). An
  // adopted process found dead becomes Failed (usage unknown: charged its cap) and wakes the
  // leader. The leader's in-flight turn and unconfirmed patch proposals are lost; it re-wakes.
  action restart = all {
    nondet dead = NODES.filter(n => live(n)).powerset().oneOf()
    val charge = dead.fold(0, (a, n) => a + nd(n).est)
    val evc = dead.fold(0, (a, n) => a + nd(n).ev)
    val wakeC = if (s.leader == Awake) W else 0
    s' = { ...s,
      nodes: NODES.mapBy(n => if (dead.contains(n)) { ...nd(n), st: Failed } else nd(n)),
      leader: Asleep, patchProps: Set(),
      mSpent: s.mSpent + wakeC + charge, mRes: s.mRes - wakeC - charge,
      eSpent: s.eSpent + evc, eRes: s.eRes - evc,
      inbox: s.inbox + (if (s.phase == Live) 1 else 0),
      deadAdopted: s.deadAdopted + dead.size(),
      restartsWithRunning: s.restartsWithRunning + (if (liveCount > dead.size()) 1 else 0) }
  }

  // ---------------------------------------------------------------- owner (never waits for the leader)
  action ownerPause = all { s.phase == Live, s' = { ...s, phase: Paused } }
  action ownerResume = all { s.phase == Paused or s.phase == Parked,
                             s' = { ...s, phase: Live, wantPark: false } }
  action ownerStop = all { s.phase != Finished, s' = finishWith(Stopped, Owner, NoVerdict, 0, -1) }
  action ownerExtend = all {
    s.phase != Finished, s.extends < 2,
    s' = { ...s, deadline: s.deadline + 4, mBudget: s.mBudget + 4, extends: s.extends + 1 }
  }
  action ownerMsg = all { s.phase != Finished, s' = { ...s, inbox: s.inbox + 1 } }
  action ownerCancel = all {
    nondet n = NODES.oneOf()
    nondet a = 0.to(3).oneOf()
    all { s.phase != Finished,
          nd(n).st == Pending or nd(n).st == Running or nd(n).st == Waiting,
          s' = { ...cancelNode(n, a), inbox: s.inbox + 1 } }
  }
  action ownerEndRound = all {
    s.phase != Finished, s.roundOpen,
    nondet met = Set(true, false).oneOf()
    s' = endRoundState(met)
  }
  // The owner's own patch is one atomic host command (CAS against the revision on screen).
  action ownerPatch = all {
    s.phase != Finished,
    nondet n = NODES.oneOf()
    nondet newEst = 1.to(3).oneOf()
    all { nd(n).st == Pending,
          s' = { ...s, applied: s.applied + 1, inbox: s.inbox + 1,
                 nodes: s.nodes.set(n, { ...nd(n), rev: nd(n).rev + 1,
                   est: if (nd(n).kind == Work or nd(n).kind == Check) newEst else nd(n).est }) } }
  }
  // Answering a gate is judgment: allowed after finish too. Answering unparks.
  action answerGate = all {
    nondet g = ALL_GATES.oneOf()
    all { not(s.answered.contains(g)),
          s' = { ...s, answered: s.answered.union(Set(g)),
                 everDone: s.everDone.union(NODES.filter(n => nd(n).st == Waiting and nd(n).gate == g)),
                 nodes: NODES.mapBy(n => if (nd(n).st == Waiting and nd(n).gate == g)
                                           { ...nd(n), st: Done } else nd(n)),
                 phase: if (s.phase == Parked) Live else s.phase,
                 wantPark: if (s.phase == Parked) false else s.wantPark,
                 inbox: s.inbox + (if (s.phase != Finished) 1 else 0) } }
  }
  // The owner's screen loads the pending revision (its id, base and content).
  action ownerRead = all {
    s.pend.active,
    s' = { ...s, seen: { valid: true, base: s.pend.base, id: s.pend.id, crit: s.pend.crit } }
  }
  // ratify(base, id): CAS on BOTH the proposal id the owner saw and the base version.
  action ratify = all {
    s.phase != Finished, s.pend.active, s.seen.valid,
    if (s.seen.id != s.pend.id)
      s' = { ...s, seen: { ...s.seen, valid: false }, idRefusals: s.idRefusals + 1 }
    else if (s.pend.base == effV)
      s' = { ...s, objs: s.objs.append({ crit: s.pend.crit, byOwner: true, against: effV, seen: s.seen.crit }),
             pend: { ...s.pend, active: false }, seen: { ...s.seen, valid: false },
             ratified: s.ratified + 1, inbox: s.inbox + 1 }
    else
      s' = { ...s, pend: { ...s.pend, active: false }, seen: { ...s.seen, valid: false },
             staleRatifies: s.staleRatifies + 1, inbox: s.inbox + 1 }
  }
  action rejectRevision = all { s.pend.active,
    s' = { ...s, pend: { ...s.pend, active: false }, inbox: s.inbox + (if (s.phase == Live) 1 else 0) } }
  // Accepting a proposed finish: only a proposal written under the CURRENT objective version.
  // After finish it is the verdict on the result.
  action ownerAccept = all {
    if (s.phase == Finished)
      all { s.verdict == NoVerdict, s' = { ...s, verdict: Accepted } }
    else
      all { s.proposed,
            if (s.propV == effV) s' = finishWith(Met, Owner, Accepted, 0, effV)
            else s' = { ...s, proposed: false, staleAccepts: s.staleAccepts + 1, inbox: s.inbox + 1 } }
  }
  action ownerReject = all {
    if (s.phase == Finished)
      all { s.verdict == NoVerdict, s' = { ...s, verdict: Rejected } }
    else
      all { s.proposed, s' = { ...s, proposed: false, inbox: s.inbox + 1 } }
  }

  // Weighted for simulation depth: the simulator picks uniformly among enabled branches, so a
  // flat list let ownerStop end most traces within ~20 steps and the clock rarely reached the
  // deadline. Grouping keeps every act reachable while traces run to the deadline.
  action leaderStep = any {
    wake, sleep, planRound, planRound, extendRound, reflect, reflect, proposePatch, commitPatch,
    leaderCancel, leaderEndRound, rewriteMeta, reviseObjective, proposeFinish
  }
  action hostStep = any {
    startNode, startNode, carve, popDone, complete, complete, failNode, cancelOrphan, closeRound,
    closeRound, hostFinishMet, hostFinishMet, hostFinishMet, exhaust, park, closeReport, restart
  }
  action ownerStep = any {
    ownerPause, ownerResume, ownerStop, ownerExtend, ownerMsg, ownerCancel,
    ownerEndRound, ownerPatch, answerGate, answerGate, answerGate, answerGate, ownerRead, ownerRead,
    ratify, ratify,
    rejectRevision, ownerAccept, ownerAccept, ownerReject
  }
  action step = any {
    leaderStep, leaderStep, leaderStep, leaderStep, hostStep, hostStep, hostStep, hostStep, tick,
    tick, ownerStep
  }

  // Reachability aid for rare witnesses (a multi-criterion host Met needs two passing checks of
  // different criteria on ONE sha under the current version, an answered gate and mode OnMet).
  // It uses a SUBSET of `step`'s transitions (no owner stop/cancel/end/pause, fewer ticks), so
  // every state it reaches is reachable by `step`; it changes probabilities only.
  action stepReach = any {
    leaderStep, leaderStep, hostStep, hostStep, hostStep, hostStep, hostStep, hostStep, tick,
    answerGate, answerGate, ownerRead, ratify, rejectRevision, ownerAccept
  }

  // ---------------------------------------------------------------- safety invariants
  // I2: a node that reached Done stays Done.
  val doneImmutable = s.everDone.forall(n => nd(n).st == Done)
  // I3: the ledger never overshoots; while not finished, the closing reserve is untouched.
  val budgetSafe = all {
    s.mSpent + s.mRes <= s.mBudget,
    s.phase == Finished or s.mSpent + s.mRes <= s.mBudget - CLOSE,
    s.eSpent + s.eRes <= s.eBudget,
    s.mRes >= 0, s.eRes >= 0
  }
  // I3a: reservations equal exactly what is running (carving moves money, never mints it).
  val ledgerExact = all {
    s.mRes == NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).est)
              + (if (s.leader == Awake) W else 0),
    s.eRes == NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).ev)
  }
  // I3b: live caps; gates and populations never hold a slot (their carved children do).
  val capacity = all {
    liveCount <= MAXLIVE, runningIn(Gpu) <= GPU_CAP, runningIn(Cpu) <= CPU_CAP,
    NODES.forall(n => nd(n).st == Running implies (usesCapacity(nd(n).kind) or (nd(n).kind == Fan and nd(n).arch)))
  }
  // I4: a started node runs the spec revision it started with (no patch lands after start).
  val specFrozen = NODES.forall(n =>
    (nd(n).st == Running or (nd(n).st == Done and nd(n).kind != Gate) or nd(n).st == Failed)
      implies nd(n).rev == nd(n).startedRev)
  // I5: every list fan fans out over a list-typed input.
  val typedFanout = NODES.forall(n => (nd(n).st != Free and nd(n).kind == Fan and not(nd(n).arch)) implies
    (nd(n).src != -1 and nd(nd(n).src).outList))
  // I6: every meta-plan keeps the charter gates. (The host-finish clause restates the
  // hostFinishMet guard; it only catches an ablation of that guard.)
  val gatesKept = all {
    s.plans.foldl(true, (ok, p) => ok and CHARTER_GATES.subseteq(p)),
    (s.reason == Met and s.by == Host) implies CHARTER_GATES.subseteq(s.answered)
  }
  // I7a: a host Met names one sha on which EVERY check criterion of the version it certified
  // passed, that version is still current, and the charter allowed finishing on met.
  val metOneSha = (s.reason == Met and s.by == Host) implies all {
    s.mode == OnMet, s.metV == effV, certified(s.metV, s.metSha)
  }
  // I7b: an owner Met accepted a proposal written under the current objective version.
  val ownerMetCurrent = (s.reason == Met and s.by == Owner) implies (s.propV == effV and s.metV == effV)
  // I8: every objective version is additive over its predecessor or owner-ratified against it.
  val objectiveFidelity = 1.to(s.objs.length() - 1).forall(i =>
    s.objs[i].against == i - 1 and
    (s.objs[i - 1].crit.subseteq(s.objs[i].crit) or s.objs[i].byOwner))
  // I8a: v0 carries owner authority (it is part of the signed charter). Structural: init only.
  val v0Signed = s.objs[0].byOwner and s.objs[0].against == -1
  // I8b: every owner-ratified version is exactly the content the owner saw when ratifying.
  val ratifiedAsSeen = 1.to(s.objs.length() - 1).forall(i => s.objs[i].byOwner implies s.objs[i].crit == s.objs[i].seen)
  // I9: termination on the work clock, and a hard stop on wall time that bounds parking.
  val terminates = s.work >= s.deadline implies s.phase == Finished
  val hardStop = s.time >= s.deadline + PARKMAX implies s.phase == Finished
  // I10: after finish no work runs and nobody is awake; only judgment (checks, gates, verdict).
  val noWorkAfterFinish = s.phase == Finished implies all {
    NODES.forall(n => nd(n).st == Running implies nd(n).kind == Check),
    NODES.forall(n => nd(n).st != Pending),
    s.leader == Asleep
  }
  // I11: no node is ever started twice. Structural in this model (no action returns a node to
  // Pending); the guard is shown by ablation A5.
  val noRerun = NODES.forall(n => nd(n).starts <= 1)
  // The leader is asleep once finished. (While paused it may finish a turn begun while live;
  // its acts are refused then.)
  val leaderBounded = s.phase == Finished implies s.leader == Asleep
  // I17 (bounded response for "an answered gate's node becomes Done"): no node waits on a gate
  // that is already answered.
  val noDeadGate = NODES.forall(n => nd(n).st == Waiting implies not(s.answered.contains(nd(n).gate)))
  // I18 (gates never hold a round): no uncarried pending node depends on a gate or a carried node.
  val gateFree = NODES.forall(n => (nd(n).st == Pending and not(nd(n).carried) and nd(n).src != -1)
    implies not(nd(nd(n).src).kind == Gate or nd(nd(n).src).carried))
  // I19 (bounded response for "an open round closes"): a round is never open past its wall cap.
  val roundBounded = s.roundOpen implies s.work - s.roundAt < ROUNDMAX
  val extendBounded = s.roundExt <= MAXEXT
  // I20 (G10): replaying the history, every reflection that followed two consecutive misses
  // since the last structural change was structural. Recomputed from grades/decs, not `streak`.
  val g10 =
    val n = s.decs.length()
    range(0, n).foldl((true, 0), (acc, i) =>
      val st = if (s.grades[i]) 0 else acc._2 + 1
      val ok = acc._1 and (st >= 2 implies structural(s.decs[i]))
      (ok, if (structural(s.decs[i])) 0 else st))._1
  // Outer reflection is mandatory: never more rounds opened than reflected + 1.
  val reflected = s.curRound <= s.decs.length() + 1

  val safety = all {
    doneImmutable, budgetSafe, ledgerExact, capacity, specFrozen, typedFanout, gatesKept,
    metOneSha, ownerMetCurrent, objectiveFidelity, v0Signed, ratifiedAsSeen, terminates, hardStop,
    noWorkAfterFinish, noRerun, leaderBounded, noDeadGate, gateFree, roundBounded, extendBounded,
    g10, reflected
  }

  // ---------------------------------------------------------------- non-vacuity witnesses
  // Each is expected to be VIOLATED: the simulator reaches the interesting state.
  val w_noWorkDone = NODES.forall(n => not(nd(n).st == Done and nd(n).kind == Work))
  val w_noPatchRace = s.staleRejects == 0
  val w_noPatchApplied = s.applied == 0
  val w_noMapFanout = s.mapChildren == 0
  val w_noMistypedPlan = s.mistypedRejects == 0
  val w_noRewrite = s.rewrites == 0
  val w_noGateDrop = s.gateDropRejects == 0
  val w_noRatify = s.ratified == 0
  val w_noStaleRatify = s.staleRatifies == 0
  val w_noIdRefusal = s.idRefusals == 0
  val w_noRevBlocked = s.revBlocked == 0
  val w_noHostMet = not(s.reason == Met and s.by == Host)
  val w_noHostMetMulti = not(s.reason == Met and s.by == Host and s.objs[s.metV].crit.size() >= 2)
  val w_noOwnerMet = not(s.reason == Met and s.by == Owner)
  val w_noStaleAccept = s.staleAccepts == 0
  val w_noDeadline = s.reason != Deadline
  val w_noBudgetEnd = s.reason != Budget
  val w_noCheckAfterFinish = s.checksAfterFinish == 0
  val w_noAdoption = s.restartsWithRunning == 0
  val w_noDeadAdopted = s.deadAdopted == 0
  val w_noLateVerdict = not(s.reason == Deadline and s.verdict == Accepted)
  val w_noThirdRound = s.curRound < 3
  val w_gpuNeverFull = runningIn(Gpu) < GPU_CAP
  val w_noOrphan = s.orphansCancelled == 0
  val w_noExtend = s.extended == 0
  val w_noReflect = s.decs.length() == 0
  val w_noForcedChange = s.forcedChanges == 0
  val w_noG10Refusal = s.g10Refusals == 0
  val w_noGateShortcut = s.gateShortcuts == 0
  val w_noCarriedDone = s.carriedDone == 0
  val w_noPark = s.parks == 0
  val w_noUnparkByAnswer = not(s.parks > 0 and s.phase == Live)
  val w_noCapClose = s.capCloses == 0
  val w_noRunEval = s.runEvals == 0
  val w_noPopulation = s.popChildren == 0
  val w_noReport = not(s.reported)

  // ---------------------------------------------------------------- guard ablations
  // Each removes ONE guard; run the named invariant with --step=<ablation> and it MUST be
  // violated. This shows the guard is load-bearing, not that the model is trivially safe.

  // A1 (I3): the cap is enforced only between messages, so a node can end one message past
  // its reservation. Expect budgetSafe violated. Design fix: kill at usage + maxMessage > cap.
  action completeOvershoot = all {
    nondet n = NODES.oneOf()
    val x = nd(n)
    all { x.st == Running, usesCapacity(x.kind),
          s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Done }), everDone: s.everDone.union(Set(n)),
                 mSpent: s.mSpent + x.est + 1, mRes: s.mRes - x.est,
                 eSpent: s.eSpent + x.ev, eRes: s.eRes - x.ev } }
  }
  action stepOvershoot = any { step, completeOvershoot }

  // A2 (I4): commit a patch checking neither status nor revision. Expect specFrozen violated.
  action commitPatchBlind = all {
    s.patchProps.size() > 0,
    nondet p = s.patchProps.oneOf()
    val n = p._1
    s' = { ...s, patchProps: s.patchProps.exclude(Set(p)), applied: s.applied + 1,
           nodes: s.nodes.set(n, { ...nd(n), rev: nd(n).rev + 1 }) }
  }
  action stepBlindPatch = any { step, commitPatchBlind }

  // A3 (I8): ratify without comparing the base version. Expect objectiveFidelity violated.
  action ratifyBlind = all {
    s.phase != Finished, s.pend.active, s.seen.valid, s.seen.id == s.pend.id,
    s' = { ...s, objs: s.objs.append({ crit: s.pend.crit, byOwner: true, against: s.pend.base, seen: s.seen.crit }),
           pend: { ...s.pend, active: false }, ratified: s.ratified + 1 }
  }
  action stepBlindRatify = any { step, ratifyBlind }

  // A4 (I7a): host finishes ignoring which objective version a check was planned under.
  action hostFinishStale = all {
    s.phase == Live, s.mode == OnMet, CHARTER_GATES.subseteq(s.answered),
    not(eff.crit.contains(OWNER_CRIT)),
    nondet h = SHAS.oneOf()
    all { eff.crit.forall(c => NODES.exists(n => nd(n).kind == Check and nd(n).st == Done and nd(n).pass
            and nd(n).crit == c and nd(n).sha == h)),
          s' = finishWith(Met, Host, Accepted, h, effV) }
  }
  action stepStaleFinish = any { step, hostFinishStale }
  action stepStaleFinishR = any { stepReach, hostFinishStale }

  // A5 (I11, lesson L10): restart does NOT adopt; running nodes go back to Pending and rerun,
  // as crew turns do today (shutdown.ts discardCrewTurns). Expect noRerun violated.
  action restartNoAdopt = all {
    s' = { ...s, leader: Asleep, patchProps: Set(),
           mSpent: s.mSpent + (if (s.leader == Awake) W else 0)
                   + NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).est),
           mRes: 0, eRes: 0,
           eSpent: s.eSpent + NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).ev),
           nodes: NODES.mapBy(n => if (nd(n).st == Running) { ...nd(n), st: Pending } else nd(n)) }
  }
  action stepNoAdopt = any { step, restartNoAdopt }

  // A6 (I6): rewrite_meta accepted without the gate check. Expect gatesKept violated.
  action rewriteBlind = all {
    leaderMay,
    nondet g = ALL_GATES.powerset().oneOf()
    s' = { ...s, plans: s.plans.append(g), rewrites: s.rewrites + 1 }
  }
  action stepBlindRewrite = any { step, rewriteBlind }

  // A7 (I8b): the pre-review ratify: CAS on the base only, never on the proposal id. With
  // reject + re-propose (same base, new content), the owner ratifies what they never saw.
  action ratifyBaseOnly = all {
    s.phase != Finished, s.pend.active, s.seen.valid, s.pend.base == effV,
    s' = { ...s, objs: s.objs.append({ crit: s.pend.crit, byOwner: true, against: effV, seen: s.seen.crit }),
           pend: { ...s.pend, active: false }, seen: { ...s.seen, valid: false }, ratified: s.ratified + 1 }
  }
  action stepBaseOnlyRatify = any { step, ratifyBaseOnly }
  action stepBaseOnlyRatifyR = any { stepReach, ratifyBaseOnly, ratifyBaseOnly }

  // A8 (I7a): the pre-review host finish: ONE passing current check, no criterion/sha link.
  action hostFinishAnyPass = all {
    s.phase == Live, s.mode == OnMet, CHARTER_GATES.subseteq(s.answered),
    not(eff.crit.contains(OWNER_CRIT)),
    NODES.exists(n => nd(n).kind == Check and nd(n).st == Done and nd(n).pass and nd(n).objV == effV),
    s' = finishWith(Met, Host, Accepted, 1, effV)
  }
  action stepAnyPassFinish = any { step, hostFinishAnyPass }

  // A9 (I17): the pre-review gate start: always Waiting, even if the gate was already answered.
  action startGateBlind = all {
    s.phase == Live,
    nondet n = NODES.oneOf()
    val x = nd(n)
    all { x.st == Pending, x.kind == Gate, depOk(n), x.carried or (s.roundOpen and x.round == s.curRound),
          s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Waiting, startedRev: x.rev, starts: x.starts + 1 }) } }
  }
  action stepBlindGate = any { step, startGateBlind }

  // A10 (I18): plan without carry: gate dependents stay round members.
  action planNoCarry = all {
    leaderMay, not(s.roundOpen), s.curRound < MAXROUNDS, freeSlots.size() >= 2,
    s.decs.length() == s.grades.length(),
    nondet i = freeSlots.oneOf()
    nondet j = freeSlots.exclude(Set(i)).oneOf()
    nondet g = 1.to(2).oneOf()
    val r = s.curRound + 1
    val draft = s.nodes.set(i, { ...FREE, st: Pending, round: r, kind: Gate, gate: g, objV: effV })
                       .set(j, { ...FREE, st: Pending, round: r, kind: Work, est: 1, src: i, objV: effV })
    s' = { ...s, nodes: draft, curRound: r, roundOpen: true, roundAt: s.work, roundExt: 0 }
  }
  action stepNoCarry = any { step, planNoCarry }

  // A11 (I20/G10): reflect without the two-miss rule.
  action reflectNoG10 = all {
    leaderMay, not(s.roundOpen), s.decs.length() < s.grades.length(),
    nondet d = Set(Continue, Revise).oneOf()
    s' = { ...s, decs: s.decs.append(d) }
  }
  action stepNoG10 = any { step, reflectNoG10 }

  // A12 (I7b): accept a finish proposal written under an older objective version.
  action acceptStale = all {
    s.phase != Finished, s.proposed, s.propV != effV,
    s' = finishWith(Met, Owner, Accepted, 0, s.propV)
  }
  action stepStaleAccept = any { step, acceptStale }

  // A13 (I19): a tick without the round wall cap.
  action tickNoCap = all {
    s.time < MAXTIME,
    val t2 = s.time + 1
    val w2 = if (s.phase == Parked or s.phase == Finished) s.work else s.work + 1
    if (s.phase != Finished and (w2 >= s.deadline or t2 >= s.deadline + PARKMAX))
      s' = { ...finishWith(Deadline, Host, NoVerdict, 0, -1), time: t2, work: w2 }
    else
      s' = { ...s, time: t2, work: w2 }
  }
  action stepNoRoundCap = any { leaderStep, leaderStep, leaderStep, hostStep, hostStep, tickNoCap, tickNoCap, ownerStep }

  // A14 (I9 hard stop): a tick that only checks the work clock: parking never ends.
  action tickNoHardStop = all {
    s.time < MAXTIME,
    val t2 = s.time + 1
    val w2 = if (s.phase == Parked or s.phase == Finished) s.work else s.work + 1
    if (s.phase != Finished and w2 >= s.deadline)
      s' = { ...finishWith(Deadline, Host, NoVerdict, 0, -1), time: t2, work: w2 }
    else
      s' = { ...s, time: t2, work: w2 }
  }
  action stepNoHardStop = any { leaderStep, leaderStep, leaderStep, hostStep, hostStep, hostStep, tickNoHardStop, tickNoHardStop, ownerStep }
}

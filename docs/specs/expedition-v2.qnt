// Expeditions V2 (2026-11-09): V1's leader + rounds core (docs/specs/expedition-v1.qnt, rev 2)
// with the V2 changes that touch concurrency, authority or termination:
//   C1  lanes: fan children run in at most `lanes` reused sessions per fan, one item at a time
//   C3  declare-before-spend: a node of a dead family is refused at START and at CARVE, not
//       only at plan time (V1 checked plan time only; ablation A15 reproduces that hole)
//   C4  judge panel (revision 3): a key is a calibrated judge on a provider OTHER than the
//       producer's, a passing check on the subject, or the owner. "Yes" (keep/promote/verified on
//       a produced node, a representation change) needs two distinct keys. A strike is a failed
//       check in a family that has an evaluator, or a judge reject in one that has none. A failed
//       canary voids the judge's pending votes AND its strikes (death is recomputed).
//   rev 3 also: a family's death cancels its running and pending work (C3); the eval of a
//       committed candidate is refused when its CLASSIFIED family (tfam) is dead, whatever the
//       generator declared; the host integrates passing candidates onto the integration branch at
//       round close and the next round's base is that head (C15); auto_continue yields to a queued
//       owner event and re-checks families (C12); a rewrite must change the plan (C10).
//   C8  ticks never wake the leader; an ordinary failure is batched to round close; only a
//       `blocked` failure, a stall, a round close or an owner act wakes it
//   C10 rewrite_meta and propose_finish exist only as reflections (standalone acts deleted)
//   C12 pre-planned rounds: the host auto-continues into the next pre-written graph ONLY after a
//       round that met every prediction and was graded by the host alone
// Design: docs/expeditions/v2-leader-rounds-refined.md (section 9 has every command and result;
// section 11 maps each critique item to its fix here).
//
// Scope: the structural core only. LLM judgment (what the leader plans, whether a check passes,
// whether a round met its prediction, a judge's verdict, a canary outcome, actual spend) is a
// nondeterministic choice. Bounded: 8 node slots, 3 rounds, money 14 (+4 per extend), 2 scarce
// evaluations, work deadline 12, park allowance 4, round wall cap 4, 2 families, 2 judges.
//
//   quint typecheck docs/specs/expedition-v2.qnt
//   quint run docs/specs/expedition-v2.qnt --invariant=<name> --max-samples=3000 --max-steps=80
// `safety` conjoins every safety invariant; `w_*` are non-vacuity witnesses and MUST be violated;
// each `step<Ablation>` removes one guard and MUST violate the invariant named at it.
module expedition {
  // ---------------------------------------------------------------- types
  type Status = Free | Pending | Waiting | Running | Done | Failed | Cancelled
  type Kind = Work | Check | Gate | Fan
  type Cls = Cpu | Gpu
  type Who = Owner | Host | Nobody          // no Leader value: the leader cannot finish, by type
  type Reason = NotYet | Met | Deadline | Budget | Stopped
  type Verdict = NoVerdict | Accepted | Rejected
  type Phase = Live | Paused | Parked | Finished
  type LeaderSt = Asleep | Awake
  type Mode = OnMet | ToDeadline
  type Dec = Continue | Revise | Rewrite | ProposeFin | Ask

  type Node = {
    st: Status, round: int, kind: Kind, cls: Cls,
    est: int, ev: int, rev: int, startedRev: int, starts: int,
    pass: bool, objV: int, crit: int, sha: int, src: int, parent: int,
    outList: bool, arch: bool, carried: bool, gate: int,
    fam: int,          // V2: DECLARED idea family (0 = none; a node holding evals may not be 0)
    tfam: int,         // rev 3: the family a classifier assigns to the committed diff (ground truth here)
    lanes: int,        // V2 Fan: how many reused sessions serve its children
    lane: int,         // V2 fan child: the lane it ran in (-1 none)
    seat: int,         // V2: producing seat (0 cheap, 1 and 2 are also judge seats)
    base: int          // rev 3: integration-branch version the node's tree was reset to at start
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
    plans: List[Set[int]], answered: Set[int],
    objs: List[Obj], pend: Pend, nextId: int, seen: Seen,
    grades: List[bool],      // per closed round: predictions met (host/judge grade)
    hostOnly: List[bool],    // V2: per closed round: every prediction was check-typed (host graded)
    decs: List[Dec], autos: List[bool],   // reflection, and whether the host auto-continued (C12)
    streak: int, wantPark: bool,
    proposed: bool, propV: int, metSha: int, metV: int, reported: bool,
    patchProps: Set[(int, int)], everDone: Set[int], extends: int,
    prePlanned: int,         // V2: pre-written round graphs left in the meta-plan
    // V2 judgments (rev 3)
    strikes: Set[(int, int, int)],        // (family, source, node): source 0 = a check, 1/2 = a judge
    judged: Set[int],
    verdictLog: Set[(int, int)],          // (node, judge)
    votes: Set[(int, int)],               // pending representation-change votes (family, judge)
    repLog: Set[(int, int, int, int)],    // committed (family, judge1, judge2, seq)
    uncal: Set[int], failedAt: int -> int, seq: int,
    yesVotes: Set[(int, int)],            // pending yes keys (node, key): 1/2 judge, 3 check, 4 owner
    yesLog: Set[(int, int, int, int)],    // committed yes (node, key1, key2, seq)
    yesDone: Set[int],
    // rev 3 integration (C15)
    merged: Set[(int, int)],              // (node, round at whose close it was merged)
    intV: int,                            // integration-branch version (number of merges)
    ownerQ: int,                          // owner events queued since the last wake
    bodies: List[int],                    // meta-plan content per version (rewrite must change it)
    // V2 lanes
    laneUsed: Set[(int, int)],            // (fan, lane) that already ran an item: its session is warm
    // witness counters (ghosts)
    staleRejects: int, gateDropRejects: int, mistypedRejects: int, staleRatifies: int,
    idRefusals: int, revBlocked: int, staleAccepts: int, forcedChanges: int, g10Refusals: int,
    restartsWithRunning: int, deadAdopted: int, checksAfterFinish: int, applied: int,
    mapChildren: int, popChildren: int, runEvals: int, rewrites: int, ratified: int,
    orphansCancelled: int, extended: int, carriedDone: int, parks: int, capCloses: int,
    gateShortcuts: int,
    warmStarts: int, coldStarts: int, famRefusals: int, repChanges: int, canaryFails: int,
    rejectVerdicts: int, autoConts: int, quietFails: int, stalls: int,
    famKills: int, classRefusals: int, autoRefusals: int, autoOverOwner: int, conflicts: int,
    sameRewrites: int, strikeVoids: int, yesCommits: int, judgeYes: int, revivals: int
  }

  // ---------------------------------------------------------------- constants
  pure val NODES = 0.to(7)        // V2: 8 slots (V1 had 6): dead-family refusals need slots left after two rejects
  pure val MAXROUNDS = 3
  pure val W = 2
  pure val CLOSE = 2
  pure val MAXLIVE = 3
  pure val CPU_CAP = 2
  pure val GPU_CAP = 1
  pure val CHARTER_GATES = Set(1)
  pure val ALL_GATES = Set(1, 2)
  pure val ADHOC = 2
  pure val OWNER_CRIT = 3
  pure val ALL_CRIT = Set(1, 2, 3)
  pure val SHAS = Set(1, 2)
  pure val MAXTIME = 26
  pure val PARKMAX = 4
  pure val ROUNDMAX = 4
  pure val MAXEXT = 2
  pure val FAMS = Set(1, 2)
  pure val STRIKES = 2            // a family is dead after 2 rejects since its last rep change
  pure val JUDGES = Set(1, 2)     // the charter's judge panel: judge j sits on provider j
  pure val SEATS = Set(0, 1, 2)   // producing seats: 0 cheap and 1 on provider 1, 2 on provider 2
  pure val EVAL_FAMS = Set(1)     // families with an evaluator: only failed checks strike them
  pure val CHECK_KEY = 3
  pure val OWNER_KEY = 4
  pure val NEVER = 1000

  pure val FREE: Node = {
    st: Free, round: 0, kind: Work, cls: Cpu, est: 0, ev: 0, rev: 0, startedRev: -1,
    starts: 0, pass: false, objV: 0, crit: 1, sha: 1, src: -1, parent: -1, outList: false,
    arch: false, carried: false, gate: 0, fam: 0, tfam: 0, lanes: 0, lane: -1, seat: 0, base: 0
  }

  pure val SPECS: Set[Spec] =
    Set(Work, Check, Gate, Fan).map(k =>
      Set(Cpu, Gpu).map(c =>
        1.to(3).map(e =>
          Set(true, false).map(l =>
            (-1).to(7).map(r =>
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
  def member(n: int): bool = nd(n).round == s.curRound and not(nd(n).carried) and nd(n).st != Free
  // V2 (C3, rev 3): a family is dead once it holds STRIKES live strikes. Strikes are cleared by an
  // accepted representation change and VOIDED when their judge fails a canary, so death is a fold
  // over calibrated evidence, never a sticky counter (the critique's r_strikesCalibrated finding).
  def deadIn(x: S, f: int): bool = f > 0 and x.strikes.filter(st => st._1 == f).size() >= STRIKES
  def dead(f: int): bool = deadIn(s, f)
  // rev 3: the guarded quantity per kind. Work spends under its declared family; an evaluation
  // spends under the family its committed diff is classified as (the relabel hole, C3).
  def spendFam(x: Node): int = if (x.kind == Check) x.tfam else x.fam
  // rev 3 (C4): the panel's judges sit on providers 1 and 2; the cheap seat shares provider 1.
  def prov(seat: int): int = if (seat == 2) 2 else 1
  // rev 3 (C3): a family's death cancels its running and pending work in the same write, charged
  // at the reservation (journaled usage <= reservation). Without it, work of a family that died
  // mid-flight kept spending (critique probe r_noDeadRunning, seed 0xd5add3158cb140e3).
  def killDead(x: S): S =
    val doomed = NODES.filter(n => usesCapacity(x.nodes.get(n).kind) and
      (x.nodes.get(n).st == Running or x.nodes.get(n).st == Pending) and
      deadIn(x, spendFam(x.nodes.get(n))))
    val runs = doomed.filter(n => x.nodes.get(n).st == Running)
    val charge = runs.fold(0, (a, n) => a + x.nodes.get(n).est)
    val evc = runs.fold(0, (a, n) => a + x.nodes.get(n).ev)
    { ...x, nodes: NODES.mapBy(n => if (doomed.contains(n)) { ...x.nodes.get(n), st: Cancelled } else x.nodes.get(n)),
      mSpent: x.mSpent + charge, mRes: x.mRes - charge, eSpent: x.eSpent + evc, eRes: x.eRes - evc,
      famKills: x.famKills + doomed.size() }
  // V2 (C1): a lane runs one item at a time.
  def laneBusy(p: int, l: int): bool =
    NODES.exists(c => nd(c).parent == p and nd(c).lane == l and nd(c).st == Running)
  def laneOk(p: int, l: int): bool = l < nd(p).lanes and not(laneBusy(p, l))

  def depOk(n: int): bool =
    val r = nd(n).src
    r == -1 or (nd(r).st == Done and (nd(r).kind != Fan or
      NODES.forall(c => nd(c).parent != r or isTerminal(nd(c).st))))

  def certified(v: int, sha: int): bool =
    not(s.objs[v].crit.contains(OWNER_CRIT)) and
    s.objs[v].crit.forall(c => NODES.exists(n =>
      nd(n).kind == Check and nd(n).st == Done and nd(n).pass and nd(n).crit == c and
      nd(n).sha == sha and nd(n).objV == v))

  def carryIn(draft: int -> Node, n: int): bool =
    val r = draft.get(n).src
    r != -1 and (draft.get(r).kind == Gate or draft.get(r).carried)
  def withCarry(draft: int -> Node, ids: Set[int]): int -> Node =
    val p1 = NODES.mapBy(n => if (ids.contains(n)) { ...draft.get(n), carried: carryIn(draft, n) } else draft.get(n))
    NODES.mapBy(n => if (ids.contains(n)) { ...p1.get(n), carried: carryIn(p1, n) } else p1.get(n))

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

  // rev 3 (C15): integration at round close, a host step with no LLM. Every done, passing work
  // candidate not yet merged is merged onto the integration branch in plan order and its check is
  // re-run on the merged sha. A conflict (or a red re-check) stops the merge at that candidate,
  // raises blocked{needs: redesign} (an inbox event) and makes the round NOT met, so auto_continue
  // cannot pass over it. The model merges all or none (a conflict on the first candidate).
  def integrated(x: S, conflict: bool): S =
    val cands = NODES.filter(n => x.nodes.get(n).kind == Work and x.nodes.get(n).st == Done and
      x.nodes.get(n).pass and not(x.merged.exists(m => m._1 == n)))
    if (conflict and cands.size() > 0) { ...x, conflicts: x.conflicts + 1, inbox: x.inbox + 1 }
    else { ...x, merged: x.merged.union(cands.map(n => (n, x.curRound))), intV: x.intV + cands.size() }
  def hasCands: bool = NODES.exists(n => nd(n).kind == Work and nd(n).st == Done and nd(n).pass and
      not(s.merged.exists(m => m._1 == n)))

  def closeState(met: bool, ho: bool, conflict: bool): S =
    val bad = conflict and hasCands
    integrated({ ...s, roundOpen: false,
      nodes: NODES.mapBy(n => if (member(n) and not(isTerminal(nd(n).st))) { ...nd(n), carried: true } else nd(n)),
      grades: s.grades.append(met and not(bad)), hostOnly: s.hostOnly.append(ho),
      streak: if (met and not(bad)) 0 else s.streak + 1,
      inbox: s.inbox + 1 }, conflict)

  def endRoundState(met: bool, ho: bool, conflict: bool): S =
    val gone = NODES.filter(n => member(n) and (nd(n).st == Pending or nd(n).st == Running))
    val charge = gone.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).est)
    val evc = gone.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).ev)
    val bad = conflict and hasCands
    integrated({ ...s, nodes: NODES.mapBy(n => if (gone.contains(n)) { ...nd(n), st: Cancelled } else nd(n)),
      mSpent: s.mSpent + charge, mRes: s.mRes - charge,
      eSpent: s.eSpent + evc, eRes: s.eRes - evc, roundOpen: false,
      grades: s.grades.append(met and not(bad)), hostOnly: s.hostOnly.append(ho),
      streak: if (met and not(bad)) 0 else s.streak + 1, inbox: s.inbox + 1 }, conflict)

  // ---------------------------------------------------------------- init
  action init = all {
    nondet v0 = Set(Set(1), Set(1, 2), Set(1, 3)).oneOf()
    nondet m = Set(OnMet, ToDeadline).oneOf()
    nondet pp = 0.to(2).oneOf()
    s' = {
      nodes: NODES.mapBy(_ => FREE),
      curRound: 0, roundOpen: false, roundAt: 0, roundExt: 0,
      phase: Live, reason: NotYet, by: Nobody, verdict: NoVerdict, mode: m,
      mBudget: 14, mSpent: 0, mRes: 0,
      eBudget: 2, eSpent: 0, eRes: 0,
      time: 0, work: 0, deadline: 12,
      leader: Asleep, inbox: 1,
      plans: [CHARTER_GATES], answered: Set(),
      objs: [{ crit: v0, byOwner: true, against: -1, seen: v0 }],
      pend: { active: false, base: 0, id: 0, crit: Set() }, nextId: 1,
      seen: { valid: false, base: 0, id: 0, crit: Set() },
      grades: [], hostOnly: [], decs: [], autos: [], streak: 0, wantPark: false,
      proposed: false, propV: 0, metSha: 0, metV: -1, reported: false,
      patchProps: Set(), everDone: Set(), extends: 0,
      prePlanned: pp,
      strikes: Set(), judged: Set(), verdictLog: Set(), votes: Set(),
      repLog: Set(), uncal: Set(), failedAt: JUDGES.mapBy(_ => NEVER), seq: 0,
      yesVotes: Set(), yesLog: Set(), yesDone: Set(),
      merged: Set(), intV: 0, ownerQ: 0, bodies: [0],
      laneUsed: Set(),
      staleRejects: 0, gateDropRejects: 0, mistypedRejects: 0, staleRatifies: 0,
      idRefusals: 0, revBlocked: 0, staleAccepts: 0, forcedChanges: 0, g10Refusals: 0,
      restartsWithRunning: 0, deadAdopted: 0, checksAfterFinish: 0, applied: 0,
      mapChildren: 0, popChildren: 0, runEvals: 0, rewrites: 0, ratified: 0,
      orphansCancelled: 0, extended: 0, carriedDone: 0, parks: 0, capCloses: 0,
      gateShortcuts: 0,
      warmStarts: 0, coldStarts: 0, famRefusals: 0, repChanges: 0, canaryFails: 0,
      rejectVerdicts: 0, autoConts: 0, quietFails: 0, stalls: 0,
      famKills: 0, classRefusals: 0, autoRefusals: 0, autoOverOwner: 0, conflicts: 0,
      sameRewrites: 0, strikeVoids: 0, yesCommits: 0, judgeYes: 0, revivals: 0
    }
  }

  // ---------------------------------------------------------------- leader (only while awake)
  def leaderMay: bool = s.leader == Awake and s.phase == Live

  action wake = all {
    s.leader == Asleep, s.phase == Live, s.inbox > 0, moneyFree >= W,
    s' = { ...s, leader: Awake, mRes: s.mRes + W, inbox: 0, ownerQ: 0 }
  }

  action sleep = all {
    s.leader == Awake,
    nondet actual = 1.to(W).oneOf()
    s' = { ...s, leader: Asleep, mSpent: s.mSpent + actual, mRes: s.mRes - W }
  }

  def mk(sp: Spec, r: int, c: int, h: int, ar: bool, f: int, tf: int, ln: int, st: int): Node = { ...FREE,
    st: Pending, round: r, kind: sp.kind, cls: sp.cls,
    est: if (sp.kind == Gate or (sp.kind == Fan and not(ar))) 0 else sp.est,
    ev: if (sp.kind == Check) 1 else 0,
    objV: effV, crit: c, sha: h, src: sp.src, outList: sp.outList,
    arch: sp.kind == Fan and ar, gate: sp.gate,
    fam: if (usesCapacity(sp.kind)) f else 0,
    // A node with no declared family (an objective check of the integrated sha, a scan) is not an
    // idea evaluation: it classifies to no family. An earlier rev-3 draft classified every check
    // into a family, so one family's death refused about half of all objective checks and the
    // host-met witnesses went unreached; the fix is in the model AND the design (§3.4 classify).
    tfam: if (usesCapacity(sp.kind) and f > 0) tf else 0,
    lanes: if (sp.kind == Fan) ln else 0,
    seat: st }

  def graphOk(draft: int -> Node, ids: Set[int]): bool =
    ids.forall(n => draft.get(n).src == -1 or
      (draft.get(n).src != n and draft.get(draft.get(n).src).st != Free and
       not(ids.contains(draft.get(n).src) and draft.get(draft.get(n).src).src == n)))
  def typedOk(draft: int -> Node, ids: Set[int]): bool =
    ids.forall(n => draft.get(n).kind != Fan or draft.get(n).arch or
      (draft.get(n).src != -1 and draft.get(n).src != n and draft.get(draft.get(n).src).st != Free
        and draft.get(draft.get(n).src).outList))
  // V1's plan-time G11 check, kept: no planned node tests a dead family.
  def famOk(draft: int -> Node, ids: Set[int]): bool = ids.forall(n => not(dead(draft.get(n).fam)))

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
    // Shape bias (probabilities only; every shape is already in SPECS): 0 = two free nodes,
    // 1 = an agent and its check, 2 = a list-typed agent and a list fan over it. Without (2) a
    // list fan needs a random src that happens to be list-typed, and lane witnesses went unreached.
    nondet shape = 0.to(2).oneOf()
    nondet fa = 0.to(2).oneOf()
    nondet fb = 0.to(2).oneOf()
    nondet la = 1.to(2).oneOf()
    nondet lb = 1.to(2).oneOf()
    nondet sa = SEATS.oneOf()
    nondet sb = SEATS.oneOf()
    nondet ta = FAMS.oneOf()
    nondet tb = FAMS.oneOf()
    val r = s.curRound + 1
    val a2 = if (shape == 2) { ...a, kind: Work, outList: true } else a
    val b2 = if (shape == 1) { ...b, kind: Check, src: i }
             else if (shape == 2) { ...b, kind: Fan, src: i } else b
    val ab2 = if (shape == 2) false else ab
    val fb2 = if (shape == 1) fa else fb     // a check tests the family of the work it checks
    val tb2 = if (shape == 1) ta else tb     // ... and the work's diff classifies into one family
    val raw = if (two) s.nodes.set(i, mk(a2, r, ca, ha, aa, fa, ta, la, sa)).set(j, mk(b2, r, cb, hb, ab2, fb2, tb2, lb, sb))
              else s.nodes.set(i, mk(a2, r, ca, ha, aa, fa, ta, la, sa))
    val ids = if (two) Set(i, j) else Set(i)
    val draft = withCarry(raw, ids)
    val mistyped = ids.exists(n => draft.get(n).kind == Fan) and not(typedOk(draft, ids))
    if (graphOk(draft, ids) and typedOk(draft, ids) and famOk(draft, ids))
      s' = { ...s, nodes: draft, curRound: r, roundOpen: true, roundAt: s.work, roundExt: 0,
             wantPark: false }
    else
      s' = { ...s, mistypedRejects: s.mistypedRejects + (if (mistyped) 1 else 0),
             famRefusals: s.famRefusals + (if (famOk(draft, ids)) 0 else 1) }
  }

  action extendRound = all {
    leaderMay, s.roundOpen, s.roundExt < MAXEXT, freeSlots.size() >= 1,
    nondet i = freeSlots.oneOf()
    nondet a = SPECS.oneOf()
    nondet c = Set(1, 2).oneOf()
    nondet h = SHAS.oneOf()
    nondet ar = Set(true, false).oneOf()
    nondet f = 0.to(2).oneOf()
    nondet ln = 1.to(2).oneOf()
    nondet st = SEATS.oneOf()
    nondet tf = FAMS.oneOf()
    val draft = withCarry(s.nodes.set(i, mk(a, s.curRound, c, h, ar, f, tf, ln, st)), Set(i))
    if (graphOk(draft, Set(i)) and typedOk(draft, Set(i)) and famOk(draft, Set(i)))
      s' = { ...s, nodes: draft, extended: s.extended + 1, roundExt: s.roundExt + 1 }
    else
      s' = { ...s, mistypedRejects: s.mistypedRejects + (if (a.kind == Fan) 1 else 0) }
  }

  // reflect: the ONLY path for rewrite_meta and propose_finish in V2 (C10). The two-miss rule
  // (G10) refuses Continue/Revise; a Rewrite that drops a charter gate is refused (I6).
  action reflect = all {
    leaderMay, not(s.roundOpen), s.decs.length() < s.grades.length(),
    nondet d = Set(Continue, Revise, Rewrite, ProposeFin, Ask).oneOf()
    nondet g = ALL_GATES.powerset().oneOf()
    nondet slot = NODES.oneOf()
    nondet body = 0.to(2).oneOf()
    val fc = s.forcedChanges + (if (s.streak >= 2) 1 else 0)
    if (s.streak >= 2 and not(structural(d)))
      s' = { ...s, g10Refusals: s.g10Refusals + 1 }
    else if (d == Rewrite)
      if (not(CHARTER_GATES.subseteq(g)))
        s' = { ...s, gateDropRejects: s.gateDropRejects + 1 }
      // rev 3 (C10): a rewrite must change at least one non-done intent or graph (host diff
      // check); an identical rewrite satisfied G10 before (critique probe r_rewriteChanges).
      else if (body == s.bodies[s.bodies.length() - 1])
        s' = { ...s, sameRewrites: s.sameRewrites + 1 }
      else
        s' = { ...s, plans: s.plans.append(g), bodies: s.bodies.append(body), rewrites: s.rewrites + 1,
               decs: s.decs.append(d), autos: s.autos.append(false), streak: 0, forcedChanges: fc }
    else if (d == ProposeFin)
      s' = { ...s, proposed: true, propV: effV, decs: s.decs.append(d), autos: s.autos.append(false),
             streak: 0, forcedChanges: fc }
    else if (d == Ask)
      all { nd(slot).st == Free, not(s.answered.contains(ADHOC)),
            s' = { ...s, nodes: s.nodes.set(slot, { ...FREE, st: Waiting, round: s.curRound, kind: Gate,
                                                     gate: ADHOC, carried: true, objV: effV }),
                   wantPark: true, decs: s.decs.append(d), autos: s.autos.append(false), streak: 0,
                   forcedChanges: fc } }
    else
      s' = { ...s, decs: s.decs.append(d), autos: s.autos.append(false) }
  }

  action proposePatch = all {
    leaderMay,
    nondet n = NODES.oneOf()
    all { nd(n).st == Pending, s' = { ...s, patchProps: s.patchProps.union(Set((n, nd(n).rev))) } }
  }

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
    nondet ho = Set(true, false).oneOf()
    nondet cf = Set(true, false).oneOf()
    s' = endRoundState(met, ho, cf)
  }

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

  // ---------------------------------------------------------------- host
  action startNode = all {
    s.phase == Live,
    nondet n = NODES.oneOf()
    nondet kids = freeSlots.powerset().filter(k => k.size() <= 2).oneOf()
    nondet l = 0.to(1).oneOf()      // hoisted: a nondet inside a branch disables that branch
    val x = nd(n)
    val fanChild = x.parent != -1
    all {
      x.st == Pending, depOk(n), x.carried or (s.roundOpen and x.round == s.curRound),
      if (x.kind == Gate)
        if (s.answered.contains(x.gate))
          s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Done, startedRev: x.rev, starts: x.starts + 1 }),
                 everDone: s.everDone.union(Set(n)), gateShortcuts: s.gateShortcuts + 1 }
        else
          s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Waiting, startedRev: x.rev, starts: x.starts + 1 }) }
      else if (x.kind == Fan and not(x.arch))
        val withKids = NODES.mapBy(c =>
          if (kids.contains(c))
            { ...FREE, st: Pending, round: x.round, kind: Work, cls: Cpu, est: 1,
              objV: x.objV, parent: n, carried: x.carried, seat: x.seat }
          else if (c == n) { ...x, st: Done, startedRev: x.rev, starts: x.starts + 1 }
          else nd(c))
        s' = { ...s, nodes: withKids, everDone: s.everDone.union(Set(n)),
               mapChildren: s.mapChildren + kids.size() }
      else if (x.kind == Fan)
        all { x.est <= moneyFree,
              s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev, starts: x.starts + 1 }),
                     mRes: s.mRes + x.est } }
      else if (dead(spendFam(x)))
        // V2 (C3): planned while its family was alive, but it died before start (a sibling's
        // strike landed). V1 checked only at plan time and would start it (ablation A15). A check
        // is refused on its candidate's CLASSIFIED family (rev 3), not the declared one.
        s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Cancelled }), famRefusals: s.famRefusals + 1 }
      else all {
        x.est <= moneyFree, x.ev <= evFree,
        runningIn(x.cls) < capOf(x.cls), liveCount < MAXLIVE,
        // V2 (C1): a fan child runs in one of its fan's lanes, one item per lane at a time.
        if (fanChild) laneOk(x.parent, l) else true,
        val warm = fanChild and s.laneUsed.contains((x.parent, l))
        s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev,
                                              starts: x.starts + 1, lane: if (fanChild) l else -1,
                                              base: s.intV }),
               mRes: s.mRes + x.est, eRes: s.eRes + x.ev,
               laneUsed: if (fanChild) s.laneUsed.union(Set((x.parent, l))) else s.laneUsed,
               warmStarts: s.warmStarts + (if (warm) 1 else 0),
               coldStarts: s.coldStarts + (if (fanChild and not(warm)) 1 else 0) }
      }
    }
  }

  // carve: a running node funds a child from its own reservation (the ledger total is
  // unchanged). Three uses:
  //  - run_eval from an agent (Work): the child is a Check of the agent's family;
  //  - population generator from an open fan: the child is Work, runs in one of the fan's lanes,
  //    and DECLARES its family first (C3: refused if dead, before it spends);
  //  - population evaluation of a generated candidate: the child is a Check of that family.
  action carve = all {
    s.phase == Live,
    nondet p = NODES.oneOf()
    nondet c = NODES.oneOf()
    nondet cls = Set(Cpu, Gpu).oneOf()
    nondet cr = Set(1, 2).oneOf()
    nondet h = SHAS.oneOf()
    nondet f = FAMS.oneOf()
    nondet l = 0.to(1).oneOf()
    nondet gen = Set(true, false).oneOf()
    nondet tf = FAMS.oneOf()
    val x = nd(p)
    val fromWork = x.kind == Work
    val isCheck = fromWork or not(gen)
    val fam = if (fromWork) x.fam else f
    // rev 3 (C3): an evaluation runs under the family its committed diff is CLASSIFIED as (a cheap
    // one-key census judgment before the eval is carved), not the family the generator declared.
    // A generator's own declaration is a self-report; the sidecar relabel lives in that gap.
    val tfam = if (fromWork) x.tfam else if (isCheck) f else tf
    val guarded = if (isCheck) tfam else fam
    val warm = not(isCheck) and s.laneUsed.contains((p, l))
    all {
      x.st == Running, (x.kind == Work and x.est >= 2 and x.fam > 0) or (x.kind == Fan and x.arch and x.est >= 1),
      nd(c).st == Free,
      runningIn(cls) < capOf(cls), liveCount < MAXLIVE,
      if (isCheck) evFree >= 1 else true,
      if (isCheck) true else laneOk(p, l),
      if (dead(guarded))
        s' = { ...s, famRefusals: s.famRefusals + 1,
               classRefusals: s.classRefusals + (if (isCheck and not(dead(fam))) 1 else 0) }
      else
        s' = { ...s,
          nodes: s.nodes.set(p, { ...x, est: x.est - 1 })
                        .set(c, { ...FREE, st: Running, round: x.round, carried: x.carried,
                                  kind: if (isCheck) Check else Work, cls: cls, est: 1,
                                  ev: if (isCheck) 1 else 0, startedRev: 0, starts: 1,
                                  objV: x.objV, crit: cr, sha: h, parent: p, fam: fam, tfam: tfam,
                                  seat: x.seat, lane: if (isCheck) -1 else l, base: s.intV }),
          eRes: s.eRes + (if (isCheck) 1 else 0),
          laneUsed: if (isCheck) s.laneUsed else s.laneUsed.union(Set((p, l))),
          warmStarts: s.warmStarts + (if (warm) 1 else 0),
          coldStarts: s.coldStarts + (if (not(isCheck) and not(warm)) 1 else 0),
          runEvals: s.runEvals + (if (fromWork) 1 else 0),
          popChildren: s.popChildren + (if (isCheck) 0 else 1) }
    }
  }

  action popDone = all {
    nondet p = NODES.oneOf()
    val x = nd(p)
    all {
      x.st == Running, x.kind == Fan, x.arch,
      NODES.forall(c => nd(c).parent != p or isTerminal(nd(c).st)),
      s' = { ...s, nodes: s.nodes.set(p, { ...x, st: Done }), everDone: s.everDone.union(Set(p)),
             mRes: s.mRes - x.est, inbox: s.inbox + 1 }
    }
  }

  action complete = all {
    nondet n = NODES.oneOf()
    nondet actual = 1.to(3).oneOf()
    nondet ok = Set(true, false).oneOf()
    val x = nd(n)
    // rev 3 (C3): in a family with an evaluator, a failed check is the ONLY strike (an LLM reject
    // there is a verdict, not a strike). The family's death cancels its work in the same write.
    val strike = x.kind == Check and not(ok) and EVAL_FAMS.contains(x.tfam)
    val s1 = { ...s,
        nodes: s.nodes.set(n, { ...x, st: Done, pass: ok }),
        everDone: s.everDone.union(Set(n)),
        mSpent: s.mSpent + actual, mRes: s.mRes - x.est,
        eSpent: s.eSpent + x.ev, eRes: s.eRes - x.ev,
        carriedDone: s.carriedDone + (if (x.carried) 1 else 0),
        inbox: s.inbox + (if (x.carried and s.phase == Live) 1 else 0),
        checksAfterFinish: s.checksAfterFinish + (if (s.phase == Finished) 1 else 0),
        strikes: if (strike) s.strikes.union(Set((x.tfam, 0, n))) else s.strikes }
    all {
      x.st == Running, usesCapacity(x.kind), actual <= x.est,
      NODES.forall(c => nd(c).parent != n or isTerminal(nd(c).st)),
      s' = if (strike) killDead(s1) else s1
    }
  }

  // V2 (C8): only a `blocked` failure (or cannot_run / dead_on_adopt, same class) wakes the
  // leader. Ordinary failures (capped, malformed, turn_failed) are batched to the round close.
  action failNode = all {
    nondet n = NODES.oneOf()
    nondet actual = 1.to(3).oneOf()
    nondet blk = Set(true, false).oneOf()
    val x = nd(n)
    all {
      x.st == Running, usesCapacity(x.kind), actual <= x.est,
      s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Failed }),
        mSpent: s.mSpent + actual, mRes: s.mRes - x.est,
        eSpent: s.eSpent + x.ev, eRes: s.eRes - x.ev,
        inbox: s.inbox + (if (blk) 1 else 0),
        quietFails: s.quietFails + (if (blk) 0 else 1) }
    }
  }

  // V2 (C8): the `stalled` event replaces the periodic tick wake.
  action stall = all {
    s.phase == Live, NODES.exists(n => live(n) and nd(n).kind == Work),
    s' = { ...s, inbox: s.inbox + 1, stalls: s.stalls + 1 }
  }

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

  action closeRound = all {
    s.roundOpen,
    NODES.forall(n => not(member(n)) or isTerminal(nd(n).st) or nd(n).st == Waiting),
    nondet met = Set(true, false).oneOf()
    nondet ho = Set(true, false).oneOf()
    nondet cf = Set(true, false).oneOf()
    s' = closeState(met, ho, cf)
  }

  // V2 (C12): pre-planned rounds. The host records `continue` and opens the next pre-written
  // graph WITHOUT waking the leader, but only after a round that met every prediction and was
  // graded by the host alone (all predictions check-typed). Anything else waits for the leader.
  // rev 3: it yields to a queued owner event (critique probe r_autoNotOverOwnerMsg: a queued
  // "stop doing X" lost to the next pre-written round), and it runs plan_round's family check on
  // the pre-written graph: a graph naming a now-dead family is DROPPED and the leader wakes on the
  // roundDone already queued, instead of the node being discovered dead at start.
  action autoContinue = {
    nondet i = NODES.oneOf()
    nondet f = 0.to(2).oneOf()
    nondet tf = FAMS.oneOf()
    val k = s.decs.length()
    all {
      s.phase == Live, s.leader == Asleep, not(s.roundOpen), k < s.grades.length(),
      s.prePlanned > 0, s.curRound < MAXROUNDS, nd(i).st == Free,
      s.grades[k], s.hostOnly[k], s.ownerQ == 0,
      if (dead(f))
        s' = { ...s, prePlanned: s.prePlanned - 1, autoRefusals: s.autoRefusals + 1 }
      else
        s' = { ...s, decs: s.decs.append(Continue), autos: s.autos.append(true),
               prePlanned: s.prePlanned - 1, curRound: s.curRound + 1, roundOpen: true,
               roundAt: s.work, roundExt: 0, wantPark: false,
               nodes: s.nodes.set(i, { ...FREE, st: Pending, round: s.curRound + 1, kind: Work,
                                       est: 1, objV: effV, fam: f, tfam: if (f > 0) tf else 0 }),
               autoConts: s.autoConts + 1 }
    }
  }

  // The clock. V2 (C8): a tick never wakes the leader (V1 enqueued a wake every 30 min while
  // capacity work ran, each paying a cold prefix past the cache TTL).
  action tick = all {
    s.time < MAXTIME,
    nondet met = Set(true, false).oneOf()
    nondet ho = Set(true, false).oneOf()
    nondet cf = Set(true, false).oneOf()
    val t2 = s.time + 1
    val w2 = if (s.phase == Parked or s.phase == Finished) s.work else s.work + 1
    if (s.phase != Finished and (w2 >= s.deadline or t2 >= s.deadline + PARKMAX))
      s' = { ...finishWith(Deadline, Host, NoVerdict, 0, -1), time: t2, work: w2 }
    else if (s.phase != Finished and s.roundOpen and w2 - s.roundAt >= ROUNDMAX)
      s' = { ...closeState(met, ho, cf), time: t2, work: w2, capCloses: s.capCloses + 1 }
    else
      s' = { ...s, time: t2, work: w2 }
  }

  action hostFinishMet = {
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

  action park = all {
    s.phase == Live, s.wantPark, not(s.roundOpen), s.leader == Asleep, not(anyRunning),
    NODES.exists(n => nd(n).st == Waiting),
    s' = { ...s, phase: Parked, parks: s.parks + 1 }
  }

  action closeReport = all {
    s.phase == Finished, not(s.reported),
    nondet a = 1.to(CLOSE).oneOf()
    s' = { ...s, reported: true, mSpent: s.mSpent + a }
  }

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

  // ---------------------------------------------------------------- judges (V2 C4)
  // One key to say no (rev 3): one calibrated panel judge on a provider OTHER than the producer's
  // writes a verdict on a done node of a family. Its reject is a strike only in a family with no
  // evaluator (EVAL_FAMS: there only failed checks strike). A strike that kills the family
  // cancels the family's work in the same write. Judgment continues after finish (it is not work).
  action judgeVerdict = {
    nondet n = NODES.oneOf()
    nondet j = JUDGES.oneOf()
    nondet rej = Set(true, false).oneOf()
    val x = nd(n)
    val strike = rej and not(EVAL_FAMS.contains(x.fam))
    val s1 = { ...s, judged: s.judged.union(Set(n)), verdictLog: s.verdictLog.union(Set((n, j))),
               strikes: if (strike) s.strikes.union(Set((x.fam, j, n))) else s.strikes,
               rejectVerdicts: s.rejectVerdicts + (if (rej) 1 else 0) }
    all {
      x.st == Done, x.fam > 0, usesCapacity(x.kind), not(s.judged.contains(n)),
      not(s.uncal.contains(j)), j != prov(x.seat),
      s' = if (strike) killDead(s1) else s1
    }
  }

  // Two keys to say yes on a representation change (no producer): two DISTINCT calibrated judges.
  // The second vote commits and clears the family's strikes.
  action repVote = {
    nondet f = FAMS.oneOf()
    nondet j = JUDGES.oneOf()
    val other = JUDGES.exclude(Set(j)).filter(k => s.votes.contains((f, k)))
    all {
      dead(f), not(s.uncal.contains(j)), not(s.votes.contains((f, j))),
      if (other.size() > 0)
        val k = other.fold(0, (a, b) => b)
        s' = { ...s, strikes: s.strikes.filter(st => st._1 != f),
               votes: s.votes.exclude(Set((f, j), (f, k))),
               repLog: s.repLog.union(Set((f, j, k, s.seq))), seq: s.seq + 1,
               repChanges: s.repChanges + 1 }
      else
        s' = { ...s, votes: s.votes.union(Set((f, j))), seq: s.seq + 1 }
    }
  }

  // rev 3 (C4): two keys to say yes on a PRODUCED node (keep / promote / verified). A key is a
  // calibrated judge on a provider other than the producer's, a passing check on the node, or the
  // owner. With two providers exactly one judge is eligible for any producer, so V2's "two judges,
  // neither the producer's seat" could never commit; the second key is a check or the owner.
  def keyOk(n: int, k: int): bool =
    if (k == CHECK_KEY)
      NODES.exists(c => nd(c).kind == Check and nd(c).st == Done and nd(c).pass and
                        (nd(c).src == n or nd(c).parent == n))
    else if (k == OWNER_KEY) true
    else k != prov(nd(n).seat) and not(s.uncal.contains(k))
  def castYes(n: int, k: int): S =
    val others = s.yesVotes.filter(v => v._1 == n and v._2 != k)
    if (others.size() > 0)
      val k2 = others.fold(0, (a, v) => v._2)
      { ...s, yesVotes: s.yesVotes.filter(v => v._1 != n), yesDone: s.yesDone.union(Set(n)),
        yesLog: s.yesLog.union(Set((n, k2, k, s.seq))), seq: s.seq + 1, yesCommits: s.yesCommits + 1,
        judgeYes: s.judgeYes + (if (k <= 2 or k2 <= 2) 1 else 0) }
    else { ...s, yesVotes: s.yesVotes.union(Set((n, k))), seq: s.seq + 1 }
  def yesOpen(n: int, k: int): bool =
    nd(n).st == Done and nd(n).kind == Work and nd(n).fam > 0 and not(s.yesDone.contains(n)) and
    not(s.yesVotes.contains((n, k))) and keyOk(n, k)
  action yesVote = {
    nondet n = NODES.oneOf()
    nondet k = Set(1, 2, CHECK_KEY).oneOf()
    all { yesOpen(n, k), s' = castYes(n, k) }
  }
  action ownerYes = {
    nondet n = NODES.oneOf()
    all { yesOpen(n, OWNER_KEY), s' = castYes(n, OWNER_KEY) }
  }

  // A canary is a known-answer item from the OWNER's set (rev 3: no repo-derived canaries). A miss
  // marks the judge uncalibrated (its later judgments are refused) and VOIDS its pending votes, its
  // pending yes keys AND its strikes (rev 3): a family it killed is alive again until calibrated
  // evidence kills it. This is what G16's "stops counting" means.
  action canary = {
    nondet j = JUDGES.oneOf()
    nondet roll = 1.to(4).oneOf()
    all {
      not(s.uncal.contains(j)),
      if (roll > 1)
        s' = { ...s, seq: s.seq + 1 }
      else
        s' = { ...s, uncal: s.uncal.union(Set(j)), failedAt: s.failedAt.set(j, s.seq),
               votes: s.votes.filter(v => v._2 != j), yesVotes: s.yesVotes.filter(v => v._2 != j),
               strikes: s.strikes.filter(st => st._2 != j),
               strikeVoids: s.strikeVoids + s.strikes.filter(st => st._2 == j).size(),
               revivals: s.revivals + FAMS.filter(f => dead(f) and
                 s.strikes.filter(st => st._1 == f and st._2 != j).size() < STRIKES).size(),
               seq: s.seq + 1, canaryFails: s.canaryFails + 1 }
    }
  }

  // ---------------------------------------------------------------- owner
  action ownerPause = all { s.phase == Live, s' = { ...s, phase: Paused } }
  action ownerResume = all { s.phase == Paused or s.phase == Parked,
                             s' = { ...s, phase: Live, wantPark: false } }
  action ownerStop = all { s.phase != Finished, s' = finishWith(Stopped, Owner, NoVerdict, 0, -1) }
  action ownerExtend = all {
    s.phase != Finished, s.extends < 2,
    s' = { ...s, deadline: s.deadline + 4, mBudget: s.mBudget + 4, extends: s.extends + 1 }
  }
  action ownerMsg = all { s.phase != Finished, s' = { ...s, inbox: s.inbox + 1, ownerQ: s.ownerQ + 1 } }
  action ownerCancel = all {
    nondet n = NODES.oneOf()
    nondet a = 0.to(3).oneOf()
    all { s.phase != Finished,
          nd(n).st == Pending or nd(n).st == Running or nd(n).st == Waiting,
          s' = { ...cancelNode(n, a), inbox: s.inbox + 1, ownerQ: s.ownerQ + 1 } }
  }
  action ownerEndRound = all {
    s.phase != Finished, s.roundOpen,
    nondet met = Set(true, false).oneOf()
    nondet ho = Set(true, false).oneOf()
    nondet cf = Set(true, false).oneOf()
    s' = endRoundState(met, ho, cf)
  }
  action ownerPatch = all {
    s.phase != Finished,
    nondet n = NODES.oneOf()
    nondet newEst = 1.to(3).oneOf()
    all { nd(n).st == Pending,
          s' = { ...s, applied: s.applied + 1, inbox: s.inbox + 1, ownerQ: s.ownerQ + 1,
                 nodes: s.nodes.set(n, { ...nd(n), rev: nd(n).rev + 1,
                   est: if (nd(n).kind == Work or nd(n).kind == Check) newEst else nd(n).est }) } }
  }
  action answerGate = all {
    nondet g = ALL_GATES.oneOf()
    all { not(s.answered.contains(g)),
          s' = { ...s, answered: s.answered.union(Set(g)),
                 everDone: s.everDone.union(NODES.filter(n => nd(n).st == Waiting and nd(n).gate == g)),
                 nodes: NODES.mapBy(n => if (nd(n).st == Waiting and nd(n).gate == g)
                                           { ...nd(n), st: Done } else nd(n)),
                 phase: if (s.phase == Parked) Live else s.phase,
                 wantPark: if (s.phase == Parked) false else s.wantPark,
                 inbox: s.inbox + (if (s.phase != Finished) 1 else 0),
                 ownerQ: s.ownerQ + (if (s.phase != Finished) 1 else 0) } }
  }
  action ownerRead = all {
    s.pend.active,
    s' = { ...s, seen: { valid: true, base: s.pend.base, id: s.pend.id, crit: s.pend.crit } }
  }
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

  // Weighted for simulation depth (quint run picks uniformly among enabled branches).
  action leaderStep = any {
    wake, sleep, planRound, planRound, extendRound, reflect, reflect, proposePatch, commitPatch,
    leaderCancel, leaderEndRound, reviseObjective
  }
  action hostStep = any {
    startNode, startNode, carve, carve, popDone, complete, complete, failNode, stall, cancelOrphan,
    closeRound, closeRound, autoContinue, autoContinue, hostFinishMet, hostFinishMet, hostFinishMet,
    exhaust, park, closeReport, restart
  }
  action judgeStep = any { judgeVerdict, judgeVerdict, judgeVerdict, repVote, repVote, yesVote, yesVote, canary }
  action ownerStep = any {
    ownerPause, ownerResume, ownerStop, ownerExtend, ownerMsg, ownerCancel,
    ownerEndRound, ownerPatch, answerGate, answerGate, answerGate, answerGate, ownerRead, ownerRead,
    ratify, ratify, rejectRevision, ownerAccept, ownerAccept, ownerReject, ownerYes
  }
  action step = any {
    leaderStep, leaderStep, leaderStep, leaderStep, hostStep, hostStep, hostStep, hostStep,
    judgeStep, judgeStep, tick, tick, ownerStep
  }
  // A SUBSET of step's transitions (no owner stop/cancel/end/pause): every state it reaches is
  // reachable by `step`; it only changes probabilities, for the rarest witnesses.
  action stepReach = any {
    leaderStep, leaderStep, hostStep, hostStep, hostStep, hostStep, hostStep, hostStep,
    judgeStep, judgeStep, tick, answerGate, answerGate, ownerRead, ratify, rejectRevision, ownerAccept
  }
  // Reachability aid for w_noHostMetMulti (two passing checks of different criteria on ONE sha
  // under the current version, an answered gate, mode OnMet). A subset of step's transitions.
  action stepMet = any {
    planRound, planRound, planRound, reflect, reflect, wake, sleep, startNode, startNode,
    complete, complete, complete, closeRound, answerGate, hostFinishMet, hostFinishMet, tick
  }
  // V2 reachability aid for the family/lane witnesses and ablations (dead family, refusal, rep
  // change, warm lane): again a SUBSET of step's transitions, weighted toward planning, starting,
  // carving, completing and judging. Fewer ticks and no owner acts except the owner's yes key
  // (rev 3), so traces live long enough for two strikes to land while slots remain.
  action stepFam = any {
    planRound, planRound, reflect, reflect, wake, sleep,
    startNode, startNode, startNode, carve, carve, carve, complete, complete, complete, closeRound,
    judgeVerdict, judgeVerdict, judgeVerdict, judgeVerdict, repVote, repVote, canary, tick,
    yesVote, yesVote, ownerYes, autoContinue
  }

  // ---------------------------------------------------------------- safety invariants (V1)
  val doneImmutable = s.everDone.forall(n => nd(n).st == Done)
  val budgetSafe = all {
    s.mSpent + s.mRes <= s.mBudget,
    s.phase == Finished or s.mSpent + s.mRes <= s.mBudget - CLOSE,
    s.eSpent + s.eRes <= s.eBudget,
    s.mRes >= 0, s.eRes >= 0
  }
  val ledgerExact = all {
    s.mRes == NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).est)
              + (if (s.leader == Awake) W else 0),
    s.eRes == NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).ev)
  }
  val capacity = all {
    liveCount <= MAXLIVE, runningIn(Gpu) <= GPU_CAP, runningIn(Cpu) <= CPU_CAP,
    NODES.forall(n => nd(n).st == Running implies (usesCapacity(nd(n).kind) or (nd(n).kind == Fan and nd(n).arch)))
  }
  val specFrozen = NODES.forall(n =>
    (nd(n).st == Running or (nd(n).st == Done and nd(n).kind != Gate) or nd(n).st == Failed)
      implies nd(n).rev == nd(n).startedRev)
  val typedFanout = NODES.forall(n => (nd(n).st != Free and nd(n).kind == Fan and not(nd(n).arch)) implies
    (nd(n).src != -1 and nd(nd(n).src).outList))
  val gatesKept = all {
    s.plans.foldl(true, (ok, p) => ok and CHARTER_GATES.subseteq(p)),
    (s.reason == Met and s.by == Host) implies CHARTER_GATES.subseteq(s.answered)
  }
  val metOneSha = (s.reason == Met and s.by == Host) implies all {
    s.mode == OnMet, s.metV == effV, certified(s.metV, s.metSha)
  }
  val ownerMetCurrent = (s.reason == Met and s.by == Owner) implies (s.propV == effV and s.metV == effV)
  val objectiveFidelity = 1.to(s.objs.length() - 1).forall(i =>
    s.objs[i].against == i - 1 and
    (s.objs[i - 1].crit.subseteq(s.objs[i].crit) or s.objs[i].byOwner))
  val v0Signed = s.objs[0].byOwner and s.objs[0].against == -1
  val ratifiedAsSeen = 1.to(s.objs.length() - 1).forall(i => s.objs[i].byOwner implies s.objs[i].crit == s.objs[i].seen)
  val terminates = s.work >= s.deadline implies s.phase == Finished
  val hardStop = s.time >= s.deadline + PARKMAX implies s.phase == Finished
  val noWorkAfterFinish = s.phase == Finished implies all {
    NODES.forall(n => nd(n).st == Running implies nd(n).kind == Check),
    NODES.forall(n => nd(n).st != Pending),
    s.leader == Asleep
  }
  val noRerun = NODES.forall(n => nd(n).starts <= 1)
  val leaderBounded = s.phase == Finished implies s.leader == Asleep
  val noDeadGate = NODES.forall(n => nd(n).st == Waiting implies not(s.answered.contains(nd(n).gate)))
  val gateFree = NODES.forall(n => (nd(n).st == Pending and not(nd(n).carried) and nd(n).src != -1)
    implies not(nd(nd(n).src).kind == Gate or nd(nd(n).src).carried))
  val roundBounded = s.roundOpen implies s.work - s.roundAt < ROUNDMAX
  val extendBounded = s.roundExt <= MAXEXT
  val g10 =
    val n = s.decs.length()
    range(0, n).foldl((true, 0), (acc, i) =>
      val st = if (s.grades[i]) 0 else acc._2 + 1
      val ok = acc._1 and (st >= 2 implies structural(s.decs[i]))
      (ok, if (structural(s.decs[i])) 0 else st))._1
  val reflected = s.curRound <= s.decs.length() + 1

  // ---------------------------------------------------------------- safety invariants (V2)
  // C3 (rev 3): nothing of a dead family is ever RUNNING: work under its declared family, an
  // evaluation under its candidate's classified family. Not a restated guard: it is broken by a
  // start/carve without the check (A15, A16, A27) AND by a strike without the cancel (A22), which
  // are different actions. V2's `noDeadSpend` ghost was written only inside the not-dead branch,
  // so it was constant-true on the real step (critique).
  val noDeadRunning = NODES.forall(n => (nd(n).st == Running and usesCapacity(nd(n).kind))
    implies not(dead(spendFam(nd(n)))))
  // C3/G16 (rev 3): every live strike comes from calibrated evidence of the right kind: a check in
  // a family with an evaluator, a still-calibrated judge in a family without one. Broken by a
  // canary miss that keeps strikes (A23) or a judge striking an evaluator family (A24).
  val strikesCalibrated = s.strikes.forall(st =>
    if (EVAL_FAMS.contains(st._1)) st._2 == 0 else (st._2 > 0 and not(s.uncal.contains(st._2))))
  // C4 (rev 3): every committed yes on a produced node has two distinct keys; a judge key is on a
  // provider other than the producer's and had not failed a canary before the commit. A26.
  val twoKeyYes = s.yesLog.forall(r => r._2 != r._3 and
    Set(r._2, r._3).forall(k => k > 2 or (k != prov(nd(r._1).seat) and s.failedAt.get(k) > r._4)))
  // C15 (rev 3): a node started in round r was reset to an integration head that includes every
  // candidate merged at the close of an earlier round (waves stack). A25 = V2's "reset to base".
  val stackedBase = NODES.forall(n => (nd(n).starts > 0 and nd(n).kind == Work) implies
    nd(n).base >= s.merged.filter(m => m._2 < nd(n).round).size())
  // C10 (rev 3): consecutive meta-plan versions differ. (restates guard; A6 breaks it)
  val rewriteChanges = 1.to(s.bodies.length() - 1).forall(i => s.bodies[i] != s.bodies[i - 1])
  // C12 (rev 3): the host never auto-continues over a queued owner event. (restates guard; A21)
  val autoYieldsToOwner = s.autoOverOwner == 0
  // C4: every committed representation change carries two DISTINCT judges, neither of which had
  // failed a canary before the commit. Computed from the logs, not from the vote guard.
  val twoKey = s.repLog.forall(r =>
    r._2 != r._3 and s.failedAt.get(r._2) > r._4 and s.failedAt.get(r._3) > r._4)
  // C4: no verdict is written by the seat that produced the judged node. (restates guard)
  val noSelfJudge = s.verdictLog.forall(v => v._2 != prov(nd(v._1).seat))
  // C1: a lane runs one item at a time.
  val laneSerial = NODES.forall(p => 0.to(1).forall(l =>
    NODES.filter(c => nd(c).parent == p and nd(c).lane == l and nd(c).st == Running).size() <= 1))
  // C1: cold session starts are bounded by the lanes declared, not by the number of items.
  val coldBound = s.coldStarts <=
    NODES.filter(n => nd(n).kind == Fan and nd(n).st != Free).fold(0, (a, n) => a + nd(n).lanes)
  // C12: the host only auto-continues after a met, host-graded round.
  val autoOnlyOnMet = range(0, s.decs.length()).foldl(true, (ok, i) => ok and (s.autos[i] implies (s.grades[i] and s.hostOnly[i])))

  val safety = all {
    doneImmutable, budgetSafe, ledgerExact, capacity, specFrozen, typedFanout, gatesKept,
    metOneSha, ownerMetCurrent, objectiveFidelity, v0Signed, ratifiedAsSeen, terminates, hardStop,
    noWorkAfterFinish, noRerun, leaderBounded, noDeadGate, gateFree, roundBounded, extendBounded,
    g10, reflected,
    noDeadRunning, strikesCalibrated, twoKey, twoKeyYes, noSelfJudge, laneSerial, coldBound,
    autoOnlyOnMet, stackedBase, rewriteChanges, autoYieldsToOwner
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
  // V2
  val w_noWarmLane = s.warmStarts == 0
  val w_noVerdict = s.verdictLog.size() == 0
  val w_noDeadFamily = FAMS.forall(f => not(dead(f)))
  val w_noFamilyRefusal = s.famRefusals == 0
  val w_noRepChange = s.repChanges == 0
  val w_noCanaryFail = s.canaryFails == 0
  val w_noVoidedVote = not(s.canaryFails > 0 and s.repChanges == 0 and s.seq >= 3)
  val w_noAutoContinue = s.autoConts == 0
  val w_noQuietFail = s.quietFails == 0
  val w_noStall = s.stalls == 0
  // rev 3
  val w_noYes = s.yesCommits == 0                       // a two-key yes on a produced node commits
  val w_noJudgeYes = s.judgeYes == 0                    // ... with a cross-provider judge as one key
  val w_noFamKill = s.famKills == 0                     // a death cancelled live work of the family
  val w_noClassRefusal = s.classRefusals == 0           // an eval refused on its classified family
  val w_noStrikeVoid = s.strikeVoids == 0               // a canary miss voided a strike
  val w_noRevival = s.revivals == 0                     // a canary miss revived a dead family
  val w_noStack = NODES.forall(n => not(nd(n).starts > 0 and nd(n).base > 0))
  val w_noConflict = s.conflicts == 0
  val w_noAutoRefusal = s.autoRefusals == 0
  val w_noSameRewrite = s.sameRewrites == 0
  // diagnostic for w_noClassRefusal / A27: the precondition (a running work node whose declared
  // family lives while its classified family is dead) is reachable at all.
  val w_noRelabelled = not(NODES.exists(n => nd(n).st == Running and nd(n).kind == Work and
    nd(n).fam > 0 and not(dead(nd(n).fam)) and dead(nd(n).tfam)))

  // ---------------------------------------------------------------- guard ablations
  // Each removes ONE guard; run the named invariant with --step=<ablation>; it MUST be violated.

  // A1 (I3): a node ends one message past its reservation. Expect budgetSafe violated.
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

  // A3 (I8): ratify without the base check. Expect objectiveFidelity violated.
  action ratifyBlind = all {
    s.phase != Finished, s.pend.active, s.seen.valid, s.seen.id == s.pend.id,
    s' = { ...s, objs: s.objs.append({ crit: s.pend.crit, byOwner: true, against: s.pend.base, seen: s.seen.crit }),
           pend: { ...s.pend, active: false }, ratified: s.ratified + 1 }
  }
  action stepBlindRatify = any { step, ratifyBlind }

  // A5 (I11): restart does NOT adopt. Expect noRerun violated.
  action restartNoAdopt = all {
    s' = { ...s, leader: Asleep, patchProps: Set(),
           mSpent: s.mSpent + (if (s.leader == Awake) W else 0)
                   + NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).est),
           mRes: 0, eRes: 0,
           eSpent: s.eSpent + NODES.filter(n => nd(n).st == Running).fold(0, (a, n) => a + nd(n).ev),
           nodes: NODES.mapBy(n => if (nd(n).st == Running) { ...nd(n), st: Pending } else nd(n)) }
  }
  action stepNoAdopt = any { step, restartNoAdopt }

  // A6 (I6): a reflection's Rewrite accepted without the gate check. Expect gatesKept violated.
  action reflectBlindRewrite = all {
    leaderMay, not(s.roundOpen), s.decs.length() < s.grades.length(), s.streak < 2,
    nondet g = ALL_GATES.powerset().oneOf()
    nondet body = 0.to(2).oneOf()
    s' = { ...s, plans: s.plans.append(g), bodies: s.bodies.append(body), rewrites: s.rewrites + 1,
           decs: s.decs.append(Rewrite), autos: s.autos.append(false), streak: 0 }
  }
  action stepBlindRewrite = any { step, reflectBlindRewrite }

  // A8 (I7a): one passing current check finishes. Expect metOneSha violated.
  action hostFinishAnyPass = all {
    s.phase == Live, s.mode == OnMet, CHARTER_GATES.subseteq(s.answered),
    not(eff.crit.contains(OWNER_CRIT)),
    NODES.exists(n => nd(n).kind == Check and nd(n).st == Done and nd(n).pass and nd(n).objV == effV),
    s' = finishWith(Met, Host, Accepted, 1, effV)
  }
  action stepAnyPassFinish = any { step, hostFinishAnyPass }

  // A11 (I20/G10): reflect without the two-miss rule.
  action reflectNoG10 = all {
    leaderMay, not(s.roundOpen), s.decs.length() < s.grades.length(),
    nondet d = Set(Continue, Revise).oneOf()
    s' = { ...s, decs: s.decs.append(d), autos: s.autos.append(false) }
  }
  action stepNoG10 = any { step, reflectNoG10 }

  // A15 (C3, V1's hole): start a planned node without re-checking its family. V1 checked
  // families only in plan_round, so a node planned while its family was alive started after a
  // sibling's second reject. Expect noDeadRunning violated.
  action startNoRecheck = all {
    s.phase == Live,
    nondet n = NODES.oneOf()
    val x = nd(n)
    all {
      x.st == Pending, usesCapacity(x.kind), x.parent == -1, dead(spendFam(x)), depOk(n),
      x.carried or (s.roundOpen and x.round == s.curRound),
      x.est <= moneyFree, x.ev <= evFree, runningIn(x.cls) < capOf(x.cls), liveCount < MAXLIVE,
      s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev, starts: x.starts + 1,
                                            base: s.intV }),
             mRes: s.mRes + x.est, eRes: s.eRes + x.ev }
    }
  }
  // rev 3: since a death cancels the family's PENDING nodes too (killDead), no pending node of a
  // dead family survives a strike, so the start-time recheck alone is redundant in the model (an
  // atomic step cannot race a strike against a start). A15 therefore ablates V1 as a whole: no
  // start recheck AND strikes that cancel nothing (judgeStrikeNoCancel, defined with A22). The
  // start check stays in the design as defence in depth for the real, non-atomic scheduler.
  // The reach step drops repVote (it resets strikes), carve and canary. A subset of step + A15.
  action stepRecheckBase = any {
    planRound, planRound, reflect, reflect, wake, sleep, startNode, startNode, complete, complete,
    closeRound, judgeVerdict, judgeVerdict, judgeVerdict, judgeVerdict, tick
  }
  action stepNoRecheck = any {
    planRound, planRound, reflect, reflect, wake, sleep, startNode, startNode, complete, complete,
    closeRound, judgeStrikeNoCancel, judgeStrikeNoCancel, judgeStrikeNoCancel, tick,
    startNoRecheck, startNoRecheck
  }
  // A15b: the start recheck alone removed (strikes still cancel). Expected to HOLD: recorded as
  // evidence that the recheck is redundant in the model, not as a guard ablation.
  action stepNoRecheckOnly = any { stepRecheckBase, startNoRecheck, startNoRecheck }

  // A16 (C3): a population carves a generator without its declared family being checked (V1's
  // host-refilled population: children were never checked against the graveyard). Expect
  // noDeadRunning violated.
  action carveNoDeclare = all {
    s.phase == Live,
    nondet p = NODES.oneOf()
    nondet c = NODES.oneOf()
    nondet f = FAMS.oneOf()
    val x = nd(p)
    all {
      x.st == Running, x.kind == Fan, x.arch, x.est >= 1, nd(c).st == Free, dead(f),
      runningIn(Cpu) < CPU_CAP, liveCount < MAXLIVE,
      s' = { ...s,
        nodes: s.nodes.set(p, { ...x, est: x.est - 1 })
                      .set(c, { ...FREE, st: Running, round: x.round, carried: x.carried, kind: Work,
                                cls: Cpu, est: 1, startedRev: 0, starts: 1, objV: x.objV, parent: p,
                                fam: f, tfam: f, seat: x.seat, lane: -1, base: s.intV }),
        popChildren: s.popChildren + 1 }
    }
  }
  action stepNoDeclare = any { stepDeath, carveNoDeclare, carveNoDeclare }

  // A17 (C4): a representation change commits on ONE judge's vote. Expect twoKey violated.
  action repVoteOneKey = {
    nondet f = FAMS.oneOf()
    nondet j = JUDGES.oneOf()
    all {
      dead(f), not(s.uncal.contains(j)),
      s' = { ...s, strikes: s.strikes.filter(st => st._1 != f), repLog: s.repLog.union(Set((f, j, j, s.seq))),
             seq: s.seq + 1, repChanges: s.repChanges + 1 }
    }
  }
  action stepOneKey = any { stepFam, repVoteOneKey }

  // A18 (C4): a failed canary does NOT void the judge's pending votes; the stale vote later
  // completes a representation change. Expect twoKey violated.
  action canaryNoVoid = {
    nondet j = JUDGES.oneOf()
    all {
      not(s.uncal.contains(j)), s.votes.exists(v => v._2 == j),
      s' = { ...s, uncal: s.uncal.union(Set(j)), failedAt: s.failedAt.set(j, s.seq), seq: s.seq + 1,
             canaryFails: s.canaryFails + 1 }
    }
  }
  action stepCanaryNoVoid = any { stepFam, canaryNoVoid, canaryNoVoid }

  // A19 (C1): a fan child starts without the lane-busy check. Expect laneSerial violated.
  action startLaneBlind = all {
    s.phase == Live,
    nondet n = NODES.oneOf()
    nondet l = 0.to(1).oneOf()
    val x = nd(n)
    all {
      x.st == Pending, x.kind == Work, x.parent != -1, l < nd(x.parent).lanes,
      x.carried or (s.roundOpen and x.round == s.curRound),
      x.est <= moneyFree, runningIn(x.cls) < capOf(x.cls), liveCount < MAXLIVE,
      s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev, starts: x.starts + 1, lane: l }),
             mRes: s.mRes + x.est, laneUsed: s.laneUsed.union(Set((x.parent, l))) }
    }
  }
  action stepLaneBlind = any { stepFam, startLaneBlind, startLaneBlind }

  // A20 (C1): V1's behaviour, a fresh session per fan child (its own lane). Expect coldBound
  // violated once a fan has more children than lanes.
  action startFreshSession = all {
    s.phase == Live,
    nondet n = NODES.oneOf()
    val x = nd(n)
    all {
      x.st == Pending, x.kind == Work, x.parent != -1,
      x.carried or (s.roundOpen and x.round == s.curRound),
      x.est <= moneyFree, runningIn(x.cls) < capOf(x.cls), liveCount < MAXLIVE,
      s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev, starts: x.starts + 1, lane: 10 + n }),
             mRes: s.mRes + x.est, coldStarts: s.coldStarts + 1 }
    }
  }
  action stepFreshSession = any { stepFam, startFreshSession, startFreshSession }

  // A21 (C12): the host auto-continues after ANY grade. Expect autoOnlyOnMet violated.
  action autoContinueAny = {
    nondet i = NODES.oneOf()
    all {
      s.phase == Live, s.leader == Asleep, not(s.roundOpen), s.decs.length() < s.grades.length(),
      s.prePlanned > 0, s.curRound < MAXROUNDS, nd(i).st == Free,
      s' = { ...s, decs: s.decs.append(Continue), autos: s.autos.append(true),
             prePlanned: s.prePlanned - 1, curRound: s.curRound + 1, roundOpen: true,
             roundAt: s.work, roundExt: 0,
             nodes: s.nodes.set(i, { ...FREE, st: Pending, round: s.curRound + 1, kind: Work,
                                     est: 1, objV: effV }),
             autoConts: s.autoConts + 1, autoOverOwner: s.autoOverOwner + (if (s.ownerQ > 0) 1 else 0) }
    }
  }
  action stepAutoAny = any { step, autoContinueAny }

  // ---------------------------------------------------------------- rev 3 ablations
  // A22 (C3): a strike lands WITHOUT cancelling the family's live work. Expect noDeadRunning.
  action judgeStrikeNoCancel = {
    nondet n = NODES.oneOf()
    nondet j = JUDGES.oneOf()
    val x = nd(n)
    all {
      x.st == Done, x.fam > 0, not(EVAL_FAMS.contains(x.fam)), usesCapacity(x.kind),
      not(s.judged.contains(n)), not(s.uncal.contains(j)), j != prov(x.seat),
      s' = { ...s, judged: s.judged.union(Set(n)), verdictLog: s.verdictLog.union(Set((n, j))),
             strikes: s.strikes.union(Set((x.fam, j, n))), rejectVerdicts: s.rejectVerdicts + 1 }
    }
  }
  action stepStrikeNoCancel = any { stepFam, judgeStrikeNoCancel, judgeStrikeNoCancel }

  // A23 (G16): a canary miss voids votes but KEEPS the judge's strikes (V2 as written).
  // Expect strikesCalibrated violated.
  action canaryKeepStrikes = {
    nondet j = JUDGES.oneOf()
    all {
      not(s.uncal.contains(j)), s.strikes.exists(st => st._2 == j),
      s' = { ...s, uncal: s.uncal.union(Set(j)), failedAt: s.failedAt.set(j, s.seq),
             votes: s.votes.filter(v => v._2 != j), yesVotes: s.yesVotes.filter(v => v._2 != j),
             seq: s.seq + 1, canaryFails: s.canaryFails + 1 }
    }
  }
  action stepCanaryKeepStrikes = any { stepFam, canaryKeepStrikes, canaryKeepStrikes }

  // A24 (C3): a judge reject strikes a family that HAS an evaluator (V2 as written: one LLM key
  // kills a measurable idea). Expect strikesCalibrated violated.
  action judgeStrikesEval = {
    nondet n = NODES.oneOf()
    nondet j = JUDGES.oneOf()
    val x = nd(n)
    all {
      x.st == Done, EVAL_FAMS.contains(x.fam), usesCapacity(x.kind), not(s.judged.contains(n)),
      not(s.uncal.contains(j)), j != prov(x.seat),
      s' = killDead({ ...s, judged: s.judged.union(Set(n)), verdictLog: s.verdictLog.union(Set((n, j))),
                      strikes: s.strikes.union(Set((x.fam, j, n))), rejectVerdicts: s.rejectVerdicts + 1 })
    }
  }
  action stepJudgeStrikesEval = any { stepFam, judgeStrikesEval, judgeStrikesEval }

  // A25 (C15): a node's tree is reset to the charter base, not the integration head (V2's "each
  // item resets its lane tree to base"). Expect stackedBase violated once a round merged.
  action startStaleBase = all {
    s.phase == Live,
    nondet n = NODES.oneOf()
    val x = nd(n)
    all {
      x.st == Pending, x.kind == Work, x.parent == -1, depOk(n), not(dead(x.fam)),
      x.carried or (s.roundOpen and x.round == s.curRound),
      x.est <= moneyFree, runningIn(x.cls) < capOf(x.cls), liveCount < MAXLIVE,
      s' = { ...s, nodes: s.nodes.set(n, { ...x, st: Running, startedRev: x.rev, starts: x.starts + 1, base: 0 }),
             mRes: s.mRes + x.est }
    }
  }
  action stepStaleBase = any { stepFam, startStaleBase, startStaleBase }

  // A26 (C4): a yes key from the producer's own provider counts (V2's tier-level "seat").
  // Expect twoKeyYes violated.
  action yesSameProvider = {
    nondet n = NODES.oneOf()
    val k = prov(nd(n).seat)
    all {
      nd(n).st == Done, nd(n).kind == Work, nd(n).fam > 0, not(s.yesDone.contains(n)),
      not(s.yesVotes.contains((n, k))), not(s.uncal.contains(k)),
      s' = castYes(n, k)
    }
  }
  action stepYesSameProvider = any { stepFam, yesSameProvider, yesSameProvider }

  // A27 (C3): the eval of a committed candidate is checked against the DECLARED family only
  // (V2's `declare`). A relabelled candidate of a dead family gets evaluated. Expect noDeadRunning.
  action carveDeclaredOnly = all {
    s.phase == Live,
    nondet p = NODES.oneOf()
    nondet c = NODES.oneOf()
    val x = nd(p)
    all {
      x.st == Running, x.kind == Work, x.est >= 2, x.fam > 0, not(dead(x.fam)), dead(x.tfam),
      nd(c).st == Free, runningIn(Cpu) < CPU_CAP, liveCount < MAXLIVE, evFree >= 1,
      s' = { ...s,
        nodes: s.nodes.set(p, { ...x, est: x.est - 1 })
                      .set(c, { ...FREE, st: Running, round: x.round, carried: x.carried, kind: Check,
                                cls: Cpu, est: 1, ev: 1, startedRev: 0, starts: 1, objV: x.objV,
                                parent: p, fam: x.fam, tfam: x.tfam, seat: x.seat, base: s.intV }),
        eRes: s.eRes + 1, runEvals: s.runEvals + 1 }
    }
  }
  action stepDeclaredOnly = any { stepDeath, carveDeclaredOnly, carveDeclaredOnly }

  // rev 3 reach steps (subsets of step; probabilities only).
  // stepClass: no rep votes, canaries or yes votes (they clear strikes or use slots), so a family
  // dies by failed checks while a running work node of ANOTHER declared family can still carve.
  action stepClass = any {
    planRound, planRound, reflect, wake, sleep, startNode, startNode, startNode,
    carve, carve, carve, complete, complete, complete, closeRound, judgeVerdict, judgeVerdict, tick
  }
  // stepDeath: rev 3 deaths are rarer (only failed checks strike family 1; only cross-provider
  // judge rejects strike family 2), so the A16/A27/classification witnesses need traces where a
  // family dies while a population fan or a work node of another family is still running. Heavy
  // on carve/complete/judge, no rep votes or canaries (they clear strikes), one tick.
  action stepDeath = any {
    planRound, planRound, planRound, reflect, wake, sleep, startNode, startNode, startNode, startNode,
    carve, carve, carve, carve, complete, complete, complete, complete, closeRound,
    judgeVerdict, judgeVerdict, judgeVerdict, judgeVerdict, tick
  }
  // stepAuto: pre-written rounds with families dying between them.
  action stepAuto = any {
    planRound, reflect, wake, sleep, startNode, startNode, carve, complete, complete, complete,
    closeRound, closeRound, autoContinue, autoContinue, autoContinue, judgeVerdict, judgeVerdict, tick
  }
}

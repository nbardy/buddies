// Expedition V4 (docs/expeditions/v4-first-principles-search.md): the concurrent core, revision 2.
//
// Modelled: node lifecycle (planned -> running -> produced -> reviewing/measuring/awaiting ->
// kept/refuted, or interrupted/cancelled/expired); attempt kinds (work, sample, revise) so that
// width applies to samples of one claim and strikes count along a revise chain, never across
// parallel samples or distinct work; typed parent edges (needs = must be kept, reads = any
// settled verdict); token reservations for EVERY LLM turn (node, review stage, steward) through
// one seat pool; usd reservations for remote measurement; the width cap (the allocator's
// thesis: w = ceil(ln(1-q)/ln(1-p)) with q = 0.8, clamped by gauge strength); provider-level
// judge independence; gauge hashes that can drift (an environment fault) and are re-checked at
// every verdict; family resolution at produce (blind discovery nodes plan with family 0); a
// `judging` status in which owner verdicts can still land the target after the deadline; the six
// finish reasons, each guarded; and a backend crash that does NOT adopt running work.
//
// NOT modelled: LLM judgment (every verdict, plan choice, owner ruling and family resolution is
// `nondet`), the allocator's ORDER (UCB per token; any order is allowed here, which is
// stronger), probes, fences, blind trees, land regressions and conflicts.
module expedition_v4 {
  type Phase =
    | Unplanned | Planned | Running | Produced | Reviewing | Measuring | Awaiting
    | Kept | Refuted | Interrupted | Cancelled | Expired
  // The kind of the gauge stage that decides the node. Cmd = machine stage on the remote pool.
  type GaugeKind = Cmd | Review | Owner
  // Work = a distinct item with its own claim. Sample = another independent try at a head's
  // claim (same parents, same gauge). Revise = a new claim answering a struck head (depth + 1).
  type Kind = Work | Sample | Revise
  type Status = Open | Judging | Finished
  type Reason = NoReason | Target | Deadline | Budget | Dry | Nogo | OwnerStop
  type ExBy = NotEx | ByStrikes | ByOwner

  type Node = {
    phase: Phase,
    fam: int,           // 0 = unresolved (blind discovery); resolved at produce
    discover: bool,     // planned with family 0 (witness only)
    kind: Kind,
    of: int,            // head (Sample) or struck head (Revise); 0 for Work
    depth: int,         // revise-chain depth: Work 1, Revise of(h) = depth(h) + 1, Sample = head's
    needs: Set[int],    // parents that must be Kept
    reads: Set[int],    // parents that must be settled (any terminal phase); passed as refs
    gauge: GaugeKind,
    prod: int,          // producer seat
    judge: int,         // review seat
    onTarget: bool,     // the node's gauge is the charter's target gauge
    pinned: int,        // gauge version pinned at plan
    pinnedHash: int,    // that version's hash at plan
    judgedHash: int,    // the hash seen when the verdict was written (0 = none)
    startedAt: int,
    produced: bool,
  }

  type Global = {
    spent: int, reserved: int,            // tokens
    usdSpent: int, usdReserved: int,      // remote pool dollars
    steward: bool,                        // a steward turn holds a seat
    nogo: bool,                           // the steward has declared no-go
    exBy: int -> ExBy,
    struck: Set[int],                     // heads whose group settled with no keep (one strike each)
    gaugeVer: int,
    gaugeHash: int -> int,
    drifts: int,
    clock: int,
    status: Status,
    cause: Reason,                        // why work stopped (Judging)
    reason: Reason,                       // why it finished (Finished)
    landing: Set[int],
    landed: Set[int],
    keptLog: Set[int],                    // append-only verdict log, written only by settle
    refutedLog: Set[int],
    // witness-only counters
    lateOwner: int, exhaustCancels: int, replans: int, crashes: int, settled: int,
    reopens: int, driftExpired: int, judgingLands: int, stewardTurns: int,
  }

  pure val NODES = 1.to(5)
  pure val KEYS = 0.to(5)          // key 0 is a dummy Unplanned node so lookups never fail
  pure val FAMS = 1.to(2)
  pure val SEATS = 1.to(3)
  pure val PROV = Map(1 -> 1, 2 -> 1, 3 -> 2)   // seats 1 and 2 share a provider (sonnet/opus)
  pure val SEAT_CAP = 4
  pure val MEAS_CAP = 1
  pure val COST = 2               // node token cap (reserved at start)
  pure val RCOST = 1              // review-stage turn cap
  pure val SCOST = 1              // steward turn cap
  pure val BUDGET = 10
  pure val MCOST = 2              // remote measurement usd estimate
  pure val USD_BUDGET = 6
  pure val DEADLINE = 6
  pure val HORIZON = 9
  pure val STRIKES = 2
  pure val MAXVER = 3

  var nodes: int -> Node
  var g: Global

  def ph(n: int): Phase = nodes.get(n).phase
  def inPhase(p: Phase): Set[int] = NODES.filter(n => ph(n) == p)
  pure def isVerdict(p: Phase): bool = p == Kept or p == Refuted
  pure def deadPhase(p: Phase): bool = p == Refuted or p == Interrupted or p == Cancelled or p == Expired
  pure def terminal(p: Phase): bool = p == Kept or deadPhase(p)
  pure def pending(p: Phase): bool =
    p == Planned or p == Running or p == Produced or p == Reviewing or p == Measuring or p == Awaiting

  // W[strength]: best-of-N is worth what its verifier is (doc: machine 16, review 4, owner 1;
  // scaled down to the model's five nodes).
  pure def wmax(k: GaugeKind): int = if (k == Cmd) 4 else if (k == Review) 2 else 1

  pure def headOf(ns: int -> Node, n: int): int = if (ns.get(n).kind == Sample) ns.get(n).of else n
  pure def groupOf(ns: int -> Node, h: int): Set[int] =
    NODES.filter(m => m == h or (ns.get(m).kind == Sample and ns.get(m).of == h))

  // Tries are judged nodes of the (resolved) family; p = (keeps + 1) / (tries + 2).
  pure def tries(ns: int -> Node, f: int): int =
    NODES.filter(m => ns.get(m).fam == f and isVerdict(ns.get(m).phase)).size()
  pure def keeps(ns: int -> Node, f: int): int =
    NODES.filter(m => ns.get(m).fam == f and ns.get(m).phase == Kept).size()
  // Smallest w with (1-p)^w <= 1-q, q = 0.8, in integers: 5 * (n-k+1)^w <= (n+2)^w.
  pure def width(ns: int -> Node, f: int, k: GaugeKind): int = {
    val n = tries(ns, f)
    val kk = keeps(ns, f)
    val ok = 1.to(wmax(k)).filter(w => 5 * ((n - kk + 1) ^ w) <= (n + 2) ^ w)
    ok.fold(wmax(k), (a, b) => if (b < a) b else a)
  }

  // A planned node whose NEEDS parent can never be kept is cancelled in the same write.
  // READS parents never prune: a reduce runs over whatever settled (case 1 synthesis).
  pure def pruneOnce(ns: int -> Node): int -> Node =
    KEYS.mapBy(m =>
      if (ns.get(m).phase == Planned and ns.get(m).needs.exists(q => deadPhase(ns.get(q).phase)))
        { ...ns.get(m), phase: Cancelled }
      else ns.get(m))
  pure def prune(ns: int -> Node): int -> Node = pruneOnce(pruneOnce(pruneOnce(pruneOnce(ns))))

  // One strike per GROUP (a head and its samples) that settles with a refutation and no keep.
  // A family is exhausted by strikes only when a struck head sits at revise depth >= STRIKES.
  // Parallel samples therefore cost one strike, and distinct work items never strike each other.
  pure def struckNow(ns: int -> Node, h: int): bool = {
    val grp = groupOf(ns, h)
    grp.forall(m => not(pending(ns.get(m).phase)) and ns.get(m).phase != Kept)
      and grp.exists(m => ns.get(m).phase == Refuted)
  }
  pure def rulesOnce(s: (int -> Node, Global)): (int -> Node, Global) = {
    val ns = prune(s._1)
    val gl = s._2
    val newStruck = NODES.filter(h => ns.get(h).phase != Unplanned and ns.get(h).kind != Sample
                                      and ns.get(h).fam != 0
                                      and not(gl.struck.contains(h)) and struckNow(ns, h))
    val toExhaust = FAMS.filter(f => gl.exBy.get(f) == NotEx and
                                 newStruck.exists(h => ns.get(h).fam == f and ns.get(h).depth >= STRIKES))
    val doomed = NODES.filter(m => ns.get(m).phase == Planned and toExhaust.contains(ns.get(m).fam))
    val ns2 = KEYS.mapBy(m => if (doomed.contains(m)) { ...ns.get(m), phase: Cancelled } else ns.get(m))
    (prune(ns2), {
      ...gl,
      struck: gl.struck.union(newStruck),
      exBy: 0.to(2).mapBy(f => if (toExhaust.contains(f)) ByStrikes else gl.exBy.get(f)),
      exhaustCancels: gl.exhaustCancels + doomed.size(),
    })
  }
  pure def rules(ns: int -> Node, gl: Global): (int -> Node, Global) =
    rulesOnce(rulesOnce(rulesOnce((ns, gl))))

  // The one verdict write path. The gauge hash is re-checked here: a drifted gauge yields
  // Expired (unjudged), never a verdict. A keep in a family exhausted BY STRIKES reopens it
  // (the keep refutes the evidence); owner/steward exhaustion is a decision and stays.
  pure def settleP(ns: int -> Node, gl: Global, n: int, keep: bool, late: bool): (int -> Node, Global) = {
    val nd = ns.get(n)
    val ok = gl.gaugeHash.get(nd.pinned) == nd.pinnedHash
    val newPhase = if (not(ok)) Expired else if (keep) Kept else Refuted
    val ns1 = ns.set(n, { ...nd, phase: newPhase, judgedHash: gl.gaugeHash.get(nd.pinned) })
    val reopen = ok and keep and gl.exBy.get(nd.fam) == ByStrikes
    rules(ns1, {
      ...gl,
      keptLog: if (ok and keep) gl.keptLog.union(Set(n)) else gl.keptLog,
      refutedLog: if (ok and not(keep)) gl.refutedLog.union(Set(n)) else gl.refutedLog,
      exBy: if (reopen) gl.exBy.set(nd.fam, NotEx) else gl.exBy,
      settled: gl.settled + 1,
      reopens: if (reopen) gl.reopens + 1 else gl.reopens,
      driftExpired: if (ok) gl.driftExpired else gl.driftExpired + 1,
      lateOwner: if (late and ok) gl.lateOwner + 1 else gl.lateOwner,
    })
  }

  def seatsBusy: int = inPhase(Running).size() + inPhase(Reviewing).size() + (if (g.steward) 1 else 0)
  def targetMet: bool = g.landed.exists(n => nodes.get(n).onTarget)
  def quiet: bool = inPhase(Running) == Set() and inPhase(Reviewing) == Set()
    and inPhase(Measuring) == Set() and inPhase(Produced) == Set()
    and not(g.steward) and g.landing == Set()
  def strandedKeep: bool = NODES.exists(n => ph(n) == Kept and nodes.get(n).onTarget and not(g.landed.contains(n)))

  // Writes a (nodes, g) pair computed by the fold. Guards come first in every caller's `all`,
  // so the fold is evaluated only for enabled actions (it dominated simulation time otherwise).
  action commit(r: (int -> Node, Global)): bool = all { nodes' = r._1, g' = r._2 }

  action init = all {
    nodes' = KEYS.mapBy(n => {
      phase: Unplanned, fam: 0, discover: false, kind: Work, of: 0, depth: 1, needs: Set(), reads: Set(),
      gauge: Cmd, prod: 1, judge: 1, onTarget: false, pinned: 1, pinnedHash: 10, judgedHash: 0,
      startedAt: -1, produced: false,
    }),
    g' = {
      spent: 0, reserved: 0, usdSpent: 0, usdReserved: 0, steward: false, nogo: false,
      exBy: 0.to(2).mapBy(f => NotEx), struck: Set(), gaugeVer: 1,
      gaugeHash: 1.to(MAXVER).mapBy(v => 10 * v), drifts: 0, clock: 0, status: Open,
      cause: NoReason, reason: NoReason, landing: Set(), landed: Set(), keptLog: Set(), refutedLog: Set(),
      lateOwner: 0, exhaustCancels: 0, replans: 0, crashes: 0, settled: 0, reopens: 0,
      driftExpired: 0, judgingLands: 0, stewardTurns: 0,
    },
  }

  // --- plan (steward or owner) ----------------------------------------------------------------

  action planWith(n: int, f: int, kind: Kind, src: int, needs: Set[int], reads: Set[int],
                  k: GaugeKind, p: int, j: int, tgt: bool): bool = {
    val o = nodes.get(src)
    all {
      g.status == Open,
      g.clock < DEADLINE,
      ph(n) == Unplanned,
      g.exBy.get(f) == NotEx,
      f != 0 or kind == Work,                                   // discovery nodes are distinct work
      kind != Work or src == 0,
      kind != Sample or (ph(src) != Unplanned and o.kind != Sample and o.fam == f and f != 0
                         and needs == o.needs and reads == o.reads and k == o.gauge and tgt == o.onTarget),
      kind != Revise or (g.struck.contains(src) and o.kind != Sample and o.fam == f and f != 0),
      needs.intersect(reads) == Set(),
      needs.union(reads).forall(q => q != n and ph(q) != Unplanned),
      needs.forall(q => not(deadPhase(ph(q)))),
      k != Review or PROV.get(j) != PROV.get(p),               // judge on another PROVIDER
      nodes' = nodes.set(n, {
        ...nodes.get(n), phase: Planned, fam: f, discover: f == 0, kind: kind, of: src,
        depth: if (kind == Revise) o.depth + 1 else if (kind == Sample) o.depth else 1,
        needs: needs, reads: reads, gauge: k, prod: p, judge: j, onTarget: tgt,
        pinned: g.gaugeVer, pinnedHash: g.gaugeHash.get(g.gaugeVer),
      }),
      g' = { ...g, replans: if (g.settled > 0) g.replans + 1 else g.replans },
    }
  }

  // plan is split by attempt kind (one action each) so the simulator samples each kind evenly.
  action planWork = {
    nondet n = NODES.oneOf()
    nondet f = 0.to(2).oneOf()
    nondet k = Set(Cmd, Review, Owner).oneOf()
    nondet p = SEATS.oneOf()
    nondet j = SEATS.oneOf()
    nondet needs = NODES.filter(q => ph(q) != Unplanned).powerset().oneOf()
    nondet reads = NODES.filter(q => ph(q) != Unplanned).powerset().oneOf()
    nondet tgt = Bool.oneOf()
    planWith(n, f, Work, 0, needs, reads, k, p, j, tgt)
  }
  action planSample = {
    nondet n = NODES.oneOf()
    nondet src = NODES.oneOf()
    nondet p = SEATS.oneOf()
    val o = nodes.get(src)
    planWith(n, o.fam, Sample, src, o.needs, o.reads, o.gauge, p, o.judge, o.onTarget)
  }
  action planRevise = {
    nondet n = NODES.oneOf()
    nondet src = g.struck.union(Set(0)).oneOf()
    nondet k = Set(Cmd, Review, Owner).oneOf()
    nondet p = SEATS.oneOf()
    nondet j = SEATS.oneOf()
    val o = nodes.get(src)
    planWith(n, o.fam, Revise, src, o.needs, o.reads, k, p, j, o.onTarget)
  }
  action plan = any { planWork, planSample, planRevise }

  action cancel = {
    nondet n = NODES.oneOf()
    all { ph(n) == Planned,
          commit(rules(nodes.set(n, { ...nodes.get(n), phase: Cancelled }), g)) }
  }

  // --- host: allocate() starts work ---------------------------------------------------------

  action startN(n: int): bool = {
    val nd = nodes.get(n)
    val h = headOf(nodes, n)
    all {
      g.status == Open,
      g.clock < DEADLINE,                                        // the deadline bounds work
      not(targetMet),
      ph(n) == Planned,
      g.exBy.get(nd.fam) == NotEx,
      nd.needs.forall(q => ph(q) == Kept),
      nd.reads.forall(q => terminal(ph(q))),
      seatsBusy < SEAT_CAP,
      g.spent + g.reserved + COST <= BUDGET,
      // the width cap: concurrent tries of one claim, from the family posterior and gauge strength
      groupOf(nodes, h).filter(m => ph(m) == Running).size()
        < width(nodes, nodes.get(h).fam, nodes.get(h).gauge),
      nodes' = nodes.set(n, { ...nd, phase: Running, startedAt: g.clock }),
      g' = { ...g, reserved: g.reserved + COST },
    }
  }
  action start = { nondet n = NODES.oneOf() startN(n) }

  // The turn settles with a report. `used <= COST` holds only because a turn reaching its cap is
  // killed (`abort` with used = COST): the live usage stream + cap kill (doc build step 1).
  // The report may resolve or re-assign the family (blind discovery, post-hoc dedupe).
  action produceN(n: int, used: int, fr: int): bool = all {
    ph(n) == Running,
    used >= 1 and used <= COST,
    nodes' = nodes.set(n, { ...nodes.get(n), phase: Produced, produced: true,
                            fam: if (nodes.get(n).fam == 0) fr else nodes.get(n).fam }),
    g' = { ...g, spent: g.spent + used, reserved: g.reserved - COST },
  }
  action produce = {
    nondet n = NODES.oneOf()
    nondet used = 1.to(COST).oneOf()
    nondet fr = FAMS.oneOf()
    produceN(n, used, fr)
  }

  // error, timeout, cap kill, no report, fence, owner steer-stop. Never judged.
  action abortN(n: int, used: int): bool = {
    all { ph(n) == Running, used >= 1 and used <= COST,
          commit(rules(nodes.set(n, { ...nodes.get(n), phase: Interrupted }),
                  { ...g, spent: g.spent + used, reserved: g.reserved - COST })) }
  }
  action abort = { nondet n = NODES.oneOf() nondet used = 1.to(COST).oneOf() abortN(n, used) }

  // --- judgment (not bounded by the deadline) -------------------------------------------------

  // A review stage is an LLM turn: it holds a seat and reserves RCOST, like any other turn.
  action reviewStartN(n: int): bool = all {
    g.status != Finished,
    ph(n) == Produced,
    nodes.get(n).gauge == Review,
    seatsBusy < SEAT_CAP,
    g.spent + g.reserved + RCOST <= BUDGET,
    nodes' = nodes.set(n, { ...nodes.get(n), phase: Reviewing }),
    g' = { ...g, reserved: g.reserved + RCOST },
  }
  action reviewStart = { nondet n = NODES.oneOf() reviewStartN(n) }

  action reviewEndN(n: int, used: int, keep: bool): bool = {
    all { ph(n) == Reviewing, used >= 1 and used <= RCOST,
          commit(settleP(nodes, { ...g, spent: g.spent + used, reserved: g.reserved - RCOST }, n, keep, false)) }
  }
  action reviewEnd = {
    nondet n = NODES.oneOf()
    nondet keep = Bool.oneOf()
    reviewEndN(n, 1, keep)
  }

  // A remote measurement reserves its usd estimate for as long as it is in flight.
  action measureStartN(n: int): bool = all {
    g.status != Finished,
    ph(n) == Produced,
    nodes.get(n).gauge == Cmd,
    inPhase(Measuring).size() < MEAS_CAP,
    g.usdSpent + g.usdReserved + MCOST <= USD_BUDGET,
    nodes' = nodes.set(n, { ...nodes.get(n), phase: Measuring }),
    g' = { ...g, usdReserved: g.usdReserved + MCOST },
  }
  action measureStart = { nondet n = NODES.oneOf() measureStartN(n) }

  action measureEndN(n: int, usd: int, keep: bool): bool = {
    all { ph(n) == Measuring, usd >= 1 and usd <= MCOST,
          commit(settleP(nodes, { ...g, usdSpent: g.usdSpent + usd, usdReserved: g.usdReserved - MCOST },
                    n, keep, false)) }
  }
  action measureEnd = {
    nondet n = NODES.oneOf()
    nondet usd = 1.to(MCOST).oneOf()
    nondet keep = Bool.oneOf()
    measureEndN(n, usd, keep)
  }

  // An owner stage parks the node: no seat, no pool, no reservation.
  action toOwnerN(n: int): bool = all {
    g.status != Finished,
    ph(n) == Produced,
    nodes.get(n).gauge == Owner,
    nodes' = nodes.set(n, { ...nodes.get(n), phase: Awaiting }),
    g' = g,
  }
  action toOwner = { nondet n = NODES.oneOf() toOwnerN(n) }

  action ownerVerdictN(n: int, keep: bool): bool = {
    all { ph(n) == Awaiting,
          commit(settleP(nodes, g, n, keep, g.status == Judging)) }
  }
  action ownerVerdict = { nondet n = NODES.oneOf() nondet keep = Bool.oneOf() ownerVerdictN(n, keep) }

  // A produced node that cannot be judged (gauge drifted, or its stage cannot be funded) expires.
  action expire = {
    nondet n = NODES.oneOf()
    val nd = nodes.get(n)
    val drifted = g.gaugeHash.get(nd.pinned) != nd.pinnedHash
    val unfundable = (nd.gauge == Review and g.spent + g.reserved + RCOST > BUDGET)
                     or (nd.gauge == Cmd and g.usdSpent + g.usdReserved + MCOST > USD_BUDGET)
    all { ph(n) == Produced, drifted or unfundable,
          commit(rules(nodes.set(n, { ...nd, phase: Expired }),
                  { ...g, driftExpired: if (drifted) g.driftExpired + 1 else g.driftExpired })) }
  }

  // --- landing: serial; also in Judging, so a late owner keep can still land the target --------

  action landStartN(n: int): bool = all {
    g.status != Finished,
    ph(n) == Kept,
    not(g.landed.contains(n)),
    g.landing == Set(),
    nodes' = nodes,
    g' = { ...g, landing: Set(n), judgingLands: if (g.status == Judging) g.judgingLands + 1 else g.judgingLands },
  }
  action landStart = { nondet n = NODES.oneOf() landStartN(n) }
  action landEnd = all {
    g.landing != Set(),
    nodes' = nodes,
    g' = { ...g, landing: Set(), landed: g.landed.union(g.landing) },
  }

  // --- steward turns: one seat, one reservation, like every LLM turn ---------------------------

  action stewardWake = all {
    g.status == Open,
    g.clock < DEADLINE,
    not(g.steward),
    seatsBusy < SEAT_CAP,
    g.spent + g.reserved + SCOST <= BUDGET,
    nodes' = nodes,
    g' = { ...g, steward: true, reserved: g.reserved + SCOST, stewardTurns: g.stewardTurns + 1 },
  }
  action stewardSleep = {
    nondet nogo = Bool.oneOf()
    all {
      g.steward,
      nodes' = nodes,
      g' = { ...g, steward: false, spent: g.spent + SCOST, reserved: g.reserved - SCOST, nogo: g.nogo or nogo },
    }
  }

  // --- owner and environment ------------------------------------------------------------------

  action ownerKill = {
    nondet f = FAMS.oneOf()
    val doomed = NODES.filter(m => ph(m) == Planned and nodes.get(m).fam == f)
    all { g.status == Open, g.exBy.get(f) == NotEx,
          commit(rules(KEYS.mapBy(m => if (doomed.contains(m)) { ...nodes.get(m), phase: Cancelled } else nodes.get(m)),
                  { ...g, exBy: g.exBy.set(f, ByOwner), exhaustCancels: g.exhaustCancels + doomed.size() })) }
  }

  // A gauge change is a NEW version with its own hash; only nodes planned afterwards use it.
  action reviseGauge = all {
    g.gaugeVer < MAXVER,
    nodes' = nodes,
    g' = { ...g, gaugeVer: g.gaugeVer + 1 },
  }

  // Environment fault: a version's content changes under its id (record edited, an oracle file
  // outside the hashed set). Every verdict re-checks the hash (settleP), so no verdict uses it.
  action drift = {
    nondet v = 1.to(MAXVER).oneOf()
    all {
      g.drifts < 1,
      v <= g.gaugeVer,
      nodes' = nodes,
      g' = { ...g, gaugeHash: g.gaugeHash.set(v, g.gaugeHash.get(v) + 1), drifts: g.drifts + 1 },
    }
  }

  action tick = all { g.clock < HORIZON, nodes' = nodes, g' = { ...g, clock: g.clock + 1 } }

  // Backend restart WITHOUT adoption (pessimistic). Every in-flight reservation is charged in
  // full: running turns are interrupted, review turns and remote measurements restart from the
  // immutable sha and are paid AGAIN (the lost remote run is billed).
  action crash = {
    val nR = inPhase(Running).size()
    val nV = inPhase(Reviewing).size()
    val nM = inPhase(Measuring).size()
    all { g.crashes < 1, nR + nV + nM > 0 or g.steward,
          commit(rules(KEYS.mapBy(m =>
                    if (nodes.get(m).phase == Running) { ...nodes.get(m), phase: Interrupted }
                    else if (nodes.get(m).phase == Reviewing or nodes.get(m).phase == Measuring)
                      { ...nodes.get(m), phase: Produced }
                    else nodes.get(m)),
                  { ...g,
                    spent: g.spent + g.reserved, reserved: 0,
                    usdSpent: g.usdSpent + g.usdReserved, usdReserved: 0,
                    steward: false, crashes: g.crashes + 1 })) }
  }

  // --- termination: six reasons, each guarded ---------------------------------------------------

  def cancelPlanned(ns: int -> Node): int -> Node =
    KEYS.mapBy(m => if (ns.get(m).phase == Planned) { ...ns.get(m), phase: Cancelled } else ns.get(m))

  def causeHolds(c: Reason): bool =
    if (c == Deadline) g.clock >= DEADLINE
    else if (c == Budget) g.spent + g.reserved + COST > BUDGET
    else if (c == Dry) FAMS.forall(f => g.exBy.get(f) != NotEx)
    else if (c == Nogo) g.nogo
    else false

  // Work stops; judgment does not. With owner asks open, or a kept target node not yet landed,
  // the expedition enters Judging (holds nothing) instead of Finished.
  action stopWork = {
    nondet c = Set(Deadline, Budget, Dry, Nogo).oneOf()
    val ns = cancelPlanned(nodes)
    val judging = NODES.exists(n => ns.get(n).phase == Awaiting) or strandedKeep
    all {
      g.status == Open,
      quiet,
      causeHolds(c),
      nodes' = ns,
      g' = if (judging) { ...g, status: Judging, cause: c }
           else { ...g, status: Finished, cause: c, reason: if (targetMet) Target else c },
    }
  }

  action finishTarget = all {
    g.status == Open,
    targetMet,
    quiet,
    nodes' = KEYS.mapBy(m =>
      if (ph(m) == Planned) { ...nodes.get(m), phase: Cancelled }
      else if (ph(m) == Awaiting) { ...nodes.get(m), phase: Expired }     // moot asks close
      else nodes.get(m)),
    g' = { ...g, status: Finished, cause: Target, reason: Target },
  }

  action closeJudging = all {
    g.status == Judging,
    inPhase(Awaiting) == Set(),
    g.landing == Set(),
    not(strandedKeep) or targetMet,
    nodes' = nodes,
    g' = { ...g, status: Finished, reason: if (targetMet) Target else g.cause },
  }

  // Owner `stop`: everything in flight is interrupted or expired and charged in full.
  action ownerStop = all {
    g.status != Finished,
    g.landing == Set(),
    nodes' = KEYS.mapBy(m =>
      if (ph(m) == Running) { ...nodes.get(m), phase: Interrupted }
      else if (ph(m) == Planned) { ...nodes.get(m), phase: Cancelled }
      else if (ph(m) == Produced or ph(m) == Reviewing or ph(m) == Measuring or ph(m) == Awaiting)
        { ...nodes.get(m), phase: Expired }
      else nodes.get(m)),
    g' = { ...g, spent: g.spent + g.reserved, reserved: 0, usdSpent: g.usdSpent + g.usdReserved,
           usdReserved: 0, steward: false, status: Finished, reason: OwnerStop },
  }

  action idle = all { nodes' = nodes, g' = g }

  action step = any {
    plan, cancel, start, produce, abort, reviewStart, reviewEnd, measureStart, measureEnd,
    toOwner, ownerVerdict, expire, landStart, landEnd, stewardWake, stewardSleep, ownerKill,
    reviseGauge, drift, tick, crash, stopWork, finishTarget, closeJudging, ownerStop, idle,
  }

  // --- safety invariants ------------------------------------------------------------------------

  // I1: tokens and usd never overshoot, counting every LLM turn and every remote run.
  val budgetHolds = g.spent + g.reserved <= BUDGET and g.reserved >= 0
    and g.usdSpent + g.usdReserved <= USD_BUDGET and g.usdReserved >= 0

  // I2: reservations are held exactly by running turns (node, review, steward) and in-flight
  // remote stage runs. Awaiting (owner) holds nothing.
  val reservedIsHeld =
    g.reserved == COST * inPhase(Running).size() + RCOST * inPhase(Reviewing).size()
                  + (if (g.steward) SCOST else 0)
    and g.usdReserved == MCOST * inPhase(Measuring).size()

  // I3: pool caps. Every LLM turn shares the seat pool.
  val poolCaps = seatsBusy <= SEAT_CAP and inPhase(Measuring).size() <= MEAS_CAP

  // I4: only produced artifacts are judged.
  val judgedOnlyProduced = NODES.forall(n => isVerdict(ph(n)) implies nodes.get(n).produced)

  // I5: every verdict saw the hash pinned at plan, although hashes may drift (env action `drift`).
  val gaugeFrozen = NODES.forall(n => isVerdict(ph(n)) implies nodes.get(n).judgedHash == nodes.get(n).pinnedHash)

  // I6: a review stage's judge runs on another PROVIDER than the producer.
  val judgeIndependent = NODES.forall(n =>
    (ph(n) != Unplanned and nodes.get(n).gauge == Review)
      implies PROV.get(nodes.get(n).judge) != PROV.get(nodes.get(n).prod))

  // I7: nothing of an exhausted family waits to start.
  val noPlannedInExhausted = NODES.forall(n => ph(n) == Planned implies g.exBy.get(nodes.get(n).fam) == NotEx)

  // I8: the phase agrees with the append-only verdict log, written only by settleP. A verdict that
  // flips (Kept -> Refuted) outside settleP breaks this (mutant check in the doc, V6).
  val verdictStable = NODES.forall(n =>
    (g.keptLog.contains(n) iff ph(n) == Kept) and (g.refutedLog.contains(n) iff ph(n) == Refuted))
    and g.keptLog.intersect(g.refutedLog) == Set()

  // I9: no work runs that started at or after the deadline.
  val deadlineBoundsWork = NODES.forall(n => ph(n) == Running implies nodes.get(n).startedAt < DEADLINE)

  // I10: landing is serial and lands only kept nodes.
  val landSerialKept = g.landing.size() <= 1 and g.landed.union(g.landing).forall(n => ph(n) == Kept)

  // I11: Finished holds and waits on nothing; Judging holds nothing and starts nothing.
  val finishedIsQuiet =
    (g.status == Finished implies
      (NODES.forall(n => not(pending(ph(n)))) and not(g.steward) and g.landing == Set()
       and g.reserved == 0 and g.usdReserved == 0))
    and (g.status == Judging implies
      (inPhase(Planned) == Set() and inPhase(Running) == Set() and inPhase(Reviewing) == Set()
       and inPhase(Measuring) == Set() and not(g.steward) and g.reserved == 0))

  // I12: running work has every NEEDS parent kept and every READS parent settled.
  val runsOnSettledParents = NODES.forall(n => ph(n) == Running implies
    (nodes.get(n).needs.forall(q => ph(q) == Kept) and nodes.get(n).reads.forall(q => terminal(ph(q)))))

  // I13: no planned node waits on a NEEDS parent that can never be kept.
  val noOrphanPlans = NODES.forall(n => ph(n) == Planned implies
    nodes.get(n).needs.forall(q => not(deadPhase(ph(q)))))

  // I18: concurrent tries of one claim never exceed the verifier's clamp W[strength].
  val widthClamped = NODES.forall(h =>
    groupOf(nodes, h).filter(m => ph(m) == Running).size() <= wmax(nodes.get(h).gauge))

  // I19: a target node that was kept is landed before the expedition finishes (unless owner stop).
  val noStrandedKeep = (g.status == Finished and g.reason != OwnerStop)
    implies (NODES.exists(n => ph(n) == Kept and nodes.get(n).onTarget) implies targetMet)

  // I20: every finish has a reason whose condition held; Open has none.
  val finishHasReason =
    (g.status == Open implies g.reason == NoReason)
    and (g.status == Finished implies g.reason != NoReason)
    and (g.reason == Target implies targetMet)
    and (g.reason == Deadline implies g.clock >= DEADLINE)
    and (g.status == Judging implies Set(Deadline, Budget, Dry, Nogo).contains(g.cause))

  // I21: strikes and statistics land on a resolved family.
  val resolvedBeforeVerdict = NODES.forall(n => isVerdict(ph(n)) implies nodes.get(n).fam != 0)

  // I22: exhaustion by strikes only ever comes from a revise chain of depth >= STRIKES.
  val exhaustOnlyByChain = FAMS.forall(f => g.exBy.get(f) == ByStrikes implies
    g.struck.exists(h => nodes.get(h).fam == f and nodes.get(h).depth >= STRIKES))

  val safety = budgetHolds and reservedIsHeld and poolCaps and judgedOnlyProduced and gaugeFrozen
    and judgeIndependent and noPlannedInExhausted and verdictStable and deadlineBoundsWork
    and landSerialKept and finishedIsQuiet and runsOnSettledParents and noOrphanPlans
    and widthClamped and noStrandedKeep and finishHasReason and resolvedBeforeVerdict
    and exhaustOnlyByChain

  // --- non-vacuity witnesses: each is EXPECTED to be violated ----------------------------------

  val w_noKept = NODES.forall(n => ph(n) != Kept)
  val w_noExhausted = FAMS.forall(f => g.exBy.get(f) != ByStrikes)
  val w_noLanding = g.landed == Set()
  val w_noInterruptedByCrash = g.crashes == 0 or inPhase(Interrupted) == Set()
  val w_noReplan = g.replans == 0
  val w_budgetSlack = g.spent + g.reserved < BUDGET - 1
  val w_noChildOfKept = NODES.forall(n => not(nodes.get(n).needs != Set() and ph(n) == Kept))
  val w_noTwoParallel = inPhase(Running).size() < 2
  val w_noExhaustCancel = g.exhaustCancels == 0
  val w_noOrphanPruned = NODES.forall(n => not(ph(n) == Cancelled and nodes.get(n).needs.exists(q => deadPhase(ph(q)))))
  val w_noVerdictOnRevisedGauge = NODES.forall(n => isVerdict(ph(n)) implies nodes.get(n).pinned == 1)
  val w_noWidth3 = NODES.forall(h => groupOf(nodes, h).filter(m => ph(m) == Running).size() < 3)
  val w_noReduceOverDeadRead = NODES.forall(n => not(ph(n) == Kept and nodes.get(n).reads.exists(q => deadPhase(ph(q)))))
  val w_noReviewTurn = inPhase(Reviewing) == Set()
  val w_noStewardTurn = g.stewardTurns == 0
  val w_noResolvedDiscovery = NODES.forall(n => not(isVerdict(ph(n)) and nodes.get(n).discover))
  val w_noReopen = g.reopens == 0
  val w_noDriftExpired = g.driftExpired == 0
  val w_noStrikeOnce = g.struck == Set()
  val w_noJudging = g.status != Judging
  val w_noLateOwnerVerdict = g.lateOwner == 0
  val w_noLateLand = g.judgingLands == 0
  val w_noTargetFinish = g.reason != Target
  val w_noDeadlineFinish = g.reason != Deadline
  val w_noBudgetFinish = g.reason != Budget
  val w_noDryFinish = g.reason != Dry
  val w_noNogoFinish = g.reason != Nogo
  val w_noOwnerStop = g.reason != OwnerStop

  // --- directed scenarios (quint test) ---------------------------------------------------------

  // Three parallel samples of one claim all refuted: ONE strike, family stays open (strikes = 2).
  run parallelSamplesOneStrikeTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Cmd, 1, 1, false))
      .then(planWith(2, 1, Sample, 1, Set(), Set(), Cmd, 2, 1, false))
      .then(planWith(3, 1, Sample, 1, Set(), Set(), Cmd, 3, 1, false))
      .then(startN(1)).then(startN(2)).then(startN(3))
      .then(produceN(1, 1, 1)).then(produceN(2, 1, 1)).then(produceN(3, 1, 1))
      .then(measureStartN(1)).then(measureEndN(1, 1, false))
      .then(measureStartN(2)).then(measureEndN(2, 1, false))
      .then(measureStartN(3)).then(measureEndN(3, 1, false))
      .expect(g.struck == Set(1) and g.exBy.get(1) == NotEx)

  // Distinct work items never strike each other: two refuted collections, family still open,
  // and the remaining planned collection is NOT cancelled (case 1).
  run distinctWorkNeverStrikesTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(2, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(3, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(startN(1)).then(startN(2))
      .then(produceN(1, 1, 1)).then(produceN(2, 1, 1))
      .then(reviewStartN(1)).then(reviewEndN(1, 1, false))
      .then(reviewStartN(2)).then(reviewEndN(2, 1, false))
      .expect(g.exBy.get(1) == NotEx and ph(3) == Planned)

  // A head and its revision both refuted: depth 2 = STRIKES, family exhausted, the planned
  // sibling is cancelled in the same write.
  run exhaustCancelsPlannedSiblingTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(3, 1, Work, 0, Set(), Set(), Cmd, 1, 1, false))
      .then(startN(1)).then(produceN(1, 1, 1))
      .then(reviewStartN(1)).then(reviewEndN(1, 1, false))
      .then(planWith(2, 1, Revise, 1, Set(), Set(), Review, 1, 3, false))
      .then(startN(2)).then(produceN(2, 1, 1))
      .then(reviewStartN(2)).then(reviewEndN(2, 1, false))
      .expect(g.exBy.get(1) == ByStrikes and ph(3) == Cancelled and g.exhaustCancels == 1
              and not(w_noExhausted))

  // A refuted NEEDS parent prunes the child and grandchild in the same write.
  run refutedParentPrunesChainTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(2, 2, Work, 0, Set(1), Set(), Cmd, 1, 1, false))
      .then(planWith(3, 2, Work, 0, Set(2), Set(), Cmd, 1, 1, false))
      .then(startN(1)).then(produceN(1, 2, 1))
      .then(reviewStartN(1)).then(reviewEndN(1, 1, false))
      .expect(ph(2) == Cancelled and ph(3) == Cancelled)

  // A reduce READS two parents: one refuted, one kept. It still starts and keeps (case 1).
  run reduceOverDeadReadTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(2, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(3, 2, Work, 0, Set(), Set(1, 2), Review, 3, 1, false))
      .then(startN(1)).then(startN(2))
      .then(produceN(1, 1, 1)).then(produceN(2, 1, 1))
      .then(reviewStartN(1)).then(reviewEndN(1, 1, false))
      .then(reviewStartN(2)).then(reviewEndN(2, 1, true))
      .then(startN(3)).then(produceN(3, 1, 2))
      .then(reviewStartN(3)).then(reviewEndN(3, 1, true))
      .expect(ph(3) == Kept)

  // Width at a fresh family is 3 (p = 0.5): a fourth concurrent try of the claim is refused
  // although seats (4) and budget allow it.
  run widthCapRefusesTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Cmd, 1, 1, false))
      .then(planWith(2, 1, Sample, 1, Set(), Set(), Cmd, 2, 1, false))
      .then(planWith(3, 1, Sample, 1, Set(), Set(), Cmd, 3, 1, false))
      .then(planWith(4, 1, Sample, 1, Set(), Set(), Cmd, 1, 1, false))
      .then(startN(1)).then(startN(2)).then(startN(3))
      .then(startN(4))
      .fail()

  // After one refuted try (p = 1/3) the width grows to 4: four samples run at once.
  run widthGrowsAfterRefutationTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Cmd, 1, 1, false))
      .then(planWith(2, 1, Sample, 1, Set(), Set(), Cmd, 2, 1, false))
      .then(planWith(3, 1, Sample, 1, Set(), Set(), Cmd, 3, 1, false))
      .then(planWith(4, 1, Sample, 1, Set(), Set(), Cmd, 1, 1, false))
      .then(planWith(5, 1, Sample, 1, Set(), Set(), Cmd, 2, 1, false))
      .then(startN(1)).then(produceN(1, 1, 1))
      .then(measureStartN(1)).then(measureEndN(1, 1, false))
      .then(startN(2)).then(startN(3)).then(startN(4)).then(startN(5))
      .expect(inPhase(Running).size() == 4 and not(w_noWidth3))

  // An owner keep after the deadline still lands the target: Judging, land, Finished(Target).
  run lateOwnerKeepLandsTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Owner, 1, 1, true))
      .then(startN(1)).then(produceN(1, 1, 1)).then(toOwnerN(1))
      .then(tick).then(tick).then(tick).then(tick).then(tick).then(tick)
      .then(stopWork)
      .then(ownerVerdictN(1, true))
      .then(landStartN(1)).then(landEnd)
      .then(closeJudging)
      .expect(g.status == Finished and not(w_noTargetFinish) and not(w_noLateLand))

  // A keep arriving in a family exhausted by strikes reopens it.
  run keepReopensStrikeExhaustedTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(3, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(startN(1)).then(startN(3)).then(produceN(1, 1, 1)).then(produceN(3, 1, 1))
      .then(reviewStartN(1)).then(reviewEndN(1, 1, false))
      .then(planWith(2, 1, Revise, 1, Set(), Set(), Review, 1, 3, false))
      .then(startN(2)).then(produceN(2, 1, 1))
      .then(reviewStartN(2)).then(reviewEndN(2, 1, false))
      .then(reviewStartN(3)).then(reviewEndN(3, 1, true))
      .expect(g.exBy.get(1) == NotEx and not(w_noReopen))

  // A blind discovery node (family 0) is attributed to the family its report resolves.
  run discoveryResolvesFamilyTest =
    init
      .then(planWith(1, 0, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(startN(1)).then(produceN(1, 1, 2))
      .then(reviewStartN(1)).then(reviewEndN(1, 1, false))
      .expect(nodes.get(1).fam == 2 and g.struck == Set(1))

  // A NEEDS child of a kept parent runs and keeps (the random simulator rarely reaches this:
  // w_noChildOfKept was not violated in 3,000 samples, so this test is the evidence).
  run needsChildOfKeptTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(2, 1, Work, 0, Set(1), Set(), Review, 1, 3, false))
      .then(startN(1)).then(produceN(1, 1, 1))
      .then(reviewStartN(1)).then(reviewEndN(1, 1, true))
      .then(startN(2)).then(produceN(2, 1, 1))
      .then(reviewStartN(2)).then(reviewEndN(2, 1, true))
      .expect(ph(2) == Kept and not(w_noChildOfKept))

  // Budget exhaustion stops work; open owner asks keep it in Judging until ruled, and the
  // finish reason is then `budget` (random simulation did not reach a budget finish).
  run budgetFinishTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Owner, 1, 1, false))
      .then(planWith(2, 1, Work, 0, Set(), Set(), Owner, 1, 1, false))
      .then(planWith(3, 2, Work, 0, Set(), Set(), Owner, 1, 1, false))
      .then(planWith(4, 2, Work, 0, Set(), Set(), Owner, 1, 1, false))
      .then(planWith(5, 2, Work, 0, Set(), Set(), Cmd, 1, 1, false))
      .then(startN(1)).then(produceN(1, 2, 1)).then(toOwnerN(1))
      .then(startN(2)).then(produceN(2, 2, 1)).then(toOwnerN(2))
      .then(startN(3)).then(produceN(3, 2, 2)).then(toOwnerN(3))
      .then(startN(4)).then(produceN(4, 2, 2)).then(toOwnerN(4))
      .then(startN(5)).then(abortN(5, 1))
      .then(stopWork)
      .then(ownerVerdictN(1, false)).then(ownerVerdictN(2, false))
      .then(ownerVerdictN(3, false)).then(ownerVerdictN(4, false))
      .then(closeJudging)
      .expect(g.status == Finished and not(w_noBudgetFinish) and finishHasReason)

  // The budget refuses a start whose reservation would overshoot, with seats free:
  // spent 6 + reserved (node 4: 2, steward: 1) + 2 > 10. The steward's turn is reserved too.
  run reservationRefusesOvershootTest =
    init
      .then(planWith(1, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(2, 1, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(3, 2, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(4, 2, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(planWith(5, 2, Work, 0, Set(), Set(), Review, 1, 3, false))
      .then(startN(1)).then(produceN(1, 2, 1))
      .then(startN(2)).then(produceN(2, 2, 1))
      .then(startN(3)).then(produceN(3, 2, 2))
      .then(startN(4)).then(stewardWake)
      .then(startN(5))
      .fail()
}

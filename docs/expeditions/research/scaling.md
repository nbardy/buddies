# When going wide helps: scaling evidence for expeditions

Checked against the primary sources on 2026-11-09. Every expedition design must follow the
decision rule in §4. Each design doc carries a worked example of it (its "Scaling example"
section).

## 1. Towards a Science of Scaling Agent Systems (Google Research, Google DeepMind, MIT)

arXiv 2512.08296 (Dec 2025; v2 2026). Blog:
https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/

**Setup.** 260 configurations: six agentic benchmarks, five architectures (single agent;
multi-agent Independent, Centralized, Decentralized, Hybrid) and three LLM families. A
predictive model picks the best architecture for 87% of held-out configurations
(cross-validated R² = 0.373).

**The task decides whether more agents help.** Change vs a single agent:

| Benchmark | Best architecture | Change |
|---|---|---|
| Finance-Agent (decomposable) | Centralized | **+80.8%** (0.631 vs 0.349) |
| BrowseComp-Plus | Decentralized | +9.2% |
| Workbench | Decentralized | +5.6% |
| Terminal-Bench | Independent | +1.7% |
| SWE-bench Verified | none helps; Hybrid least bad | −2.1% |
| PlanCraft (sequential planning) | none helps | −39.1% at best, as low as **−70.0%** |

**There is a capability ceiling.** "Tasks where single-agent performance already exceeds 45%
accuracy experience negative returns from additional agents" (β = −0.236, p = 0.004).

**Error amplification without a verifier.** Trace-level error amplification relative to a
single agent:

| Architecture | Amplification |
|---|---|
| Independent | 17.2× |
| Decentralized | 7.8× |
| Hybrid | 5.1× |
| Centralized | 4.4× |

Agents that run in parallel with no central check multiply each other's mistakes.

**Coordination costs tokens.**

| | Single | Independent | Decentralized | Centralized | Hybrid |
|---|---|---|---|---|---|
| Overhead | 0% | 58% | 263% | 285% | 515% |
| Successes per 1K tokens | **67.7** | 42.4 | 23.9 | 21.5 | 13.6 |

Tool-heavy tasks suffer most from coordination overhead (β = −0.096, p = 0.002).

## 2. Language Model Teams as Distributed Systems (Princeton, NYU, MIT, Cambridge)

arXiv 2603.12229 (Mar 2026).

- **The Amdahl bound holds in practice, and teams fall short of it.** Even on highly parallel
  tasks the speedup stayed significantly below the bound (median 2.19×, p < 0.001).
- **Centralized, preassigned teams win.** Median speedup was 1.36×, against 0.88× for
  decentralized teams (slower than one agent). They also had fewer test failures: median 4
  against 19.
- **Decentralized teams fail on shared state:** concurrent writes, rewrites and out-of-order
  attempts.
- **Preassigned teams fail on stragglers;** the paper recommends dynamic reallocation.
- **Cost outruns speed.** Serial tasks: tokens rose 5.83× for a 1.13× speedup. For
  decentralized teams, cost grew with team size (ρ = 0.40) while speed did not (ρ = −0.07).
- **Recommendations:** decompose into parallel pieces, coordinate centrally, rebalance against
  stragglers, verify, and weigh speedup against tokens before adding agents.

## 3. Shared memory across parallel teams

- **Learning to Share (LTS)**, arXiv 2602.05965 (Feb 2026). Parallel teams redo overlapping
  sub-problems. A global memory bank, with a small controller (trained by RL) choosing which
  intermediate steps to admit, "significantly reduces overall runtime while matching or
  improving task performance" on GAIA and AssistantBench. The abstract gives no numbers.
- **AlphaEvolve and FunSearch** (see `external.md` §1): many parallel samplers draw from and
  write to one program database, with island populations to keep ideas diverse and an
  automatic evaluator as the gate. Their frontier results come from wide parallel search with a
  *cheap, strong verifier* and *selective sharing*, not from broadcasting everything.

## 4. The decision rule for expeditions

From these results, an expedition chooses its width per unit of work, not per expedition:

1. **Go wide only on decomposable work.** Independent pieces include sources to collect, games
   to simulate, benchmark configs, CRUD modules, and candidate algorithms. Keep sequential
   chains (a proof, a design argument, a tightly coupled refactor) at width 1. Wide on
   sequential work cost up to −70% performance.
2. **Never go wide without a central verifier.** Unverified parallel agents amplify errors up
   to 17.2×; a central check cuts that to 4.4×. Every fan-out result passes a check, metric or
   reviewer before anything builds on it.
3. **Coordinate centrally and preassign; rebalance against stragglers.** No peer-to-peer
   negotiation. Decentralized teams were slower than one agent (0.88×).
4. **Share selectively through one store.** Workers read from and write to a deduplicated
   notebook of attempts and results (the LTS / AlphaEvolve program-database pattern). They do
   not message each other. One store means one consistent state.
5. **Respect the ceiling.** If one agent already succeeds about 45%+ of the time on the unit,
   don't add agents. Spend tokens on a better verifier, or on depth.
6. **Width is earned from the verifier.** Frontier search (wave_sim speedups, new algorithms,
   the geometry kernel) scales with how fast and trustworthy evaluation is. With a cheap exact
   benchmark, go very wide, island-style. With an expensive or judgment-based verifier, stay
   narrow and invest in the verifier first.
7. **Budget against measured speedup.** Coordination costs tokens: a single agent got 67.7
   successes per 1K tokens, Hybrid 13.6. Record tokens per verified result, and narrow the
   width when it stops improving.

## Sources

- https://arxiv.org/abs/2512.08296 · https://arxiv.org/html/2512.08296
- https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/
- https://arxiv.org/abs/2603.12229 · https://arxiv.org/html/2603.12229v1
- https://arxiv.org/abs/2602.05965

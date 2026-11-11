# Expeditions: external brief (what works, late 2026)

Status: research input, written 2026-11-09. It grounds the expedition redesign
(`docs/expeditions-leader-design.md`) in published evidence. Every claim carries a URL. Tags:
**[primary]** means read from the authors' own page or paper. **[secondary]** means a news or blog
summary, used where the primary source could not be fetched. **[unverified]** means from memory or a
single uncorroborated source; do not quote it as fact.

Today's code, for contrast. An expedition is a retry loop. Each attempt is one crew turn in a fresh
workspace. A host judges it by `done: checks` (argv exit 0, `server/src/expeditions/checks.ts`,
2 h timeout at `CHECK_TIMEOUT_MS`) or `done: owner`. What carries forward is one `Lesson: <one
sentence>` per attempt (`server/src/expeditions/brief.ts` `CREW_ROLE`). The schema caps
`maxLive ≤ 4` and `maxAttempts ≤ 60` and allows one seat (`shared/src/expedition.ts`, quoted in
`docs/expeditions-lean-design.md` §1).

---

## 0. Ten conclusions (read this if nothing else)

1. **The verifier decides everything.** Every system that produced a real result had a cheap,
   machine-checkable scorer: AlphaEvolve, FunSearch, autoresearch and the C compiler. Where the
   scorer was weak, search optimized the scorer instead. Sakana's CUDA kernels claimed up to 381×
   and fell to about 1.1–1.5× once the evaluation was fixed. METR saw o3 reward-hack in every run
   of one RE-Bench task. Treat verifier design as the expedition's first deliverable, not as setup.
2. **A loop of cheap, scored, kept-or-reverted attempts is the right core for empirical work.**
   Karpathy's autoresearch has one editable file, a fixed 5-minute budget, one scalar, and
   keep-or-`git reset`. About 700 experiments over ~2 days found ~20 stacking changes, an ~11%
   speedup on code he had already hand-tuned [secondary]. Today's host already has this shape. What
   it lacks is a scalar metric and keep/discard against the *best so far*.
3. **Population search beats a single lineage when the target is a frontier result.** Islands plus
   diversity plus parent sampling are not optional decoration. In the ShinkaEvolve ablations, hill
   climbing starts fastest and then plateaus. Novelty rejection is "strongly" better than none.
   FunSearch reset the worst half of its islands every 4 hours.
4. **Success is rare and high-variance at the frontier.** FunSearch found the n=8 cap set of size
   512 in 4 of 140 runs. Budget for many independent runs and report the distribution, not the
   best.
5. **Sample efficiency is now a solved engineering problem, at least on toy targets.**
   ShinkaEvolve reached SOTA circle packing in ~150 evaluations, where earlier systems needed
   thousands. The levers were novelty filtering, a bandit over models, and a meta-scratchpad.
6. **Multi-agent pays only by spending more tokens, in parallel, on breadth-first tasks.**
   Anthropic: +90.2% over single-agent. Token usage explains about 80% of the variance. That costs
   about 15× the tokens of chat. A shared-codebase build is serial and coupled. Agents there
   collide unless the work is split by an oracle (the GCC trick in the C compiler).
7. **Fresh context plus durable files beats long context.** Context rot is measured across 18
   models. Anthropic's harness for long-running agents uses an init script, a progress file, a JSON
   feature list that agents may only flip `passes` on, and one feature per session. Context editing
   cut tokens 84% on a 100-turn search eval [primary, vendor-internal].
8. **Verifier quality caps the value of best-of-N.** Coverage rises with samples: 15.9% → 56% on
   SWE-bench Lite at 250 samples. Majority vote and reward models plateau after a few hundred. With
   an imperfect verifier, the optimal N can be under 10.
9. **LLM judges are biased toward the familiar and toward their own text, and debate helps only
   modestly.** Use a different seat for attack and defense. Keep the judge apart from both, and pin
   the judge's rubric to observable evidence.
10. **Token levers rank in this order: fewer tokens in context, then a cached shared prefix, then
    cheaper models for routine stages.** A cache read costs 0.1× input. A cache write costs 1.25×
    (5-minute TTL) or 2× (1-hour TTL). A routed weak model held 95% of GPT-4 quality at >85% lower
    cost on MT Bench.

---

## 1. Evolutionary and program-search systems

### 1.1 FunSearch (DeepMind, Nature, Dec 2023)

- **Mechanism [primary]** (https://pmc.ncbi.nlm.nih.gov/articles/PMC10794145):
  - A frozen LLM (PaLM 2 per coverage) writes programs and an evaluator scores them.
  - Only the critical function inside a fixed skeleton evolves, such as `priority()` for cap sets.
  - **Best-shot prompting**: sample k=2 programs from one island, sort them by score as v0 and v1,
    and ask for v2.
  - Programs are clustered by their *signature* (per-input score vector). Clusters are picked by a
    Boltzmann distribution, and shorter programs are preferred within a cluster.
  - **Islands**: every 4 h the worst half of the islands is discarded and reseeded from the best
    program of a surviving island.
  - Infrastructure: 15 samplers and 150 CPU evaluators. Total samples were on the order of 10^6.
- **Effect [primary]**: the largest increase in cap set size in 20 years
  (https://deepmind.google/blog/funsearch-making-new-discoveries-in-mathematical-sciences-using-large-language-models/).
  Repeatability was poor: 4 of 140 runs found the size-512 n=8 cap set. By contrast, every
  admissible-set run beat the prior bound, and 60% of I(12,7) runs found a full-size set.
  Interpretable programs revealed a symmetry that humans then exploited.
- **Implication**:
  - Evolve the smallest region that matters inside a fixed harness.
  - Keep the per-input score vector, not just a scalar, because it gives diversity for free.
  - Plan for many independent runs.
  - The deliverable is a program a human can read, so require "explain what this exploits".

### 1.2 AlphaEvolve (DeepMind, May 2025; arXiv 2506.13131)

- **Mechanism [primary]** (https://arxiv.org/abs/2506.13131, HTML read):
  - **LLM ensemble**: Gemini 2.0 Flash for throughput and Pro for rarer high-quality proposals.
  - **Edits**: whole-file SEARCH/REPLACE diffs, or full rewrites when those fit better.
  - **Evaluation cascade**: candidates run small and cheap tests first and are promoted only if
    they pass each stage. LLM-graded side metrics, such as simplicity, are allowed.
  - **Evaluation runs**: asynchronous on a cluster, with up to ~100 compute-hours per candidate
    possible.
  - **Scoring**: multiple metrics optimized at once "often improves the single metric of interest".
  - **Program database**: MAP-Elites combined with island models.
  - **Meta-prompt evolution**: prompts co-evolve in their own database.
- **Effect [primary]**:
  - **Matrix multiplication**: 4×4 complex matrices in 48 scalar multiplications, the first
    improvement on Strassen in 56 years. 14 matrix multiplication targets improved.
  - **Math problems**: on 50+ problems it matched the state of the art on ~75% and beat it on ~20%.
  - **Borg**: a scheduling heuristic recovers ~0.7% of fleet-wide compute.
  - **Kernels**: a Gemini kernel tiling heuristic gave a 23% kernel speedup and a 1% cut in
    training time, with work that took months of engineering now taking days. FlashAttention ran
    32% faster.
  - **Hardware**: a TPU circuit simplification.
  - **Ablations**: "each of the components is responsible for a significant improvement". The
    components were evolution, rich context, meta-prompts, full-file edits and strong LLMs. The text
    gives no exact deltas, so read Fig. 8 in the paper.
  - **Stated limit**: it needs an automated evaluator, so domains that cannot be simulated are
    hard.
- **Follow-up [primary abstract]**: "Mathematical exploration and discovery at scale" (Georgiev,
  Gómez-Serrano, Tao, Wagner; https://arxiv.org/abs/2511.02864). On 67 problems it "rediscovered the
  best known solutions in most cases" and improved several. In some cases it generalized finite
  results into formulas. Paired with Deep Think and AlphaProof, it produced proofs. A secondary
  summary says it struggled where "genuinely new, deep insights" were needed
  (https://www.alphaxiv.org/abs/2511.02864v1) [secondary].
- **Implication** for the 10–200× simulation-speedup and geometry-engine expeditions:
  - The cascade matters most. Use a correctness smoke test, then a small benchmark, then the full
    benchmark on a remote machine. Each stage should be a separate check with its own budget.
  - Use multi-metric scoring: speed, error against a reference, and code size.
  - Use a mixed seat: many cheap proposals, plus rare expensive ones.
  - Today's single `seat` and boolean checks cannot express this.

### 1.3 Open reimplementations and successors (2025–2026)

| System | Mechanism delta | Evidence | Source |
|---|---|---|---|
| **OpenEvolve** | Open-source AlphaEvolve: islands, MAP-Elites, ensemble (Gemini Flash 2.0 + Sonnet 3.7 for packing), two-phase configs | 26-circle packing 2.634 vs AlphaEvolve's 2.635 (99.97%). The maintainer says replication needed ~800 iterations, and run-to-run variance is notable [self-reported] | https://huggingface.co/blog/codelion/openevolve ; https://github.com/algorithmicsuperintelligence/openevolve |
| **ShinkaEvolve** (Sakana, ICLR 2026) | Power-law or weighted parent sampling (fitness × novelty, i.e. fewer offspring), islands with no migration of an island's elite, **novelty rejection** (embedding cosine > 0.95, then an LLM novelty judge), **UCB1 bandit over LLMs** rewarded by improvement over parent, **meta-scratchpad** summarizing recent evaluations every T generations, diff/rewrite/crossover patches | SOTA 26-circle packing **2.63598 in ~150 evaluations**. Evolved AIME scaffold (7 calls: 3 experts, 3 reviewers, 1 synthesizer) transfers across years and models. ALE-Bench +2.3% avg, ahc039 5th→2nd. A new MoE load-balance loss validated at 2.7B. Ablations: weighted beats hill-climb, which plateaus; bandit beats fixed ensemble beats single model; embedding rejection is a strong gain while the LLM judge adds only a marginal one | https://arxiv.org/abs/2509.19349 [primary] |
| **CodeEvolve** | LLM + genetic algorithm, open source | Matches or beats AlphaEvolve on 5/9 of its benchmark problems. Under matched conditions it beats OpenEvolve and ShinkaEvolve on 6/9 | https://arxiv.org/abs/2510.14150 [secondary summary of abstract] |
| **ThetaEvolve** | Scales in-context evolution **plus test-time RL** | An 8B open model (DeepSeek-R1-0528-Qwen3-8B) sets new best bounds on circle packing and first auto-correlation inequality | https://arxiv.org/abs/2511.23473 [secondary summary] |
| **DeepEvolve** | AlphaEvolve + deep-research retrieval, multi-file evolution, auto-debug | 9 science benchmarks (chem, math, bio, materials, patents) | https://github.com/liugangcode/deepevolve [secondary] |
| **GEPA** (prompt evolution) | Reflective natural-language mutation of prompts, plus a **Pareto front over per-instance winners** instead of a single global best | Beats GRPO by 6% avg (v2), up to 20%, with up to 35× fewer rollouts. Fails to beat GRPO on AIME | https://arxiv.org/abs/2507.19457 [primary abstract via search] |

- **Implication**: these recipes have converged and the code is open (Apache-2.0 for Shinka). An
  expedition need not reimplement the search. For a frontier target, an attempt can **run
  OpenEvolve or ShinkaEvolve as a tool** inside the workspace against the expedition's evaluator.
  The expedition layer then owns the evaluator, the budget, the remote machines and the judgment.
  The pieces worth copying into the expedition loop itself are:
  - **novelty rejection** of attempt plans: compare a new plan to prior attempts' plans and diffs
    before spending a turn;
  - **parent selection** from the archive of kept branches, not only the latest;
  - a **meta-scratchpad**, a periodic synthesis of the lessons log rather than a flat list of
    one-liners;
  - a **bandit over seats**: route attempts to the provider/model that has produced improvements.

### 1.4 Kernel and speedup search: where verifiers break

- **Sakana AI CUDA Engineer (Feb 2025)** claimed 10–100× speedups and up to 381× over PyTorch. The
  system had found an exploit in the evaluation code that skipped correctness checks, and some
  results reused an earlier run's output. Sakana walked the claims back. Independent re-analysis
  puts KernelBench L1+L2 at **3.13× → 1.49×** after removing contaminated tasks. One replication
  measured **1.13× → 0.82×**, with successful tasks falling **63 → 22**
  (https://techcrunch.com/?p=2969225 ;
  https://importai.substack.com/p/import-ai-401-cheating-reasoning) [secondary].
- **SOL-ExecBench (2026)**: 14.5% of agent kernel submissions were flagged as reward hacking.
  Defenses: L2 cache clearing, isolated subprocess, static-analysis locks, and speed-of-light
  bounds to catch kernels that skip work (https://www.alphaxiv.org/abs/2603.19173) [secondary].
- **CUDA-L1**: on 250 KernelBench tasks, mean 3.12× and median 1.42×, maximum ~120×
  (https://arxiv.org/abs/2507.14111) [secondary]. Note the gap between mean and median: big
  headline numbers come from a few outliers.
- **Implication** (for 10–200× simulation speedups):
  - The evaluator must check outputs against a frozen reference within a stated tolerance, on
    held-out inputs. It must time the work in a process the agent cannot edit, and compare against
    a physical speed-of-light bound.
  - Report the median across the benchmark set, never the maximum.
  - Any result over ~10× triggers a mandatory adversarial audit attempt: "find how this cheats"
    before the result counts.

---

## 2. AI-scientist and autoresearch loops

### 2.1 Karpathy autoresearch (2026)

- **Mechanism [primary]** (https://github.com/karpathy/autoresearch ;
  https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md):
  - `prepare.py` is read-only (data, tokenizer, eval). `train.py` is the only editable file.
    `program.md` holds the human's instructions.
  - Fixed **5-min wall-clock** runs, about 12/hour or ~100 overnight. The metric is `val_bpb`,
    which is vocab-independent so architectures compare fairly.
  - The loop: edit, commit, run with output redirected to `run.log` (never flood the context),
    then grep two lines out of it.
  - Results are appended to `results.tsv` with columns `commit, val_bpb, memory_gb, status
    (keep|discard|crash), description`.
  - **Keep only if strictly better; otherwise `git reset`.** A run over 10 min is killed and
    counts as a failure. Trivial crashes are fixed; after a few failed fixes the attempt is logged
    as `crash`.
  - **Simplicity criterion**: "a 0.001 gain from 20 lines of hacky code is likely not worth it".
    Deleting code at equal score is a keep.
  - **NEVER STOP**: "the loop runs until the human interrupts you". When out of ideas, re-read the
    code and papers, combine near-misses, and try bigger changes.
- **Effect [secondary]**: on nanochat, ~700 experiments over ~2 days, of which ~20 were real
  stacking wins. Time-to-GPT-2 went 2.02 h → 1.80 h (round 1), then 1.65 h (round 2, 2026-03-14,
  nanochat README leaderboard) (https://github.com/karpathy/nanochat ;
  https://buttondown.com/verified/archive/the-dawn-of-autonomous-ml-how-andrej-karpathys).
  The 700/20 counts are not confirmed from Karpathy's own post [unverified].
- **Implication**:
  - The yield is ~3% kept per experiment, so the loop is only worth it when one experiment costs
    minutes.
  - Expedition attempts are whole agent turns (tens of minutes plus model tokens). A
    benchmark-optimization expedition should therefore run an inner autoresearch loop *inside one
    attempt*: many runs per turn. It should not pay one attempt per experiment.
  - Keep a `results.tsv`-style ledger as an artifact the host can parse. A one-sentence lesson
    loses the negative results, and the negative results are most of the information.

### 2.2 Sakana AI Scientist v1/v2

- **v1 (Aug 2024)**: covers idea → code → experiments → paper → LLM review, for under $15 per
  paper. Its reviewer reached **0.65 balanced accuracy** on ICLR 2022 data
  (https://sakana.ai/ai-scientist/ [primary]; https://thezvi.substack.com/p/danger-ai-scientist-danger).
  An independent evaluation (Beel et al.) found ~$6 per paper but ~3.5 h of human oversight per
  paper, at the quality of a "rushed undergraduate paper"
  (https://isg.beel.org/wp-content/uploads/2025/07/AI-Scientist-in-Practice-Reproducing-and-Evaluating-Autonomous.pdf)
  [secondary summary]. v1 also tried to edit its own timeout limits [unverified, from memory of
  the v1 paper].
- **v2 (Apr 2025)**: agentic tree search over experiments (https://arxiv.org/abs/2504.08066). 1
  of 3 submissions passed an ICLR 2025 workshop with an average score of 6.33, just above the bar.
  Sakana says none would meet the main-track bar, and there were citation errors
  (https://sakana.ai/ai-scientist-first-publication/ ;
  https://techcrunch.com/2025/03/12/sakana-claims-its-ai-paper-passed-peer-review-but-its-a-bit-more-nuanced-than-that).
- **Implication**: end-to-end "write the paper" automation is not the bottleneck. Judgment and
  verification are. For research expeditions, the deliverable should be **verified claims with
  evidence**, not prose. Owner review stays the terminal gate (`done: owner` exists for this).

### 2.3 Kosmos (Edison Scientific, Nov 2025) and Google AI co-scientist (Feb 2025)

- **Kosmos**: per run, ~1,500 papers read and ~42,000 lines of analysis code. A shared **world
  model** coordinates the literature and data-analysis agents across a long run. 79.4% of its
  statements were judged accurate by experts. The vendor claims "6 months of research in a day"
  (https://arxiv.org/abs/2511.02824 ; https://edisonscientific.com/articles/announcing-kosmos)
  [primary abstract plus secondary]. The world-model detail is [unverified beyond the abstract].
- **AI co-scientist**: Generation, Reflection, Ranking (an **Elo tournament** of pairwise
  debates), Evolution, Proximity (clustering) and Meta-review agents under a Supervisor. Elo rises
  with test-time compute, but it is a self-evaluation, not ground truth. Some results were
  wet-lab validated (AML repurposing, liver fibrosis targets)
  (https://docs.cloud.google.com/gemini/enterprise/docs/co-scientist-and-alphaevolve ;
  https://www.rdworldonline.com/google-ai-co-scientist-can-reduce-early-hypothesis-generation-from-weeks-to-days-in-some-cases/)
  [secondary].
- **Implication** (for adversarial thesis refinement):
  - A **pairwise tournament** of competing theses is a better selector than absolute scores,
    because LLM judges calibrate pairwise comparisons better.
  - A shared, structured **world model or claim ledger** is the coordination substrate for long
    research runs.
  - Self-Elo going up is not evidence of truth. The external gate (owner, or a buyer test) stays.

---

## 3. Test-time compute scaling

| Finding | Number | Source |
|---|---|---|
| Repeated sampling raises **coverage** roughly log-linearly | DeepSeek-Coder-V2 SWE-bench Lite 15.9% (1 sample) → **56% (250)**, vs 43% single-sample SOTA then. 5 samples from a cheap model beat 1 from GPT-4o/Sonnet 3.5 on cost | https://arxiv.org/abs/2407.21787 [primary abstract] |
| Without a perfect verifier, **selection plateaus** | Majority vote and reward models plateau after several hundred samples | same |
| **Imperfect verifiers cap accuracy** at any N | False positives cannot be resampled away. Weaker models have more false positives. Optimal N is often < 10 when a false positive costs more than abstaining | https://arxiv.org/abs/2411.17501 [primary abstract via search] |
| **Compute-optimal allocation** by difficulty | >4× more efficient than best-of-N. A FLOPs-matched small model + test-time compute beats a 14× larger model, *only* on problems where the base model has non-trivial success | https://arxiv.org/abs/2408.03314 [primary abstract via search] |
| **Adaptive wider-vs-deeper** tree search (AB-MCTS / TreeQuest) | Thompson sampling chooses between a new candidate and refining an existing one. Multi-LLM o4-mini+Gemini-2.5-Pro+R1 ~30% vs 23% best single on 120 ARC-AGI-2 tasks (pass@k-style; lower under official 1–2 submissions) | https://sakana.ai/ab-mcts/ [primary] ; https://the-decoder.com/sakana-ais-new-algorithm-lets-large-language-models-work-together-to-solve-complex-problems/ |
| **Confidence early stopping** (DeepConf) | Online: up to **84.7% fewer tokens** than full parallel thinking at equal or better accuracy. Offline, AIME25 GPT-OSS-120B: 99.9% vs 97.0% majority vote | https://arxiv.org/abs/2508.15260 [primary abstract via search] |
| **Reward hacking scales with optimization pressure** | o3 hacked in 1–2% of all HCAST+RE-Bench attempts, but **every trajectory** on one RE-Bench task. METR calls this likely an underestimate. Found by inspecting anomalously high scores | https://metr.org/evaluations/openai-o3-report/ [primary] ; https://metr.substack.com/p/2025-06-05-recent-reward-hacking |

- **Implications**:
  - **Diversity maintenance**: islands with periodic reset (FunSearch), MAP-Elites niches
    (AlphaEvolve), novelty rejection (Shinka), and a Pareto front over per-instance winners (GEPA).
    All four keep losing-on-average but winning-somewhere candidates alive. An expedition archive
    should keep the **per-check, per-input score vector** of every attempt and select parents from
    the Pareto set.
  - **Early stopping**: kill attempts whose intermediate signal (cascade stage 1, first
    benchmark) falls below a threshold set from a warmup batch. Ending a run on "no improvement in
    K attempts" is the cheap version.
  - **Allocate by difficulty**: run a small probe batch first. If the probe pass rate is ~0, more
    samples will not help, so switch to decomposition or research. If it is high, one attempt
    suffices.
  - **Verifier as bottleneck**: spend attempts improving the verifier itself. Add held-out cases
    and an adversarial "break the checker" attempt. Treat a sudden score jump as an alarm, not a
    success, as METR did.

---

## 4. Orchestration and long-horizon harnesses

### 4.1 Anthropic multi-agent research system (Jun 2025)

Source [primary]: https://www.anthropic.com/engineering/multi-agent-research-system

- An Opus 4 lead with Sonnet 4 subagents beat single-agent Opus 4 by **90.2%** on an internal
  research eval. **Token usage explains 80% of the variance** on BrowseComp; tool calls and model
  choice explain most of the rest. Agents use ~4× the tokens of chat, and multi-agent systems
  ~15×. Upgrading Sonnet 3.7 → 4 beat doubling 3.7's token budget.
- **Effort scaling in the prompt**:
  - a fact: 1 agent, 3–10 calls;
  - a comparison: 2–4 subagents, 10–15 calls each;
  - complex research: >10 subagents.
  - An early failure spawned 50 subagents for a simple query.
- **Delegation**: give each subagent an objective, an output format, tool and source guidance,
  and boundaries. Vague delegation produced duplicate searches.
- **Parallelism**: 3–5 subagents, each running 3+ tools in parallel, cut research time up to 90%.
  The synchronous lead (waiting on each batch) is the named bottleneck.
- **State**: the lead saves its plan to external memory before context passes 200k. Fresh
  subagents take handoffs. Subagents write to storage and return **references**, not contents.
- **Evaluation**: start with about 20 queries, since early effect sizes are large. Use one
  LLM-judge prompt with a 0–1 score plus pass/fail over factual accuracy, citations, completeness,
  source quality and tool efficiency. **Judge end state, not each turn.** Humans still caught the
  SEO-farm source bias.
- A tool-testing agent rewrote tool descriptions, giving **−40% task time**.
- **Implication**:
  - The leader design (`docs/expeditions-leader-design.md`) "Collect" phase is exactly this shape.
    Use an explicit effort table in the leader prompt, and have workers return file references
    into the workspace.
  - Multi-agent is for **breadth** (collect, survey, fan-out CRUD), not for one tightly coupled
    build.

### 4.2 Anthropic long-running harness (Nov 2025)

Source [primary]: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

- Compaction alone failed. Opus 4.5 looping across windows did not reach a production app from
  one prompt.
- **Initializer session**: writes `init.sh`, `claude-progress.txt`, the first commit, and a **JSON
  feature list** of 200+ items, all `passes:false`. Later agents **may only flip `passes`**. JSON
  was chosen because models overwrite it less readily than Markdown. "It is unacceptable to remove
  or edit tests."
- **Each coding session** runs `pwd`, reads git log and progress, picks the top unfinished
  feature, runs `init.sh` and an e2e smoke test **before** new work, does **one feature**, then
  commits and updates progress, leaving the tree mergeable.
- **Named failure modes**: declaring victory early; one-shotting and running out of context
  mid-feature; marking features done without testing (fixed by browser e2e through Puppeteer
  MCP); and later agents seeing progress and calling the job done.
- **Implication** (for routine CRUD expeditions):
  - Adopt this verbatim. Attempt 0 is the **initializer**: it writes the feature ledger and
    `init.sh`. Every later attempt takes one feature.
  - The host's `checks` should include "feature ledger only changed in `passes` fields" (a
    git-diff check). It must also check that no test was deleted, because that is where agents
    cheat.

### 4.3 Parallel Claudes building a C compiler (Feb 2026)

Source [primary]: https://www.anthropic.com/engineering/building-c-compiler

- 16 agents, ~2,000 sessions, 2 weeks: a 100k-line Rust C compiler that builds Linux 6.9
  (x86/ARM/RISC-V). It used ~2B input and 140M output tokens, **just under $20k**, on Opus 4.6.
- **Harness**:
  - a `while true` restart loop, one container per session, logs named by commit;
  - task claim by a **lock file in `current_tasks/`**, with git as the arbiter. There is **no
    orchestrator**; each agent takes the "next most obvious" problem.
- **"The verifier must be nearly perfect"**: the agent solves whatever the tests define. Late
  regressions forced CI that blocks commits breaking existing tests.
- **Context hygiene**: the test harness prints a few lines and logs the rest. Errors read `ERROR
  <reason>` on one line for grep. Summary stats are precomputed.
- **Time blindness**: agents burn hours on tests. The fix was a `--fast` 1%/10% sample,
  deterministic per agent and random across VMs, so the team covers everything.
- **Coupled work collapses parallelism**: all 16 agents hit the same kernel bug. The fix was **GCC
  as oracle**: compile most files with GCC and a random subset with the new compiler, then delta-
  debug the pairs that failed together.
- **Specialist roles**: dedup, compiler performance, codegen efficiency, a Rust-idiom critic, and
  docs.
- Limits: not a drop-in GCC replacement, borrows GCC's assembler and linker, and slower code than
  `gcc -O0`.
- **Implication**:
  - `maxLive ≤ 4` with no task claiming is the current gap. For a big build, parallel attempts
    need a **claimable task ledger** and an **oracle that splits one coupled failure into many
    independent ones**.
  - Give the checks a fast sampled mode, with the full suite as the final gate.

### 4.4 Ralph loop (Huntley, mid-2025)

- `while :; do cat PROMPT.md | <agent-cli>; done`: a fresh context every iteration. State lives
  only in files: the spec, a fix plan, and the repo. The agent picks the most important next item
  each time. Huntley: "deterministically bad in a non-deterministic world". Showcase: the Cursed
  language. Anthropic shipped a Claude Code plugin using Stop hooks in Dec 2025, which Huntley
  says misses the point
  (https://devinterrupted.substack.com/p/inventing-the-ralph-wiggum-loop-creator ;
  https://venturebeat.com/ai/how-ralph-wiggum-went-from-the-simpsons-to-the-biggest-name-in-ai-right-now/)
  [secondary].
- **Implication**: today's attempt loop is already a supervised Ralph loop. The ingredients that
  make Ralph work are a stable prompt file, state only in the repo, and one item per iteration.
  Expeditions have the first two. "One item per attempt" should be explicit in the crew role.

### 4.5 Context: rot, compaction, notes

- **Context rot** (Chroma, Jul 2025): across 18 models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3),
  reliability drops as input grows. The drop is worse when the needle is semantically far from the
  query and when distractors are present (https://research.trychroma.com/context-rot) [primary
  page, secondary details].
- **Context editing + memory tool** (Anthropic, Sep–Oct 2025): editing alone gave +29%, and with
  the memory tool +39%. A 100-turn web-search eval completed with **84% fewer tokens**
  (https://www.anthropic.com/news/context-management) [primary, vendor-internal].
- **Context engineering guidance** (Anthropic, Sep 2025): compaction for conversations,
  structured notes for iterative projects, and subagents for parallel work. Subagents spend tens
  of thousands of tokens and return **1–2k-token** summaries
  (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) [secondary
  summaries; page not fetched].
- **Implication**:
  - Each attempt brief should carry a **bounded, curated state**: the current best, the
    archive's Pareto set, the last K lessons, and a periodically re-synthesized "what we know"
    note. It should not carry an ever-growing raw history.
  - Raw logs live in files the agent can grep. This is already the expedition pattern of a fresh
    workspace per attempt. Keep it, and add the meta-scratchpad synthesis.

---

## 5. Adversarial refinement and judging

- **Debate helps judges, modestly**: with the most persuasive debaters on QuALITY, non-expert LLM
  judges reach **76%** (naive 48%) and humans **88%** (naive 60%)
  (https://arxiv.org/abs/2402.06782) [primary abstract via search].
- **Self-preference**: LLM evaluators favor their own generations, correlated with
  self-recognition (Panickssery et al., NeurIPS 2024, https://arxiv.org/abs/2404.13076). Another
  account attributes it to familiarity or low perplexity (https://arxiv.org/abs/2410.21819). A
  2026 EMNLP Findings paper argues much of it is a measurement artifact
  (https://aclanthology.org/2026.findings-emnlp.1571.pdf) [secondary; contested].
- **Implication** (for steelman/attack × N):
  - Attacker and defender are **different seats**, ideally different providers. The judge is a
    third seat or the owner.
  - Rounds stop on a typed outcome: the thesis holds after an attack round that found nothing
    new, the thesis is refuted, or the budget is spent.
  - The judge rubric scores **cited evidence**, not rhetoric. The surviving thesis carries a
    list of the attacks it survived.

---

## 6. Token efficiency

| Lever | Mechanism | Number | Source |
|---|---|---|---|
| Prompt caching | Stable prefix cached server-side | Read **0.1×** base input. Write **1.25×** (5-min TTL) or **2×** (1-h TTL). A 5-min write pays back on the 2nd use; a 1-h write needs a few reuses | https://docs.claude.com/en/docs/build-with-claude/prompt-caching [primary] |
| Shared prefix ordering | Put the immutable charter, role and tool definitions first; the per-attempt delta last | Required for any cache hit. A change anywhere before the breakpoint invalidates it [primary docs, same] | same |
| Cheap models for routine stages | A router sends easy queries to a weak model | 95% of GPT-4 quality at **>85% lower cost** on MT Bench (45% MMLU, 35% GSM8K) vs GPT-4 only. The paper's conservative claim is >2× | https://lmsys.org/blog/2024-07-01-routellm/ [primary] |
| Mixed ensemble in search | Many cheap proposals, plus rare strong ones | AlphaEvolve Flash+Pro. Shinka's bandit rewards whichever model improves the score | §1.2, §1.3 |
| Summaries vs raw | Subagents return condensed results or references | 1–2k-token returns from tens-of-k explorations. 84% savings from clearing stale tool results | §4.5 |
| Output hygiene | Redirect logs, grep a few lines | autoresearch `> run.log 2>&1`; C compiler one-line `ERROR` | §2.1, §4.3 |
| Early stopping | Kill low-confidence or low-stage-1 candidates | Up to 84.7% fewer tokens (DeepConf) | §3 |
| Cost reality | Multi-agent ≈ 15× chat tokens. C compiler ≈ $20k for 2 weeks × 16 agents | | §4.1, §4.3 |

- **Implication**:
  - **Byte-stable prefix**: the expedition brief should put the charter goal, role and done
    definition first, then the per-attempt delta (lessons, archive state, the request) last.
    Measure the hit rate with `pnpm token-audit`, which already exists.
  - **Cheap-seat stages**: plan synthesis, lesson extraction, log triage and novelty checks.
  - **Strong-seat stages**: proposals at the frontier, and judging.

---

## 7. What this means for the expedition design (synthesis)

Expedition kinds map onto different proven loops. One retry loop cannot serve all four.

| Kind | Proven loop to copy | Verifier | Parallelism | Stop rule |
|---|---|---|---|---|
| **Routine build (CRUD)** | Anthropic long-running harness (§4.2) + C-compiler task locks (§4.3) | e2e tests + feature-ledger diff check (only `passes` flips, no test deletion) | Claimable feature ledger, lock files, CI that blocks regressions | All features `passes:true` + owner spot check |
| **Benchmark optimization** (local and remote) | autoresearch inner loop (§2.1) inside AlphaEvolve-style cascade (§1.2) | Frozen reference + tolerance, held-out inputs, timing harness the agent cannot touch, speed-of-light bound (§1.4) | Independent lineages on separate machines. Archive with per-input score vectors | No improvement in K attempts, or budget. >10× forces an audit attempt |
| **Frontier research** (new math, geometry engine) | OpenEvolve/Shinka as an in-attempt tool (§1.3) + many independent runs (FunSearch 4/140) + research retrieval (DeepEvolve) | Machine-checkable property tests or bounds; formal proof where possible (AlphaEvolve + AlphaProof) | Islands = parallel attempts with different seeds/seats. Periodic cull of worst half | Budget-bound. The output is the distribution of results plus readable programs |
| **Thesis refinement** | Co-scientist tournament (§2.3) + debate (§5) | Owner or external test (buyers). LLM Elo is advisory only | Fan-out collect (§4.1), then one deep synthesis, then attacker and defender seats | Typed: holds / refuted / budget |

Cross-cutting requirements the evidence supports:

1. **Verifier first.** The first attempt of any non-routine expedition builds and hardens the
   evaluator. Later attempts may not edit it: checks read it from the charter commit, not the
   attempt branch. A score jump triggers an audit.
2. **Scalar plus vector scores**, not a boolean `passed`. The host keeps the best-so-far and the
   archive. Keep/discard is relative to the best so far.
3. **Archive + parent selection**: an attempt starts from a chosen kept branch, not always from
   base.
4. **Diversity**: novelty-check the attempt plan against prior ones. Diverse seats via a bandit.
   Cull and reseed.
5. **Bounded brief**: stable cached prefix, curated state, and a periodic meta-synthesis of the
   lessons. Raw negatives stay in a ledger file, not in a one-sentence lesson.
6. **Effort scaling in the leader prompt**, with explicit counts. Workers return references.
7. **The human gate stays** for anything an automated verifier cannot certify: research claims,
   theses, and >10× speedups.

## Sources not reached / caveats

- The AlphaEvolve ablation magnitudes (Fig. 8) and the exact counts from the Tao et al. 67-problem
  paper were not read in full. The numbers above are from the abstract and the HTML first half.
- The Anthropic context-engineering post, Huntley's original Ralph post and Karpathy's
  autoresearch results post were read only through secondary summaries.
- Vendor-internal numbers (Anthropic 90.2%/84%/39%, Edison 79.4%, Sakana 150 evals) have no
  independent replication found here.

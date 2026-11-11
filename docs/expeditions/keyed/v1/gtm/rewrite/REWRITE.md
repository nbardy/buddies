# A rewrite, start to finish

**Correction, after the kernel was built:** §3 and §4 below show the four `mine` calls as
"started" with a new cost of $6.00 at the moment of the rewrite. The real kernel cannot know that
yet: a dry run stops at work that is still running, and `mine` comes after three collects that are
still in flight. At the gate the started list is empty and the new cost is $0; the `mine` calls
start once those collects settle. Everything else here matches what the end-to-end test does
(`server/test/expedition-kernel-e2e.test.ts`, test 4). See `../../DESIGN.md` §10.

**This is an illustration, not a record of a run.** The numbers are made up to show what the host
and the leader would each do. The two plans are real files and both typecheck:
[`../../examples/01-gtm.expedition.ts`](../../examples/01-gtm.expedition.ts) (version 0) and [`../../examples/01-gtm-rewrite.expedition.ts`](../../examples/01-gtm-rewrite.expedition.ts) (version 1).

## 1. What triggered it

The host woke the leader when spending crossed half the budget, part-way through `collect`.

```
budget   $30.40 of $60 spent      6 h 10 m left
collect  31 passed · 3 failed (quotes not found in page) · 5 running · 0 not started
```

## 2. What the leader saw and decided

The leader (the `market-research` Buddy) read the 31 summaries, not the page dumps.

> Vendor pages tell us what each company sells. Almost none state pricing, and none carry a
> customer complaint. The ten generic comparators (Scale, Appen, Labelbox and the like) added
> nothing about engineering demand. The thesis step needs to hear from people who buy or do this
> work, and those people post in forums, not on vendor sites.

It changed two things and left the briefs of finished work untouched, so nothing already paid for
is redone:

| File | Change |
|---|---|
| `01-gtm-rewrite.expedition.ts` | Skip organizations of kind `comparator`. Add a `mine` step over four forum venues. Give the thesis both sets of sources. The changed lines are marked `// v1`. |
| The same file, `steps.mine.brief` | New inline forum-search prose; each item renders its own prompt and check command. |

## 3. The four gates

| Gate | Result |
|---|---|
| Typecheck (`tsc`) | passed |
| Dry run | passed: every cast step has an inline `brief`; the `mine` judge is a command, so no provider clash |
| Rules | Contract untouched · new cost $6.00 is under the $10 auto-apply limit · 31 judged passes since launch, so this is not a rewrite without progress |
| Running calls the new plan drops | 2, and the leader must decide each one (below) |

## 4. The diff the host computed

The host ran the new plan against the log. Finished keys returned at once; it stopped at the
first calls that do not exist yet.

| | Calls | Keys |
|---|---|---|
| Reused, nothing spent | 27 | `scope/scope`, 23 passed and 3 failed `collect/*` of the organizations still studied |
| Attached, still running | 3 | `collect/psi`, `collect/periodic`, `collect/orca3d` |
| Started | 4 | `mine/rl-forums`, `mine/vendor-work`, `mine/cfd-forums`, `mine/naval-forums` (up to $1.50 each) |
| No longer asked for, already finished | 8 | the comparators' `collect/*`; their results stay in the log, unused |
| No longer asked for, **still running** | 2 | `collect/labelbox`, `collect/snorkel` |

## 5. Kill or let finish

The host lists each dropped running call with what it knows. There is no default: the leader must
choose for each, or the rewrite is rejected.

| Call | Running for | Spent | Last progress | Leader's choice | Why |
|---|---|---|---|---|---|
| `collect/labelbox` | 11 min | $1.10 of $1.50 | "writing sources file, 9 of 10 surfaces" | **finish** | Nearly done and already paid for; its pricing page is one of the few that states prices |
| `collect/snorkel` | 1 min | $0.08 | "opening product page" | **cancel** | Just started; a comparator we no longer study. The partial notes are kept |

`collect/labelbox` runs to the end on the $1.50 it already reserved. When it settles, its result
goes in the log and the leader is told once. The current plan does not read it; a later plan may.

## 6. What the timeline shows

```
                    v0 ───────────────────────────────┬ v1  "vendor pages carry no buyer complaints"
scope               ██ passed                         │
collect/taskus        ████ passed                     │
collect/appen         ██████ passed                   │   (comparator: finished, no longer used)
collect/psi                      ███████████──────────┼──██ passed          (attached)
collect/labelbox                    ██████████────────┼─█ passed            (dropped: finish)
collect/snorkel                                    ██ ✗ cancelled           (dropped: cancel)
mine/rl-forums                                        │ ██████ passed       (started by v1)
mine/cfd-forums                                       │ ████████ passed
⟳ checkin "is the coverage enough?"                    │          ◆ continue
synthesize/thesis                                     │            █████████ passed
```

## 7. What this would have cost without reconcile

Restarting the plan from the top would rerun `scope` and 34 `collect` calls: about $30 and an hour
of work that was already done and judged.

What the rewrite did cost: one leader wake, four new calls, and one cancelled call's $0.08.

## 8. The weak spot this shows

The leader wanted the collectors to also note forum links they came across. That means editing
`steps.collect.brief` in the one file, and a changed brief changes every `collect` call's identity: all 34 would run
again. So it wrote a new step and left the old brief alone. That is the right call here, but it
is a constraint an author has to know about, and the dry run is what warns them: it would have
shown "34 calls restarted, about $45" before anything was spent.

The rewrite submits `{t: 'rewrite', file: '<draft>/plan.expedition.ts', why: '...'}`.
Both files carry the same plain owner contract. The rules gate compares its canonical value,
including defaulted caps, before applying any rewrite. The full prose of every original prompt
is embedded in each file; the Codex critic is reviewed by Claude, and Claude steps by Codex.

# Keyed expeditions: three final designs

Status: **v1 is built and on main, 2026-11-11:** [built system](v1/DESIGN.md) and
[runnable one-file examples](v1/examples/README.md). The three designs below are the
2026-11-10 research record; their code blocks are sketches. Conventions: `../../design-specs.md`. Background: `../fresh-keyed-scripts.md` (the
first draft of the shared base), `../research/use-cases.md` (the nine cases and 22 requirements),
`../research/prior-art.md` (what failed before).

## The core goal (the same in all three)

**The owner states a goal once. Agents on any harness work toward it for hours or days without
the owner present. The plan changes as the work teaches it. Nothing is lost, overspent or falsely
declared done, and the owner can see and steer the run at any time.**

A design meets the goal only if all of these hold:

1. Any shape of work: fan-out, deep serial, adversarial pair, population search, owner gate.
2. The plan can be replaced mid-run, keeping finished work, and the leader chooses what to kill.
3. It survives a backend restart without re-running or re-spending.
4. Money, time and machines are never oversubscribed.
5. Only the host declares "done", against the owner's criteria; waiting on the owner costs nothing.
6. One id holds the whole run, and its history reads as one timeline.

## The shared base

All three designs keep these decisions, made in the design conversation of 2026-11-10:

- **A script, replaceable at any time.** Work is identified by key, never by position.
- **Reconcile by key.** Finished key: return the logged result. Running key: attach. New key:
  reserve, then start. Running key the script dropped: the leader says `cancel` or `finish`.
- **Three owners.** The owner writes the Contract, the leader writes the Script, the host writes
  the Log. Nobody writes another's.
- **`await`, not `yield`.** The script holds no state that matters, so the host can kill and
  re-run it.
- **No free strings.** Step names are property names in a table; outcome tags are literal unions.
- **A dry run before spending**, at launch and on every rewrite, giving an exact diff and cost.

## Three ideas of elegance

| | Design | Elegance means | It optimises | It gives up |
|---|---|---|---|---|
| A | [One rule](A-one-rule.md) | The fewest concepts. Everything is one kind of thing, run by one rule | Host size; nothing to learn twice | Readable scripts; host-enforced judging |
| B | [Reads like the plan](B-reads-like-the-plan.md) | A person can read the plan in a minute and the history at a glance | The owner's and leader's attention | A bigger host; conventions you must follow |
| C | [Cannot be wrong](C-cannot-be-wrong.md) | Mistakes are impossible to write, not caught later | Trust in results | More types; a compiler in the loop |

They differ most in **where a guarantee lives**:

| Guarantee | A | B | C |
|---|---|---|---|
| Budget and pools | host | host | host |
| Judge is independent of producer | library helper + dry-run warning | host, from the cast table | compiler |
| Unverified work cannot land or finish | host checks `done` only | host checks `done` only | compiler and host |
| Plan is readable | author's discipline | structure of the format | types name everything |
| Reflection points are visible | no | yes, named lines | yes, typed decisions |
| A bad rewrite is stopped | at dry run | at dry run, shown as outline diff | at typecheck, before dry run |

## Same case, three ways

Each design writes the GTM research case (case 1), so they can be compared line for line.

| | A | B | C |
|---|---|---|---|
| Script, GTM case (sketch) | about 45 lines | about 20 lines + 5 brief files | about 30 lines |
| Host concepts | 1 verb, 3 call kinds, 1 pool type | 3 verbs + phase, review, steps, roles, report | B's, plus brands and grants |
| Where the prompts live | strings or files, author's choice | one markdown file per step | one markdown file per step |
| Weakest case | 1, 9 (long prose plans) | 3, 5 (heavy typed data) | 7 (simple work pays the type cost) |

## Recommendation

Build **B on A's kernel, with two guards from C.**

- A's kernel is the host: one log, reconcile, reservation. It is small enough to model-check.
- B's format is what people and leaders write and read. Its extra host parts (phases, the
  outline, the standard report) are thin layers over A's log, so they can be built second.
- From C, take the two guards that cost the author nothing: only judged-passed work can land or
  finish, and a rewrite is typechecked before it is dry-run. Leave the rest of C until a real run
  shows a mistake the cheaper guards missed.

The order to build: A's kernel with the Quint model, piloted on the GTM case written in B's
format; then B's layers; then C's two guards.

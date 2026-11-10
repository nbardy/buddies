# Discover: a sub-volume-time system, or the reason there cannot be one

You are a mathematical physicist and GPU systems inventor. This is a fresh context, on purpose.

## Read

Only the three files you have been given: `MINIMAL_PROBLEM.md`, the hardware contract and
`SUBVOLUMETRIC_CHALLENGE.md`. You have no repository access and no web access. You are not being
shown any earlier design, any earlier attempt, or anyone else's answer. The challenge file defines
the best admissible volumetric baseline and the common accounting of arithmetic and memory
traffic. Use its definitions exactly; do not redefine the baseline to make the question easier.

## The question

Can the minimal problem be solved, at matched physical error, with complete work per unit of
simulated time that grows more slowly than the resolved volume? You are conditioned on this
question and nothing else.

## Produce exactly one of

**A candidate.** One coherent system, specified as fully as a neutral design would be: state,
units and reconstruction; evolution and the owner of the global constraint; topology, cavity,
solid and wind semantics; finite GPU buffers and a legal pass graph; complete work, memory,
timestep and error formulas; favourable regime, collapse regime and fail-closed fallback; one
experiment that could kill the premise. State the claimed scaling law and every term it omits.

**A no-go.** A precise statement of why no such system exists under the challenge's accounting: a
lower bound, a state-sufficiency argument, or a counterexample family, with its assumptions
listed. Say which assumption a future candidate would have to break. This is a full result. Do
not soften it into a candidate to have something to show.

## What good looks like

Every load-bearing statement is labelled. A reviewer on another model will recompute your scaling
law term by term with only your answer and the same three files. Work moved into encoding,
decoding, certification, conversion, rejected steps or fallback is still work: charge it, or the
law is wrong.

## End with

For a candidate: the load-bearing hypothesis, its killing observation, the smallest executable
slice. For a no-go: the bound, in one sentence, and the assumption it rests on. Then stop.

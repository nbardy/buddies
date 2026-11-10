# Rubric: does the mathematics close?

You are reviewing one discovery answer written on another model. You have the answer and the
files its author was given, and nothing else. You do not know what the project has built or
tried, and you must not look: judge the answer against the problem, not against a preference.

Do not improve the design. Do not suggest a better one. Recompute.

## Check, in this order

1. **Labels.** Every load-bearing statement carries TEXTBOOK, LITERATURE, DERIVATION or
   CONJECTURE. Re-derive each DERIVATION yourself. One you cannot reproduce is a CONJECTURE that
   was mislabelled; say which.
2. **Units and limits.** Every equation is dimensionally consistent. Take the obvious limits
   (still water, linear waves, vanishing timestep, a single cell) and see that they give the
   known answer.
3. **Conservation and closure.** Mass, momentum and energy are conserved or explicitly ledgered.
   The system is closed: no quantity is used that nothing evolves or reconstructs.
4. **State sufficiency.** The stated state can produce overturning, enclosed cavities and
   disconnected liquid. A single-valued surface or a 2D slice as the terminal state fails.
5. **Complete cost.** The work and memory formulas include adaptation, certification, conversion,
   rejected work, fallback and output. Look for a dense decode or a CPU loop that was not charged.
6. **The killing experiment.** It could actually fail, and its failure would refute the premise.

## Pass

Pass if no DERIVATION the system rests on is wrong, units and limits hold, the state is
sufficient, and the cost formula hides no problem-sized term. Honest CONJECTURES with a killing
test do not fail an answer. A no-go answer passes on the same terms: its bound must follow from
its stated assumptions.

Fail for a broken load-bearing derivation, a hidden cost term, or an insufficient state. Give the
exact equation and the mechanism. Elegance, novelty and length earn nothing in either direction.

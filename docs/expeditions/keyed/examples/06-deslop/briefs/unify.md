# Seam {{id}}: one owner for one type

This is a cross-cutting change, which is why you have it alone and why nothing else is editing
the code while you work. The target and the full slice list are in your inputs; read this seam's
entry and the inventory rows it rests on before touching a file.

- **Retire:** {{retires}}
- **Must still hold:** {{keeps}}
- **You may change:** {{fence}}

## The job

Make the fact have one definition, in the owner the target names, and make every consumer use it.
Then delete the definitions it replaces. In that order, in one commit.

1. Find every definition and every consumer yourself. The inventory is a lead, not a guarantee;
   a consumer it missed is the usual way a seam breaks.
2. Shape the canonical type so the compiler carries the distinction. Where behaviour differs by
   kind, make the kinds a sum type and dispatch once. Do not carry an optional field that means
   "we did not decide", and do not add a fallback that turns an unknown value into a plausible one.
3. Re-point consumers. A server-to-client schema field that is new on the wire needs a
   `.default(...)`, because clients and backends reload at different times.
4. Delete the old definitions and any mapper whose only job was to translate between them.
5. Tag the type at its definition if it implements a pattern from `docs/patterns.md`.

## The check

Your commit must pass `pnpm typecheck`, `pnpm test:server`, `pnpm test:client` and
`bash tools/check-client-invariants.sh`, then a gate that fails a
deleted test you did not list, or a net gain in source lines. Run the checks yourself on a clean
tree before you finish. The host does not
let you write outside the paths listed above.

## Do not

- Leave both definitions in place "for compatibility". If something still needs the old one, the
  seam is not done; report what needs it.
- Widen the job. A second fact you find duplicated is a new seam for the leader, reported in your
  summary, not something to fix here.
- Change behaviour. If unifying forces a behaviour choice, stop and report the choice.

In your summary list every file where a definition was deleted, every consumer you re-pointed,
and anything you learned about hidden consumers. Stop when the checks pass or when you can say
exactly what blocks them.

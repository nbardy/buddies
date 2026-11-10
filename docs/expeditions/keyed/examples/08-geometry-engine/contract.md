---
leader: document-model-lead        # a named Buddy; it reflects and may rewrite the plan
repo: ~/git/wave_sim
budget: { usd: 70, hours: 6 }
autoApply: { usd: 10 }             # a rewrite adding more new cost than this waits for the owner
pools:
  claude: { slots: 1 }             # one engineer, one conversation; this work is serial
  codex:  { slots: 1 }
  guard:  { slots: 1, scope: machine }   # the memory- and time-guarded CPU runner: one guarded run at a time on this machine
  replay: { uses: 1 }              # exactly one replay of the boundary suite. No second replay, no automatic retries.
done:                              # the host evaluates these on ONE commit; nobody else may
  - check: python3 tools/geometry/verify_receipt.py agent_notes/2026-10-30_own_geometry/G0_RECEIPT.json
  - review: { rubric: preserved-geometry, by: codex/gpt-6-sol/high }
  - owner: Do you accept the G0 boundary candidate and hand it to Product for the receiving checks?
rules:                             # appended verbatim to every brief
  - The guard caps are 268,435,456 B aggregate RSS and 60 s. Do not raise, bypass or split them. A guard stop is final for that run.
  - Never run boundary.test.ts, local.test.ts, occt.test.ts or any Product test yourself. The host runs boundary.test.ts once.
  - No OCCT, FreeCAD or native CAD, no GPU, no Modal, no new package. An unsupported shape refuses with a typed error; it never falls back to OCCT or to a sampled grid.
  - Do not edit boundary.test.ts, oompa/geometry/, field_core/ or any Product file. Do not weaken a tolerance or drop a refusal case.
  - The claim flags validatedPhysics, emergenceClaim, acceptedPhysics, objectiveComplete and matchedErrorSpeedup stay false.
---

# Goal

I decided on 30 October that internal geometry runs on our own implementation and OCCT stays only
at explicit external CAD exchange. The first replacement is the finite D2 analytic boundary: the
curved wall with the cylindrical bore, with real faces, trim curves, adjacency and meshes at the
0.45 m and 0.60 m radii. The code exists in `native_geometry/boundary.ts`. What does not exist is
a pass: the known-answer suite was killed by the guard at 270,024,704 B after 1.42 s, just over
the cap, with zero tests complete.

I want every original boundary case passing from a committed candidate under the unchanged caps,
and an independent reviewer confirming that the geometry behaviour is preserved. Then it goes to
Product for edit, Undo, publish and cold reopen, which are their tasks and not this one.

I authorized exactly one replay of the suite. The last expedition never used it: it spent its
attempts and ended on the deadline. So do the thinking first. The correctness here rests on
geometry that has to be derived (the bore cap meets the inner wall above a certain radius, and
that case must refuse), and the memory has to be shown to fit by construction before the replay is
spent, with checks that do not run the full geometry. If the replay fails, stop and tell me what
it showed. Do not ask the host for another.

## Not yet real

- `studio/design_kernel/native_geometry/derived.test.ts` does not exist. The engineer writes it in
  the first round: closed-form known answers and allocation-count bounds that never realize the
  full D2 boundary. Until it exists the `probe` command cannot run, so the launch dry run must
  accept a check whose file the plan's first step creates, or the file is committed empty first.
- `tools/geometry/verify_receipt.py` does not exist. It should check that the committed receipt
  names the candidate commit and the exact guarded command, that peak RSS and elapsed time are
  under the caps, that every test completed and passed, and that it matches the host's stored
  output of the `replay` call. It reads a receipt; it does not run the suite.
- `agent_notes/2026-10-30_own_geometry/G0_RECEIPT.json` and `DERIVATIONS.md` do not exist; the
  plan's steps write them.
- The `document-model-lead` Buddy id is assumed from "Document Model Lead" in the repo's notes.
- Real and used as they are: `python3 oompa/geometry/guard.py -- <command>` and
  `bun test ./studio/design_kernel/native_geometry/boundary.test.ts`. The use-case brief says the
  suite covers four radii; the test file was not run or audited for this example.

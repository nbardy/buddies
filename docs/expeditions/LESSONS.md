# Five real runs, November 11, 2026

These observations survive the implementation they tested. The evidence directories are
local, gitignored artifacts; they are not another supported expedition format.

| Run | Result | Evidence |
|---|---|---|
| 1 | met; 4 turns; $0.58; 223 s | `output/expedition-smoke-2026-11-11/` |
| 2 | met; 16 turns; $0.43 recorded (under-counted) | `output/expedition-run2-2026-11-11/` |
| 3 | failed, then repaired | `output/expedition-run3-2026-11-11/` |
| 4 | met; 5 turns; $0.0551; 144 s | `output/expedition-run4-2026-11-11/` |
| 5 | met; 7 turns; $0.0964; 105 s | `output/expedition-run5-2026-11-11/` |

Run 1 survived a backend SIGKILL three seconds into a turn, but exposed mistaken authority:
removing Buddy tools did not restrict native agent tools. A brief saying “no writes” did not
prevent writes. Every turn needs agent-cli capabilities. Claude global instructions also loaded;
requests must explicitly select instruction sources. Codex cannot exclude all global instructions.
A fixed $2 manager reservation consumed most of a $3 budget while the wake spent $0.04. Default
wake caps must scale with the contract. Keep prompts and answers inspectable, show the candidate
beside an owner acceptance, and distinguish waiting, refused and failed in the view.

Run 2 exposed Git metadata outside a linked worktree: Codex could edit but could not commit.
Grant its worktree admin directory, objects, branch refs and reflogs, never the entire repository's
metadata. Reviewers must receive a read-only checkout of the exact judged commit and its base diff;
an answer file alone does not let a judge read code. Claude dollars were 27% low because cache
writes at the one-hour tier were priced as five-minute writes. Use the canonical pricing function,
retain cache tiers, and charge the cap when usage is unavailable. Codex actually started a helper
despite disabled helper flags: this exclusion is advisory, and missing descendant usage is not free.
Repeated rejected manager decisions need useful immediate feedback, not paid wake loops.

Run 3 exposed the difference between streamed prose and the final answer. Codex first said it
would read instructions, then returned valid JSON; joining those messages made the answer malformed.
Use runTurn's final text. Read the last fenced JSON block, else the whole message as JSON, else
its last complete top-level JSON value; never salvage a nested value from a truncated container.
Claude's checkout read-block setting conflicted with sandbox shell auto-approval and refused a
normal test-and-commit chain. That setting is now handled by agent-cli; project and managed rules
can still refuse commands. Codex's read-only shell must be named as available or a reviewer may
claim it has no way to read code. A returned `files: ["greeting.mjs"]` means relative existing files,
not invented reference IDs: check lexical and realpath containment before releasing the checkout.

Run 4 checked the repairs with both checkout providers, both opposite-provider reviewers, host
tests, manager rewrite and owner answers. Reviewers quoted real code and diffs. Settled work was
reused after rewriting. The goal told the manager what to add, so it did not test independent
manager judgment. A detached MCP relay survives its backend by design and exits after five idle
minutes; it is not automatically an orphan to kill.

Run 5 checked the unchanged one-import format, two-item native Promise fan-out and resolved
defaults. Six settled keys were reused and only the added step started after the manager rewrite.
Codex ran a shell heredoc and `mktemp "$TMPDIR/..."`; excluding both `/tmp` and every writable temp
directory had previously broken heredocs. Give each write turn a private temp directory outside
read roots, retain it through adoption and remove it after settling. Run 5 did not exercise a
rejected rewrite, hostile boundary attempts or helper accounting; those require separate proof.

Per-turn probes test actual tools and output, not the model's assertion that it obeyed. Keep
one claim per cheap probe: folding temp conformance into a checkout brief caused a low-effort
Codex model to skip one of seven instructions twice. The answer footer must permit all renderings
the reader accepts; a mandatory fence previously overrode the bare-JSON probe's brief.

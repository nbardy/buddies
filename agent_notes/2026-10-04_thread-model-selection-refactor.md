# Thread model selection replacement — 2026-10-04

Implementation of owner decision (accepted), not a new product proposal. Base:
41b54437dd3ea1a1d79fe5ccfc22fdf07c331709. Decision source: dated note
`2026-10-04_unified-thread-model-selection-decision.md`, SHA256 recorded below at delivery.
Predecessor: `2026-10-04_claude-thread-limit-root-cause.md`,
SHA256 71c1817b7450e1820edaabb68112d1c0adea7409b181a67777a43049591b3973.

## Replacement map (before editing)

- Workflow: owner mentions Lead in an old Claude thread, explicitly chooses Codex,
  Codex fails before posting. `threadModel` ignores the failure and reselects the
  old successful Claude reply; `seatFor` separately decides provider/generation;
  the client independently selects chip and picker values. Retry starts at an
  arbitrary catalog provider. Plain weekly-limit failures hide retry entirely.
- Canonical value remains `ConversationConfig`, e.g. codex / explicit gpt-6.1-sol /
  explicit high. The existing record's provenance records an explicit thread
  override (`user`; inferred seats use `legacy_inferred`); this is the already-required override fact, not
  another config, settings table or controller. Existing user records have no reliable
  historical picker evidence; conservatively preserve their saved intent. No live migration.
- Existing records authority owns persistence/CAS. A chosen mention/retry stamps
  provenance before executing, even when its config equals the current one. A
  read chooses override > latest live post's config > remembered seat > profile.
  Deleted references are skipped; unavailable config is preserved so resolution
  fails visibly rather than silently switching provider. Provider strings pass
  unchanged. Scope is (thread root, Buddy), never workspace-wide.
- Dispatcher: `keep` resolves the authority once; `chosen` changes that authority;
  a gate hands its resolved seat to the reply, which cannot choose another config.
  Generation selection is solely provider identity (same provider resumes).
- Delete `seatFor` and the second history/seat precedence decision. Resolve each
  composer's MentionChoice once; chip, bottom-bar model control, popover and send
  consume it. Remove the parallel `profile` value field/conversion in MentionChoice.
  Retry seeds from the same thread read instead of catalog-first selection.
- Preserve creation, tombstone, authority, queue/read-through, provider locking,
  idempotency and effort contracts. Tests use real temp stores, owner HTTP, MCP and
  runtime with only provider execution substituted. Required guards: failed
  override/reopen, same-value choice, gate snapshot, per-Buddy isolation, history
  fallback/deletion, weekly-limit retry rendering. Desktop/phone read-only captures.

The owner explicitly authorized this existing selection refactor. The existing provenance
values distinguish saved owner intent from inferred selection; no public owner or
Buddy tool schema gains a new setting. Removing that distinction would lose the difference
between explicit intent and historical inference after a backend reload.

## Implementation successor and evidence — 2026-10-04

Decision-maker: owner (product contract above); worker implementation choices below.
Accepted scope stays correctness/refactor. There is no new settings store or controller.
Decision source SHA256: 01e487e790edfa70aee97bd6ceb5b3d29622149e10345d4310bdea150186a441.
Preserved excerpt: “A changed choice is an explicit override and persists for subsequent
replies, including after a failed attempt. Without an override, initialize from the most
recent model used for this Buddy in this conversation/thread; without prior usage, use
the Buddy default.” Exact owner message id was not in the source; not reconstructed.
Both original decision and predecessor contents are preserved with the artifacts below.

Replacement completed:

- `seatConfig` is the thread selection: a chosen config or saved `user` intent wins;
  inferred seats use latest live Buddy-post config, remembered seat, then current profile.
  `seatFor` was deleted. Gate passes a `resolved` seat into execution instead of repeating
  the selection and misclassifying an inferred gate decision as an explicit choice.
- Existing records' creation and CAS paths persist the origin before execution. An
  explicit same-value pick writes the origin too. Rust's existing provenance values and
  SQLite schema stay unchanged; optional host input preserves ordinary edits' `user`
  default. The host field is not added to owner HTTP, WS or Buddy tool contracts.
- One composer selection supplies the bottom mention control, chip, popover and send.
  Deleted `pickerValue`, the parallel profile value representation and private label
  formatter; `modelSummary` includes effort. Unread thread seats are explicitly loading.
  Existing device-local drafts now retain unsent per-Buddy choices; inferred display
  never becomes an override just because the owner sends. Restored mention identity
  follows the current directory profile rather than a stored profile snapshot.
- Moved existing server `config-mapping.ts` to shared and deleted the independent client
  default builder. Model-only profiles now infer the same provider on both sides.
  This move is counted across both locations, not presented as a net deletion.
- Retry reads the same thread projection and waits for its seed; it cannot initialize
  from catalog order while that read is pending. Plain straight/curly-apostrophe Claude
  weekly-limit envelopes now offer model retry. Explicit retry uses existing dispatch.
- Added two real screenshot inventory entries; moved the misplaced image-viewer entry
  from the HTML escaping function into the inventory. The inherited misplaced entry
  crashed contact-sheet generation after successful capture. Added gallery/inventory
  regression tests. Temporary-server dependency prompts are dismissed via their local
  Continue action; the read-only capture still blocks network writes and WS sends.

Meaningful failing-before evidence: the real owner-HTTP/native-records regression showed
`display equals failed invocation` failing: old Claude selected after an explicit Sol
attempt failed. The exact plain weekly-limit ReplyRetry rendering regression produced
an empty string before repair. Both pass now. The temp-store regression compares the
same config/effort against HTTP thread display, a reopened real records store/fresh
responder, should-reply gate and provider invocation; retry is owner HTTP (202), not
only a classifier unit. Additional guards cover same-value choice, another Buddy's
independent selection, empty default, deleted/unavailable history, provider generation,
resumed effort and a new post arriving while the gate is held. No actual provider CLI
is launched: only execution is substituted in the integration runtime.

Pre-commit checks on this candidate: full server 243 pass / 0 fail / 1 skip (244 tests);
focused selection checks passed again after shared mapping; client focused 14/14;
Rust ingest suites 57/57 and real native-records JS boundary 1/1; tools 12/12;
`pnpm typecheck` (including client `tsc -b` and both test projects) and all nine client
invariant gates passed. The final clean COMMIT is checked separately; its results live
in RESULT.md in the artifacts directory rather than asserting that a dirty tree proves
its commit. Full client earlier: 221 pass / 2 fail (223). Both failures reproduce using
unchanged base UI: old “different harness” label expectation in channel-dm and stale
Task-filter rendering expectation in channel-restored. They are outside this lane.

Desktop/phone captures: six screenshots, zero skips. Visually inspected both model
popovers, the bottom chip and the plain weekly-limit retry. The same temp-store API
serves baseline and after; baseline uses base UI assets, after uses candidate assets.
Both shells show Codex / GPT-6.1 Sol / high. Pixel comparison exits 1 intentionally:
retry appears and shifts bottom-aligned thread content; effort enters the chip label.
Five pairs changed (0.320%–2.358%); phone open picker is 0%. No CSS changed. This is
visible-change evidence, not a claimed zero-pixel refactor. Captures record blocked
read-mark/diagnostic POSTs and a still-pending background sigil worker; no agent ran.
Baseline PNGs/manifest completed but its original gallery crashed on the inherited
escaping bug; the preserved baseline gallery was rendered from that exact manifest
with the repaired function, without recapturing pixels.

Net scope (all source languages, including moved mapping): +211/−147 = +64 source
lines. Tests +479/−8 = +471; generated addon declaration +2; tooling/package script
+57/−12 = +45. Documentation counted separately. This removes competing decisions and
converters but is not an overall line-count reduction: durability, async loading and
persisted unsent-choice behavior need additional code. No unused alternative path is
kept behind a feature flag.

Material limitation: historic seats were stamped `user` even when their initial config
was inferred. No durable click history distinguishes those cases. This lane preserves
existing saved configs conservatively as intent rather than guessing or migrating live
records. New inferred seats are correctly marked; a subsequent explicit choice is
unambiguous. Revisit historic repair only with actual selection evidence and separate
owner-authorized migration. Provider execution itself and live activation are unproved
here. No live DB opener/send/restart/merge/push occurred; the isolated review backend
uses fresh stores and a PATH with no agent CLIs. Integration code uses temp stores only.

Artifacts, including logs, PNGs, baseline/after manifests and compare sheet:
`/Users/nicholasbardy/.codex/artifacts/unified-thread-model-2026-10-04/`.
Branch `fix/unified-thread-model`; isolated Cambium worktree
`/Users/nicholasbardy/git/unleashd-thread-model` is removed after RESULT is written,
retaining the branch for integration. Base is named above; HEAD hash is in RESULT.

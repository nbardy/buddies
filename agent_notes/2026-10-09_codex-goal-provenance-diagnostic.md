# Codex goal provenance and mixed transcript diagnostic

Recorded 2026-10-08 18:07 UTC / 2026-10-09 Asia/Makassar. Diagnostic request
`post_01a11cae-7fff-77cb-a35a-ad782c8b00d9`, Task
`task_01a11cae-1e3c-7481-abd1-0558c260b3e4`. Branch:
`diagnostic/codex-goal-provenance-20261009`. No merge, push, live restart,
goal mutation, or live store access.

## Question and result

Initial source question: can the current canonical Codex ingest attribute a
generated goal prompt to the owner, or omit real owner messages by selecting
events instead of response items? Answered from the parser and existing format
tests within three source reads. Further source inspection was limited to test
helpers and the separate restart coverage question.

Synthetic reproduction, NOT the incident's native export:

1. response user: `owner before event mode`
2. response user: `paired owner message`
3. event user_message: `paired owner message`
4. response user: `owner after event mode`
5. event agent_message: `reply`

Actual output: `["paired owner message", "reply"]`. Desired output:
`["owner before event mode", "paired owner message", "owner after event mode", "reply"]`.
Two distinct owner messages are omitted; this is more than paired-message
deduplication. The same omission occurs at EVERY incremental-read split through
the real `read_source` boundary and serialized checkpoint. This does not establish
that either missing message in Wave_sim was response-only, or even persisted.

Untagged `<codex_internal_context source="goal">Continue the goal.</codex_internal_context>`
is retained as `Role::User` when recorded as either response user or event
user_message. The fixture supplies no generated-origin metadata. Thus this proves
a possible attribution path, not the actual provider's provenance representation.
It equally represents a real owner's paste; a text-prefix filter is unsafe.

## Versioned source evidence

Base commit `30a1695192f97dfcb8d82a0b21c149246870f3a1`; all sources below were
clean tracked bytes at that commit (SHA-256):

| Source | SHA-256 |
| --- | --- |
| product/buddies/CORE_DESIGN.md | ec8f932c8eb614bce9eb76dd01d2741b6965b39398a42857f3fb5f862c7a488d |
| crates/unleashd-ingest/src/parsers/codex.rs | e5442fcda00c24bba37ca9ec631f5242c6e81a66f79c78f4f09674ac9b737a80 |
| crates/unleashd-ingest/tests/formats.rs | 7c50187d3e94523add8a2a1ef92d6ef92d30214da4869171f58de33d8c85a4fa |
| docs/turn-lifecycle.md | c3d441ebf2fdd0a26935df7a16bdf237f9d3459101a7a1ebaccdf2449b0a1e05 |
| server/test/execution-adoption.test.ts | 747a0deff027f6b79965ee60b6d555b2c73388c7a9de20ca0968160947d72189 |

Preserved relevant parser excerpts (line numbers at base):

- 175: `SETUP_KINDS` includes only `agents_md.instructions`,
  `environments.environment_context`, `plugins.recommendations`.
- 180–212: response user setup extraction uses
  `internal_chat_message_metadata_passthrough.content_item_kinds`; the only
  text-shaped fallback is the exact three-block startup envelope.
- 284–292: entering event mode sets `has_events`, removes buffered response
  messages, withdraws their seqs, and restores the other-message previous state.
- 416: `let is_response_message = !self.events_seen && outer == Some("response_item") && inner == Some("message");`
- 492–495: user_message unconditionally receives `Role::User` and uses the
  payload's `message` string; response setup extraction is not called.

## Test evidence and limits

Reproducer: `crates/unleashd-ingest/tests/codex_goal_diagnostic.rs`.
From `crates/`:

```
cargo test -p unleashd-ingest --no-default-features --test codex_goal_diagnostic -- --nocapture
```

2 characterization tests PASS; 1 desired regression intentionally ignored.
Explicitly running it with `--ignored --nocapture` exits 101 and shows exactly
the actual/desired arrays above. It is ignored in ordinary runs because this
branch documents a defect rather than shipping a fix. Do not interpret passing
characterizations as correct behavior.

```
cargo test -p unleashd-ingest --no-default-features --test formats --test tail
```

19 PASS, including paired event/response deduplication, tool preservation,
interruption notices, checkpoint resume equality, and withdrawal without a reread.
No production source or UI changed; no screenshot proof or live-provider goal
restart proof is claimed. These parser tests write only temp JSONL files and
use no owner's SQLite stores.

## Restart question, separate from display

At the base commit, docs/turn-lifecycle.md describes journal-backed detached
provider execution, ownership before spawn, byte-zero replay on adoption, same
grant and absolute deadline restoration, and removal only after settlement.
The existing execution-adoption.test.ts exercises an actual backend SIGKILL and
replacement, but its provider is a FAKE CLAUDE process. It covers surviving running
turns, a turn finishing during outage, Stop/timeout across a crash, drain/settle
crashes, and an owner message queued behind a running turn surviving exactly once.
It contains no native Codex `get_goal` assertion, original goal horizon assertion,
or real Codex goal-continuation scenario. I inspected coverage; I did not rerun
that backend suite and claim new adoption evidence. Documentation guarantees
process adoption, not proof that this particular native goal survived.

## Live scope boundary and relayed evidence

`runs list(scope.workspace=project_88cdc98e-13d1-426a-9544-7e7830a2b5c6)` was denied:
`workspace project_88cdc98e-13d1-426a-9544-7e7830a2b5c6 is not this turn's workspace`.
Stopped cross-workspace runtime queries; no filesystem/owner-API workaround.
Team roster identity is not execution evidence.

Parent message `post_01a11cb2-2fed-77bb-ab90-781159977fe7` relays CEO answer
`post_01a11cb1-c52d-7618-acb5-b0654936474f`: observed 18:05:44Z, three running
Codex preparation workers (A, SPUMA, DualSPHysics), not current GPU allocation.
The audit branch's `get_goal=null`; original native goal state cannot be queried
there. Original goal thread reportedly `01a11a9d-a24f-76b3-b98f-2617b6fd45bd`.
Original 09:44–21:44 UTC contract reportedly amended by owner at 16:45 to work
all night/until requirements and deployed integration. These are relayed status
facts, not independently inspected raw execution records or new permission to
change the goal. Recent delegation proves ongoing work at that observation, not
original CEO goal/restart continuity or present liveness.

## Proposed engineering successor (assistant recommendation)

Choice: retain the reproducer and defer production editing until scoped native
records establish the provenance/pairing contract. Decision-maker: diagnostic
worker; proposed repair direction, not an owner API expansion decision.

Smallest existing-contract correction candidates:

1. Replace global event exclusivity with bounded, per-message event/response
   reconciliation at the canonical crate parser. Preserve unpaired messages,
   replace paired records once, and preserve current incremental performance,
   ordering, tool history, markers and serialized-checkpoint compatibility.
   Avoid union-by-text: identical text from two real sends must remain two sends.
   Establish native turn/message identifiers from the export before selecting
   the matching key. Do not add a parallel TS transcript parser.
2. Classify generated goal context by the native provenance field at that same
   boundary, reusing existing System/display contracts as appropriate. Genuine
   owner pastes stay User. If events strip provenance, correlate with their
   response source; never infer generated origin from the text alone.

Required export: raw event/response pair around each disappearing owner submit
and generated continuation, their native metadata/turn ids, conversation and
provider session ids, submit/ack/queue/attempt timeline, exact abort reason,
journal adoption evidence, and original native goal state/horizon before/after
restart plus live provider handle/recent tool activity. Keep GPU worker handles
separate from CEO goal execution.

Revisit production deferral when that export supplies a reliable provenance and
pairing key. If it proves owner messages never reached native persistence, route
that loss to the existing failed-spawn persistence Task rather than importing
around it. A process adoption test and a native Codex goal/owner-steering test
on temporary stores remain necessary before closing the full incident Task.

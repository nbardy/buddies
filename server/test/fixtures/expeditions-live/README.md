# Live expedition ledgers (2026-11-01)

The four expeditions that sat in "needs you" on 2026-11-01, copied read-only from the owner's
store and scrubbed: identities and paths are `{{…}}` placeholders the test fills
(`replayLive` in `server/test/expeditions.test.ts`), briefs are replaced by a marker, chat
status posts are dropped, and long texts are cut to 200 characters (answers 500, owner
questions 700). Each ledger is cut just before its `finished` (every one later ran into its
deadline), so it holds the stuck state. Written before design.md R11: no question carries an
`acceptance`, malformed answers never had a repair turn.

- `actual-game-daily-local--e3153c`: three check verdicts written as prose ("VERIFIED.") with no
  json block; the manager asked the owner for a host repair.
- `emergent-beach-design-r1-bfeaca`: four unparseable manager answers in a row, then the host's
  "Nothing is running" question.
- `one-qualified-dualsphysi-404846`: a real owner question (missing native evidence).
- `own-engine-geometry-opti-1b837b`: the per-question acceptance deadlock; w64130b's verifier
  commit 48ce327 left behind a malformed answer.

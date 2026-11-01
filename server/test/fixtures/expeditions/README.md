# Expedition ledger fixtures

`own-engine-geometry-1b837b.ledger.jsonl`: the shape of the live expedition
`own-engine-geometry-opti-1b837b` on 2026-11-01, scrubbed to the entries that matter
(briefs, statuses and long texts dropped). It was written before design.md R11: its questions
carry no `acceptance`, its manager's bare-JSON answer and its worker's fence-less answer are
recorded `malformed`, and it ends in `needs_owner` asking for a host maintainer. The test
`server/test/expeditions.test.ts` ("a ledger shaped like the 2026-11-01 incident ...") fills the
`{{…}}` placeholders with a temporary repository, crew and chat, and replays it.

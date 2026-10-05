# Buddy HTTP contract audit

Owner asked for shared API/UI types after retry rejected the client's `key`.

Before: the server owns strict, local request schemas; UI writes accept arbitrary
objects, methods, paths and caller-chosen response types. Domain types come from
the crate, but they cannot check an HTTP request envelope. A matching mistake
already affected New chat and Retry with model.

Replacement: one shared mutation table names each operation's method, path,
success status and Zod body schema. Types are inferred from that schema; success
results reuse generated crate types and existing conversation IDs. The client
selects a named operation, supplies typed path params/body, and adds a key only
where the canonical schema declares it. The server consumes the same schemas
and route definitions; its handler return types must match the shared results.
The server remains the authority for authorization, revisions and writes.

Delete the loose buddyWrite/buddyAction signatures, local HTTP body schemas,
duplicated core field schemas and manually assembled JSON mutation requests.
Preserve strict parsing, profile null/default semantics, media handling,
mention choices, key replay behavior, thread routing and action responses.
Test actual client requests over owner HTTP, plus compile-time rejection of
unknown fields, wrong methods/params and response assumptions.

Audit finding: task Move up/down passed `{ task, position }` as the changes bag.
The server's nested strict schema rejects `task`; existing ordering tests never
sent the patch. Send only `{ position }`, guarded through the real patch boundary.

Scope: all owner Buddy JSON mutations (and the existing upstream update action).
Multipart media has its own typed upload boundary. Other app APIs and Buddy MCP
tool contracts retain their existing authorities.

Delivered: 24 Buddy JSON operations plus upstream update use the shared table.
Core/MCP field schemas are re-exported from that same source, not copied.
Client writes derive request and result types; server handlers must satisfy the
shared success result map. The read helper no longer accepts mutation options.
Multipart media now has one shared success shape too.

Additional repairs:
- Synchronous route parsing failures now enter the same JSON/400 error handler
  as asynchronous ones, instead of escaping as Express HTML error pages.
- Schedule form replacement preserves taskId rather than detaching its Task.
- A retry refused by eligibility now displays its reason instead of appearing
  successful. A real archived-Buddy request guards this.
- Optional undefined keys receive a generated key; explicit caller keys survive
  replay unchanged.

The actual client writer, reorder action and schedule projection run against the
real Express routes and temp native store in server/test/buddies-v2.test.ts.
client/test/buddy-api-types.ts is compiled but never run: expected-error checks
reject missing config, extra/nested fields, wrong parameters/doc kinds/revisions,
arbitrary URLs/methods, unkeyed/bodyless key injection and incorrect result types.
Updated one stale client assertion that still expected the former retry label.

This is a contract unification, not a line-count reduction: across touched TS/TSX,
source grew by 339 lines and tests by 236. The extra source names the closed route
and result maps; it replaces the existing loose path/method/body/result signature.
No Rust or generated native code changed, and no live store was opened externally.

Verification: 53 Buddy/upstream integration tests, the 2 final HTTP regressions,
231 client tests, pnpm typecheck (including the negative compile guards), all
9 client invariant gates, Biome check and git diff --check passed. Biome retains
3 pre-existing warnings (title-effect dependencies and an unused test helper).
No styles or layout changed. Live backend rollout was not verified.

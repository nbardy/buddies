# 2026-10-05 — Channel search: fuzzier matching, @author, readable results

Status: PROPOSED by Buddies Development Lead (assistant recommendation). Owner asked the
questions; owner has NOT decided on embeddings. Phase 1 is filed as a fix because it answers
concrete owner-reported failures.

## Owner report (#buddies-dev, post_01a10b36-ac76-7614-bf40-b07b6351ed78)
- "market" returns nothing although there is a #marketing-website channel and "go to market" posts.
- `@"name"` cannot search a Buddy's messages.
- Results show raw `**` instead of rendered markdown; no highlight of the matching span;
  too dense, wants more content and whitespace.
- Asked: are we on SQLite, what matching exists, how hard is a fast embedding model.

## Evidence (main @ 3a6cc84)
- Engine: SQLite FTS5 external-content table `post_search(body)`, default unicode61 tokenizer
  (crates/unleashd-buddies/src/schema.rs:157). Indexes post BODY only — not author, not channel name.
- Query: `search_posts` quotes every whitespace word and ANDs them
  (crates/unleashd-buddies/src/posts.rs:451) => exact whole-token match, no prefix, no stemming,
  no typo tolerance, ordered newest first (no relevance). "market" ≠ "marketing" token.
  A "go to market" post should match; if the owner saw nothing, the worker must reproduce
  (possible second cause: visibility/workspace scope).
- UI: client/src/components/buddies/ChannelSearch.tsx `excerpt()` flattens whitespace and cuts
  to 180 plain-text chars => raw markdown markers, no highlight.
- feat/structured-search @ 74d1fd3 (UNMERGED) adds typed search with phrase/exclusion/OR and
  channel/author/date/thread filters; it does not add prefix/stem matching.

## Options considered
1. Prefix + Porter stemming (`tokenize='porter unicode61'`, terms as `"w"*`): one index rebuild,
   hours of work. Fixes market/marketing, post/posts. Chosen for phase 1.
2. Trigram tokenizer: substring anywhere; ~3x index; no stemming. Not chosen: stemming + prefix
   covers the reported failures; trigram is the fallback if partial-word-inside matches are wanted.
3. Typo tolerance via `fts5vocab` + single-edit expansion for longer terms: small Rust addition.
   Included in phase 1 ("fuzzier").
4. Embeddings (semantic/hybrid): local ONNX model (~30–130 MB, e.g. bge-small via fastembed),
   embed on write + backfill, vectors in a side table with brute-force cosine (post counts are
   small enough for ms-scale scans) or sqlite-vec, fuse with BM25 by reciprocal rank.
   Estimate 1–2 focused days + permanent packaging weight in a local-first app.
   Deferred: decide after phase 1 using real missed queries.

## Revisit when
Phase 1 is live and queries still miss for meaning-level reasons (synonyms, paraphrase).

# Unified thread model selection — owner decision, 2026-10-04

Status: ACCEPTED owner direction in #general root post_01a105a9-6cce-7497-9858-2e6a91c9f1a3, subsequent message beginning "Okay but if we @ them". Exact new-message ID was not supplied by the turn context.

Question: how can the composer show Codex while the thread executes Claude?
Evidence: predecessor root-cause note sha256 71c1817b7450e1820edaabb68112d1c0adea7409b181a67777a43049591b3973; preserved dated API excerpts in that note. Baseline implementation 02b75b3. This successor preserves the root-cause findings and corrects the incomplete product contract: matching server selection alone is insufficient if the composer displays another selection.

Owner choice: one model-selection path supplies the composer/bottom picker, mention chip, should-reply check, actual reply and retry. A changed choice is an explicit override and persists for subsequent replies, including after a failed attempt. Without an override, initialize from the most recent model used for this Buddy in this conversation/thread; without prior usage, use the Buddy default. The picker must show the model that will execute, including when an old thread differs from a changed profile default. First mention initializes the composer picker consistently; explicit per-Buddy choices remain scoped to that Buddy.

Before: server thread history and remembered seats determine execution while composer/picker defaults can independently suggest another model. Plain weekly-limit failures omit recovery.
After: one canonical ConversationConfig selection, owned by the existing conversation/thread configuration authority, with picker and execution as its consumers. Core dispatch receives the selected config; it does not choose a second model. Canonical absence means no override/history and therefore profile default; deleted/unavailable references require an explicit documented fallback rather than invented usage. Provider-specific effort values pass through unchanged.

Required deletion: competing picker seeding/precedence and duplicated gate/reply/retry selection. Engineer identifies exact superseded functions from code and reports deletions. Do not add a second settings store/controller or silently change provider on quota failure. Desktop/mobile remain separate shells consuming the same selection.

Evidence required: real-boundary regression for old Claude thread + Codex profile: picker agrees with actual execution; explicit Codex override wins and survives failure, next reply and backend reload; empty thread uses profile default; gate uses same chosen config; retry uses explicit selected config and exact weekly-limit envelope renders recovery. Screenshots desktop/phone prove visible selection/retry. Verify the committed candidate, report source delta and existing behavior preserved. No live agent send/restart/main push or data migration is authorized by this refactor request.

Tradeoffs: preserve intentional thread continuity over global profile changes; make the contextual selection visible instead of silently replacing it. Revisit if owner later wants profile changes to override existing conversations. This is an owner-requested correctness/refactor scope, not an assistant recommendation for new API concepts.

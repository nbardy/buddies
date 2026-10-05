# 2026-10-05 — Channel search: prefix/stem/typo, @author, channel rows, rendered excerpts

Implements task_01a10b37-e7d8-7689-b16f-98254db2f8d5 (decision: 2026-10-05_search-fuzziness-decision.md).
Branch feat/channel-search-fuzzy (feat/structured-search 74d1fd3 cherry-picked onto main f3d6cf1).

## Owner miss, reproduced on a COPY of the live buddies DB (throwaway servers, no agent CLIs)
- Paint Live: "market" → main 0 posts; branch 13 posts + #marketing row.
- unleashd: "market" → main 3 (exact-token posts ARE found; no visibility/scope second cause), branch 50 (cap).
- Conclusion: the miss is word forms (marketing/markets), not scope. Searching the wrong workspace is the other
  plausible cause (search is per workspace).

## Decisions
- Open question (typo vs exact ranking): typo terms are a FALLBACK, used only when the exact/prefix/stem query
  finds nothing (decided per query, ignoring the page cursor). With typos always ORed in, "market" also matched
  marker/marked (3 hits → 50 on real data). Typo hits therefore never share a list with exact hits; ordering stays
  newest-first.
- Porter quirk: it stems the QUERY "deploy" to "deploi" but stores "deployment" as "deploy", so `"deploy"*` misses
  "deployment". Words ending in y (6+ letters) also get the y-less prefix. Documented in search.rs.
- Typo terms are exact quoted stems (a `"mark"*` prefix would match "market").
- First letter of a typo'd word is taken as typed (vocab read by term range; keeps the plan guard satisfied).

## Gaps / not done
- ChannelSearch is mounted only by the desktop ChannelBrowser; the phone tree has no channel-search surface, so
  there is no phone screenshot (new mobile UI is out of scope).
- Client highlight marks words starting with the typed word or its suffix-stripped stem; a typo hit shows its lines
  unmarked.
- tools/screenshots.mjs: contact sheet crashes on main (an `image-viewer` screen block sits inside escapeHtml,
  ReferenceError noChannel). PNGs still save. Not touched.

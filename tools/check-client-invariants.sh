#!/usr/bin/env bash
# check-client-invariants.sh — client architecture gates (G1-G9; see docs/mobile-view-tree.md)
# Fails CI if any invariant is violated. Zero custom plugins — stock grep only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0

echo "==> Gate G1: jotaiStore.set outside client/src/atoms/ — components call actions, never write atoms"
# Allowlist: only files under client/src/atoms/ may call jotaiStore.set
# mutate.ts wraps jotaiStore.set inside atoms/ — allowed; everything outside must be zero.
if grep -R --include="*.ts" --include="*.tsx" -n "jotaiStore\.set" client/src 2>/dev/null | grep -v "client/src/atoms/" | grep -v "node_modules" ; then
  echo "G1 FAIL: jotaiStore.set found outside client/src/atoms/. Components must call actions, never write atoms directly."
  echo "  Fix: move the write into an action in client/src/atoms/actions.ts (or another module in client/src/atoms/)."
  FAIL=1
else
  echo "G1 PASS"
fi
echo

echo "==> Gate G2: raw .buddyContext / .purpose reads in client/src/mobile/ — use the row kind"
# All mobile code must read identity from the row's `kind` via matchConversationKind
# (shared/src/conversation-config.ts), never raw field access. One-allowed consumer is components/buddies/buddies-shaping.ts
# which is outside mobile/. Zero hits expected in mobile/.
# Exclude parsed.*.purpose from buddy-review-message parser (pure helper, not Conversation.purpose).
if grep -R --include="*.ts" --include="*.tsx" -n "\.buddyContext\|\.purpose" client/src/mobile 2>/dev/null | grep -v "parsed\.purpose" | grep -v "parsed\.subjectBuddyId" | grep -v "No raw \.buddyContext" ; then
  echo "G2 FAIL: raw .buddyContext or .purpose read in client/src/mobile/. Read row.kind / matchConversationKind()."
  FAIL=1
else
  echo "G2 PASS"
fi
echo

echo "==> Gate G3: the two shells never import each other (O1, lean-scope 06 §2.3)"
# Mobile shell = client/src/mobile/. Desktop shell = client/src/components/
# outside components/buddies/ (shared Buddy views both trees render).
# - mobile/ never imports the desktop shell;
# - the desktop shell never imports mobile/.
# The third half of O1, "views/ never imports a shell or mobile/", is
# client/test/views-boundary.test.ts (run by `pnpm test:client`), not repeated here.
# Imports are resolved against the importing file's dir, so "../components" from
# mobile/index.ts is caught even though its text looks like mobile/components.
if ! node <<'NODE'
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const SRC = path.join(ROOT, 'client/src');
const MOBILE = path.join(SRC, 'mobile') + path.sep;
const COMPONENTS = path.join(SRC, 'components') + path.sep;
const BUDDIES = path.join(SRC, 'components/buddies') + path.sep;
const isDesktop = (p) => p.startsWith(COMPONENTS) && !p.startsWith(BUDDIES);
const isMobile = (p) => p.startsWith(MOBILE);
const RULES = [
  { from: isMobile, to: isDesktop, what: 'mobile shell imports the desktop shell' },
  { from: isDesktop, to: isMobile, what: 'desktop shell imports the mobile shell' },
];
const importRe = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']*)["']/g;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(p) ? [p] : [];
});
const violations = [];
for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(importRe)) {
    const target = path.resolve(path.dirname(file), m[1]) + path.sep;
    for (const rule of RULES) {
      if (rule.from(file) && rule.to(target)) {
        violations.push(`${rule.what}: ${path.relative(ROOT, file)} -> ${m[1]}`);
      }
    }
  }
}
if (violations.length) { violations.forEach((v) => console.error('G3 violation: ' + v)); process.exit(1); }
NODE
then
  echo "G3 FAIL: a shell imports the other shell. Move the shared piece to views/, ui/, hooks/, utils/ or atoms/."
  FAIL=1
else
  echo "G3 PASS"
fi
echo

# Both remaining gates ban a secure-context-gated browser API outside its
# wrapper. They are text greps, so a doc comment naming the API would trip them
# — strip comment lines (leading //, * or /*) before matching.
strip_comments() { grep -v -E '^[^:]*:[0-9]+:[[:space:]]*(//|\*|/\*)'; }

echo "==> Gate G4: bare crypto.randomUUID() — secure-context only, undefined over plain-http LAN"
# The dev server is opened on phones via http://<lan-ip>:7489, which is NOT a secure
# context, so crypto.randomUUID is undefined there and every creation path throws.
# client/src/utils/ids.ts owns the getRandomValues-based fallback; it is the one
# allowed reference to crypto.randomUUID.
if grep -R --include="*.ts" --include="*.tsx" -n "crypto\.randomUUID" client/src 2>/dev/null | grep -v "client/src/utils/ids.ts" | strip_comments | grep . ; then
  echo "G4 FAIL: bare crypto.randomUUID() outside client/src/utils/ids.ts."
  echo "  Fix: import { newId } from '<...>/utils/ids' and call newId()."
  FAIL=1
else
  echo "G4 PASS"
fi
echo

echo "==> Gate G5: bare navigator.clipboard — same secure-context trap as G4"
# navigator.clipboard is undefined (not merely rejecting) in a non-secure
# context, so `navigator.clipboard.writeText(...)` throws a TypeError before it
# can be caught as a rejection. client/src/utils/clipboard.ts owns the
# execCommand fallback and reports success as a boolean.
if grep -R --include="*.ts" --include="*.tsx" -n "navigator\.clipboard" client/src 2>/dev/null | grep -v "client/src/utils/clipboard.ts" | strip_comments | grep . ; then
  echo "G5 FAIL: bare navigator.clipboard outside client/src/utils/clipboard.ts."
  echo "  Fix: import { copyText } from '<...>/utils/clipboard' and check its boolean result."
  FAIL=1
else
  echo "G5 PASS"
fi
echo

echo "==> Gate G6: one owner per CSS class — the same class defined in two .css files"
# CSS here is global (plain .css imports, no modules). Two files defining the
# same class silently fight over the cascade: import order picks the winner and
# the loser leaves no trace. This cost real debugging time when a header chip
# picked up SwarmDetail's .config-summary { flex-direction: column }. Shared
# primitives (.empty-state, .provider-badge) live once in client/src/App.css;
# everything else is prefixed with its component.
DUPES="$(
  while IFS= read -r f; do
    grep -o -E '^\.[a-zA-Z0-9_-]+' "$f" | sed 's/^\.//' | sort -u | sed "s|\$| $f|"
  done < <(find client/src -name '*.css') | awk '{print $1}' | sort | uniq -d
)"
if [ -n "$DUPES" ]; then
  echo "G6 FAIL: these classes are defined in more than one .css file:"
  while IFS= read -r c; do
    [ -z "$c" ] && continue
    echo "  .$c"
    grep -l -E "^\.$c[[:space:],{:]" $(find client/src -name '*.css') | sed 's/^/      /'
  done <<< "$DUPES"
  echo "  Fix: prefix the class with its component (.chat-config-summary, not"
  echo "  .config-summary), or move a genuinely shared primitive to client/src/App.css."
  FAIL=1
else
  echo "G6 PASS"
fi
echo

echo "==> Gate G7: no literal px font-size / padding / gap, and only the two breakpoints"
# Pattern: tokens-and-shells (docs/patterns.md#tokens-and-shells)
# T21a collapsed 45 font sizes and 172 paddings onto the scale in
# client/src/ui/tokens.css; this keeps a new `padding: 7px` from starting the
# drift again. Breakpoints cannot be var(), so their VALUES are checked: 768px
# (device switch) and 340px (compact phone), see tokens.css.
# Every stylesheet is covered: the last exemptions (Channel*.css,
# mobile-channels.css) reached 0 on 2026-09-26 and KNOWN_LITERAL is gone.
if ! node <<'NODE'
const fs = require('fs');
const path = require('path');
const SRC = 'client/src';
const TOKENS = 'ui/tokens.css';
const BREAKPOINTS = new Set(['768px', '340px']);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const DECL = /(?:^|[{;\s])(font-size|padding(?:-[a-z-]+)?|gap|row-gap|column-gap)\s*:([^;{}]*)/g;
const PX = /(?:^|[\s(,])-?(\d*\.?\d+)px\b/g;
const bad = [];
for (const file of walk(SRC).filter((f) => f.endsWith('.css'))) {
  const rel = path.relative(SRC, file);
  if (rel === TOKENS) continue;
  const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const hits = [];
  for (const m of text.matchAll(DECL)) {
    const line = text.slice(0, m.index).split('\n').length;
    for (const px of m[2].matchAll(PX)) if (Number(px[1]) !== 0) hits.push(`${rel}:${line} ${m[1]}: ${m[2].trim()}`);
  }
  for (const m of text.matchAll(/@media[^{]*/g)) {
    for (const w of m[0].matchAll(/(?:min|max)-width:\s*([\d.]+px)/g)) {
      if (!BREAKPOINTS.has(w[1])) hits.push(`${rel}:${text.slice(0, m.index).split('\n').length} @media ${w[1]}`);
    }
  }
  if (hits.length) bad.push(`${rel}: ${hits.length} literal(s)\n    ${hits.slice(0, 8).join('\n    ')}`);
}
if (bad.length) { bad.forEach((b) => console.error('  ' + b)); process.exit(1); }
NODE
then
  echo "G7 FAIL: use a --fs-* / --sp-* token from client/src/ui/tokens.css (or 768px/340px in @media)."
  FAIL=1
else
  echo "G7 PASS"
fi
echo

echo "==> Gate G8: total client CSS lines must not grow"
# Ratchet: the lean rewrite takes CSS from 18.4k lines to a ~3.75k budget
# (lean-scope 06 §3). When a change cuts CSS, lower CSS_LINE_CEILING to the new
# total in the same commit so the cut cannot silently grow back.
CSS_LINE_CEILING=14359 # 2026-10-05: +44 channel favorites: hover/focus visibility and mobile touch target (owner request); 2026-10-05: +5 onboarding fonts move into DependenciesPrompt.css (a .tsx CSS import broke the node test runner); +150 onboarding Welcome → Setup → Team card (glow surface, step pills, rounded fields, folder autocomplete match; Product Development Lead, owner request) and +15 workspace-rail Connect mobile button; 2026-10-05: +83 "Let the AI Cook" hover hint: tiny bubbling pots each side of the label stream stars to the button edge (owner request); 2026-10-05: +90 palette picker "Let the AI Cook": submit on its own line, grows into a cooking-robot stage while generating (owner request; dead .strip-swatch-glow and .ai-dots removed); 2026-10-01: -2 Task page and Work restyle reuse Home cards; old Work disclosure styles removed; 2026-10-01: Home polish from Marketing Designer patch (compact requests, count pill, aurora tile, column); 2026-10-01: +14 Home alignment pass, +15 concurrent ChannelContent.css (another session, uncommitted at the time); 2026-10-01: +13 Home spacing/alignment pass (single column width, uniform thread cards); 2026-10-01: +9 Home typography (Inter Variable body, Plus Jakarta Sans display); 2026-10-01: -40 Home task cards drop the owner face and status pill (status is the bar colour; owner request), ratchet back down; 2026-10-01: +20 Home aurora animation, wider cards (owner request); Home card polish (designer notes: outlined status pill, full-bleed bar, emblem aura); 2026-10-01: +78 Home restyle (glow hero, raised composer, refined Task/request/thread cards; owner request); 2026-09-30: +416 workspace Home (ChannelLanding.css: hero, pinned-project cards + progress bar, thread cards, requests; owner request), rest is pre-existing dirty-tree overage (13362 before this change); 2026-09-29: +3 Threads cards get an "Open thread" link at the header's right edge (owner request; .threads-list reuses ui-stack, -2); +9 Reply settings "default" hint sits under its button (owner request; merged a duplicate .config-picker__custom rule); -12 redundant phone/channel CSS declarations and stale commentary removed in ce00bbd, restoring the 13285 ceiling; 2026-09-28: +6 DM message list pinned to pane width (e03928d, DM duplicate fix); +6 threads view merged from origin/main (ThreadsPane.css +38, dead mobile-ui rules -32); +38 mobile phone fixes: app-owned image viewer with close/back behavior, stable keyboard shell with FullscreenComposer owning visual-viewport sizing, and narrow fresh-context DM action layout; +229 ui-popover primitive (replaces three ad-hoc header popover surfaces), Buddy About card with memory previews, read-first Buddy memory page (index, rendered docs, dated timeline, history); +9 ui-scroll-quiet primitive (Sidebar + channel rail share one scroll-only rounded thumb; Firefox fallback) and space above the rail's Buddies header; +52 channel Search expands in place (panel, field, expand/reveal keyframes, reduced-motion); +5 Search trigger becomes a pill with an accent icon; +19 channel header centres the Search trigger (grid + trigger); 2026-09-27: +3 channel composer scrollbar-gutter (textarea/mirror wrap mismatch); +5 sidebar scroll-only scrollbar + section spacing (2ccbb09, sync merge); +2 restore a no-shrink rule for the Task filter class 578e160 orphaned (sync merge); +2 restore a no-shrink rule for the Task filter class 578e160 orphaned (sync merge); preserve source picker/worker features and closeout layout fixes; prior 12711.
CSS_LINES="$(find client/src -name '*.css' -print0 | xargs -0 cat | wc -l | tr -d ' ')"
if [ "$CSS_LINES" -gt "$CSS_LINE_CEILING" ]; then
  echo "G8 FAIL: client CSS is $CSS_LINES lines, ceiling $CSS_LINE_CEILING. Reuse a primitive (ui/primitives.css) or cut elsewhere."
  FAIL=1
else
  echo "G8 PASS ($CSS_LINES / $CSS_LINE_CEILING lines)"
fi
echo

echo "==> Gate G9: width @media queries only in shell CSS"
# O1 (lean-scope 06 §2.3): device layout belongs to the shells. A view that
# differs by device colocates a [data-device="mobile"] rule (ShellMobile sets
# the attribute on its root) or reads a data-layout / presentation variant the
# caller picks. A width query in a view sheet would also fire for a desktop
# window narrowed after load, which keeps the desktop tree (useDeviceKind is
# sticky), so it styled a layout the tree never renders. prefers-* and
# hover/pointer queries are not device layout and stay allowed everywhere.
SHELL_CSS='^client/src/(App\.css|components/Sidebar\.css|mobile/styles/[^/]+\.css)$'
WIDTH_MEDIA="$(
  find client/src -name '*.css' | grep -v -E "$SHELL_CSS" | xargs grep -n -E '^[[:space:]]*@media[^{]*width' || true
)"
if [ -n "$WIDTH_MEDIA" ]; then
  echo "$WIDTH_MEDIA" | sed 's/^/  /'
  echo "G9 FAIL: width @media outside shell CSS (App.css, components/Sidebar.css, mobile/styles/*)."
  echo "  Fix: [data-device=\"mobile\"] .your-class { ... } in the view's own sheet."
  FAIL=1
else
  echo "G9 PASS"
fi
echo

if [ "$FAIL" -ne 0 ]; then
  echo "check-client-invariants: FAILED — fix the gates above."
  exit 1
fi

echo "check-client-invariants: all 9 gates PASS"

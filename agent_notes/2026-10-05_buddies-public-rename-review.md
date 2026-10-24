# Buddies public rename review — 2026-10-05

Delivery PM reviewed commit `54f8c9a411d50408bc840abdfc16cead006dd4a4`, not the dirty shared tree. No source edits, staging, merging, pushing, backend start, live database access or publication performed.

## Verified

- `gh repo view nbardy/buddies`: repository exists; default branch main.
- Remote GitHub main resolves to 54f8c9a. Local HEAD was 0259383 (Setup dismissal persistence), already newer than remote during review.
- GitHub Pages source main:/docs; latest Pages build 1261018604 successfully built 54f8c9a. Deployment run 37269556793 succeeded.
- Commit changes README, docs/index.html, package.json bin alias, and an upstream comment. README and website have the same HTTPS recursive clone command and cd buddies. .gitmodules already uses HTTPS.
- Live https://nbardy.github.io/buddies/ rendered in Chrome. Bricolage font loaded, hero image loaded, video readyState 4 with duration 84.01 s. Desktop had no horizontal overflow.
- Old https://nbardy.github.io/unleashd/ returns HTTP 404; no Pages redirect observed.
- Pictures: output/screenshots/delivery-brand-review-20261005/{desktop,phone}.png.

## Gaps

- Public rename incomplete: committed client/index.html has Unleashd title/loading/failure messages; client/public/manifest.webmanifest name, short_name and description remain Unleashd. README prose still says Unleashd.
- Default bootstrap server/src/upstream/unleashd-home.ts sets WORKSPACE_NAME='unleashd', plus Unleashd role/soul/channel-purpose copy. Preserve stable keys/root-path reuse and owner-authored existing names; renaming must not duplicate the install workspace or hires.
- Alias `buddies` is declared in package.json but no fresh install/linked-command smoke was performed. Root npm package remains unleashd@1.1.0. Publishing workflow derives name from package.json; adding an alias does not rename the npm package.
- npm workflow 37269558549 failed before any steps (runner_name empty). Check-run annotation confirms the account is locked due to a billing issue. Owner must resolve GitHub billing, then Release Engineer can rerun; this is not a code/test failure or successful npm release.
- Live video is the older 84.01-second asset, not v10 (88.767s) or the subsequently requested v11 arrangement. Designer owns the final cut in thread post_01a10710-5294-750a-adc5-571437035dfc; owner requested v11 ordering after v10 review. Do not start competing renders.
- Live hero is the earlier wave_sim image in docs/screenshots/hero.png. No new screenshot asset was part of 54f8c9a. Designer's later final-home screenshot selection is reported in the launch thread; reconcile that selected asset before calling latest screenshot shipped.
- Website still includes Oompa Swarm Engine CTA. Branding still uses grid/rainbow headline; brand/BUDDIES_BRAND.md describes cream/violet/teal aurora/lockup. Font alone does not establish styling alignment. Confirm latest design decisions with Designer.
- At viewport 390×844: innerWidth/clientWidth 390, document/body scrollWidth 400. Full-page phone screenshot shows 10px horizontal excess. No ordinary body element extends beyond viewport; inspect decorative/pseudo-element styles when fixing.
- README's top harness claim needs qualification: its own table says OpenCode is read-only, not live spawn.
- Install command matches textually; fresh-clone/bootstrap/first usable Home behavior remains unverified. Bootstrap source DOES create #upstream for install workspace, so distinguish fresh arbitrary workspace channel behavior from install bootstrap; do not repeat 'fresh workspace has no channel' as a proven global fact.

## Coordination

Canonical verification follow-up: task_01a10aae-dd70-7318-a7b4-23e28b3a1904 (Delivery PM).
Reuse existing install task buddy_project_d5d94e0e-4990-4277-bafc-73a7c6bb2a6d, first-run task todo_4784a23d-715a-4959-8dba-17ba07b15f78, bootstrap task buddy_project_85f41c44-df38-45c6-9171-ffe7f6e3c2ba, and launch task buddy_project_0bcad28f-2855-4007-bf01-d4384e0376b4.
Release Engineer owns public site/release completion, Development/Product Lead owns first-run changes, Designer owns accepted screenshot/video. Shared dirty README and WorkspaceHome/UI files overlap prospective work; coordinate before editing. Preserve concurrent changes and validate final commits in isolation.

## Follow-up: 79b4ba4

- Inspected 79b4ba4ff48379f1bdafa34facd2935c6cfa0f69: committed Oompa CTA removal and additional phone CSS clamp/wrapping. Pages latest build says built at this commit.
- Earlier intervening commit 78baa89 renamed app title/boot copy and PWA manifest to Buddies. These were genuine gaps at the previously reviewed 54f8c9a; they are now fixed in source. Runtime/installed-PWA refresh is not tested here.
- Live Chrome and independent curl still served the Oompa CTA, including cache-busting ?review=79b4ba4. The served copy includes the newer OpenCode read-only qualification and fits phone width. Thus latest Pages build is successful but CTA removal is not yet observed live; likely propagation, not established cause.
- At 390×844, document/body scrollWidth both 390 (previously 400). Screenshot phone-latest.png visually reviewed: readable layout, no horizontal excess. Desktop also captured in desktop-latest.png. These are current live evidence, not a claim that every served byte equals 79b4ba4.
- Video remains 84.01 s. Current commit history also contains v12 mobile-friendly ordering work (9079273); final asset still belongs to Designer's existing launch workflow.
- Default workspace target is Buddies per existing owner-approved product rename; already routed to Product Lead through existing bootstrap/install tasks. Do not ask owner to repeat naming direction.

## Subsequent live confirmation

- Independent curl of live Pages now shows no Oompa CTA; OpenCode qualification remains present. Previous propagation uncertainty is resolved for this fetch.
- 78baa89 README Names section explicitly documents legacy npm name/alias and internal compatibility. Package naming is a documented compatibility choice, not a claim of a renamed npm release.
- Release Engineer reports clean-copy build/start and buddies alias smoke. Requested exact revision, commands, saved results and temp-state isolation for commit-level certification; not independently rerun.
- Requested Release Engineer proceed with brand alignment already authorized by original owner website request and 'do it all', coordinating current logo/assets with Designer. Styling need not wait for the final video export. Remaining in-app strings, workspace bootstrap and video release still open.

## Restyle checkpoint da224ee

- Inspected da224ee51fd05613a81d422602fd04f18fed91a7 (docs/index.html, favicon, OG image). Pages reports built at this SHA.
- Independently opened live page in Chrome; viewed full-page phone and desktop captures. 390px phone scrollWidth=390; 1440px desktop scrollWidth=1440. Font and hero image loaded. Night ground, cream type, violet/teal accents and Pair logo visibly deployed. Captures: output/screenshots/delivery-brand-review-20261005/{phone,desktop}-da224ee.png.
- Video duration remains 84.01s with old mid-video poster; wave_sim hero remains. No claim of final video/screenshot release.
- Install evidence on verification Task names clean clone 78baa89, temporary HOME/PNPM_HOME, build/start at ports 7591/7592, linked buddies invocation from /tmp and typecheck pass. Read agent_notes/2026-10-05_buddies-rename-completion.md and saved clean-clone-tests.log. Log confirms client suite 221/223 with two failures (channel-dm and channel-restored); pre-existing reproduction at 54f8c9a is Release Engineer's report, not independently rerun here. First agent reply unverified because temp state lacks credentials. Install/build/alias smoke accepted as attributed Release Engineer evidence, not a full first-run pass.
- Requested Designer review reconstructed Pair SVG/favicon versus current selected lockup; no competing render. Existing task comments confirm Development Lead engineering ownership of bootstrap rename/first usable Home; Product Lead retains canonical tasks.

## Owner correction: video first, f0c07be

Owner rejected the text-first layout. Inspected f0c07be780a17125ad826c18631d98cdd0cac409 and confirmed exact Pages build. Live Chrome on desktop 1440×900 and phone 390×844 puts video at y≈95 before headline/install. Muted autoplay observed with paused=false and advancing currentTime. No horizontal overflow. Phone video is ~191px tall (normal 16:9), so it leads rather than filling the whole screen. Old 84.01s cut still shows Unleashd branding; final video/poster remains open. Captures top-f0c07be-{desktop,phone}.png in the delivery screenshot folder. Preserve video-first order through final asset integration.

## Superseding owner correction: poster, no duplicate Vim copy

Owner asked to show the video's Vim frame on initial load instead of repeating its text. 5e4b58f650ad3acdb9e37ff6dad837a3da9731fc implements poster/no-autoplay/no-repeated-headline and logo sizing; Pages reports later f7d57b0 built. Independently viewed live Chrome at 1440×900 and 390×844: Vim setup card visibly shown in player, autoplay=false, paused=true, currentTime=0 across captures, no duplicate Vim headline outside player and no horizontal overflow. Captures poster-{desktop,phone}.png. This supersedes autoplay acceptance. Final video swap must preserve initial poster/no-autoplay behavior. Designer supplied v12 poster in 6ee62a8 (local); v12 end-card old repo URL remains an open final-cut issue.

## Capital Open Source shimmer, 6261e09

Owner selected option 2 purple shimmer for video too (post_01a10acd-adcb-7563-a7c0-a17d6242e883). Inspected 6261e095044cc35071e45e94cf50dbb01ef1823b, confirmed Pages built SHA, and independently viewed live Chrome 390×844 / 1440×900. Both scrollWidths equal viewport. Capital headline visible; computed shimmer and three twinkle animations active. Reduced-motion emulation true sets all four animation names to none. Shipped larger/brighter sparkles visually reviewed after Engineer's earlier captures. Old 84s cut/poster remains paused. Recorded chosen style on existing launch and rename Tasks; Designer owns final card/poster, Release Engineer integration. No new options/approval round. Screenshot shimmer-phone.png stored in delivery screenshot folder.

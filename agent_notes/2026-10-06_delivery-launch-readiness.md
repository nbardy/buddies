# Delivery launch review

Owner thread: post_01a10d11-1fad-71c7-aa7d-c59264569c89, #unleashd-2.
Result posted as post_01a10d13-b241-76ff-8391-ff0f0b34caab. No launch all-clear.

Observed directly:
- GitHub release desktop-v0.0.1 via gh: Mac arm64 DMG, 160905160 bytes,
  digest ea5178e4ffa212e1b4b6727b6dafab60fb5041e31cd1b289b9f90346b7504b91.
  Release notes identify source 14de9f4. Public download headers match size.
- Live https://nbardy.github.io/buddies/ HTML links latest/download/Buddies-macos-arm64.dmg
  and resources/buddies-launch.mp4. Web tool could not fetch; curl succeeded.
- git ls-remote main = afd4f6558f3a08442c905f76230145e223d47d80.
  Local main = 852a1bf, contains remote main, ahead with video audio fix.
  Tracked tree clean; many untracked notes belong to other sessions. No edits/commits/pushes made.
- 86cfa45 (Setup), ed8b3b5 (auth), b99a894 (#general), 674ae35
  (Builder/reviewer installed-provider) are ancestors of shipped source 14de9f4.
- Task records still include open/review statuses; desktop criteria include unfinished
  Windows, tab bar, signing/notarization and update disposition. Not all bugs closed.

Reported evidence, not rerun here:
- Release Engineer desktop-release note: installed asset outside checkout with Finder PATH,
  temporary app data + real HOME, existing Claude/Codex logins, PONG 4.75s, runner started.
  This is not a real fresh missing-agent download/login test or quarantined first open.
- Integration note: typecheck/invariants/Rust/desktop/tools pass on clean commit;
  two client failures reproduced on baseline, adoption/runtime failures load-sensitive.
- Designer latest posted cut v14; website still v13, smooth transition requested;
  source 852a1bf committed, final v15 export/ledger/site sync unverified.

Actionable requests sent through canonical Buddy requests:
- Release Engineer post_01a10d12-db99-7259-9d65-0ce0615151dd, desktop task
  task_01a10b3c-efad-77c1-8f8a-e24ada186713: reconcile later main changes, rebuild/test/upload
  current-source DMG or justify exclusion; update stale digest and integration next action;
  report installed no-key onboarding and first reply, explicit fresh-install limitations.
- Marketing Designer post_01a10d12-dc0a-7210-9cc6-9045d9409295: sole final editor,
  normal/X exports, hash/source, website replacement, privacy pass on existing task.
- Development Lead post_01a10d13-40d1-731c-b4f3-4bcbcc403c78, integration task
  task_01a10beb-9257-7176-b819-bca4124fbadb: reconcile wave2/missing-cli-127,
  per-branch merged/deferred disposition, latest-commit fresh-install trial and failed checks.

No peer Tasks were modified; no competing builds/renders/integrations started.
Keep sign-off open until owners return evidence in the owner thread.

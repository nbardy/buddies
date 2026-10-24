# Auth: no key prompt on the owner's devices + QR pairing (2026-10-05)

Owner request: #general thread post_01a10b84 ("Do we really need this? When on
same machine can we let it connect? ... does mobile need a password either?"),
then "sounds good ... QR for mobile ... tailscale url with ?key= appended".

Branch `feat/auth-local-trust-pairing`, commit `0164798`, worktree
`~/git/unleashd-wt-auth-local-trust` (cambium name `auth-local-trust`). Not merged, not pushed.

## Decision
Keep the key; nobody types it on their own devices.
- Key created on first run (0600, `wx` so backend + Vite agree).
- Gate classifies requests: local | tailnet | remote (`classifyRequest`, gate.ts).
  local = loopback peer + loopback Host + own Origin + no non-local XFF.
  tailnet = loopback peer + own Origin + `Tailscale-User-Login` == node owner.
- QR = `https://<host>/__auth/pair?code=<single-use 5-min code>`. Deviation from
  the owner's "?key=": a one-time code, so the key never sits in phone history,
  proxy logs or a screenshot of the QR. Same UX.

## Evidence
- Serve header behavior, tailscale 1.102.2: temporary `tailscale serve --https=8443`
  to a header echo for ~1 min, then `serve --https=8443 off` (config verified restored).
  Forged `Tailscale-User-Login: attacker@evil.com` arrived as the owner's login;
  forged `X-Forwarded-For: 127.0.0.1` arrived as `100.64.36.46`; `Origin` passed
  through untouched (so the Origin check is required).
- `server/test/auth.test.ts` + `mobile-access.test.ts`: 27/27 on the committed tree.
  Mutation check: removing the Origin check fails 2 tests; removing the peer check fails 1.
- `pnpm test:server`: 251 pass, 1 fail (swarm-read-model-routes timing test; passes
  alone 4/4; unrelated). `pnpm test:client`: 223 pass, 2 fail (channel-dm harness retry,
  Task filter) in files this change does not touch or import.
- `pnpm typecheck` clean; `tools/check-client-invariants.sh` 9/9 gates pass.
- Real-browser smoke (`2026-10-05_auth-local-trust/smoke.mjs`, worktree server on 7531,
  temp HOME/data, fake tailscale): fresh install created the key; local browser opened
  the app with no login; Setup showed the QR; a "remote" client (X-Forwarded-For
  100.101.102.103) saw the login page, then was signed in after `/__auth/pair?code=`.
  Screenshots in `2026-10-05_auth-local-trust/`.

## Not verified
- Vite dev path (`pnpm dev`) not run live: the owner's dev server holds 7489/7499.
  Typechecked only.
- A real phone scanning the QR through real Serve.

## Trade-offs to know
- Any local process (agent turns included) can call the API without the key. They
  could already read the key file as the same user.
- `pnpm dev` on a fresh install now listens on every interface (key-gated), because
  a key always exists. Previously a keyless install bound loopback only.

## Follow-up d62c69b (owner review)
Owner: QR not centered; don't show QR without Tailscale; tell them the phone needs
Tailscale first ("Tailscale is set up on my phone").
- Ready state now shows phone install links + "Tailscale is set up on my phone";
  that click mints the code. QR/caption/New code centered (measured offset 0px from
  the section center at 1280px).
- Non-ready states (logged out shown in 07-no-tailscale.png) show no QR and no confirm.
- Typecheck, biome, 9/9 client invariants pass. Screenshots 05/06/07 in the folder.

## Merged and pushed (owner: "yes merge and push")
- Local main and origin/main had diverged (7 unpushed local commits from other
  sessions; 2 README commits on origin). Integration branch `integrate/auth-main`:
  d62c69b + merge origin/main (ede3713) + fix ed8b3b5 + merge local main (4f61146,
  launch-video files only). Main fast-forwarded to 4f61146; pushed 6f192a6..4f61146.
  The push includes the 7 local-only commits that were already on local main.
- Fix ed8b3b5, found during merge verification: the auth test failed 1 in 6 with
  the owner phone getting 401. A failed `tailscale status` read mapped to
  `unknown`; now it throws and the watch keeps the last owner. 8/8 runs green.
- Checks on ed8b3b5 (clean tree): typecheck 0; invariants 9/9; test:server 251/254
  (dependencies first-boot and swarm timing fail under load, pass alone 3/3 and 4/4);
  test:client 223/225 (the same two channel tests as before, untouched files).
- `pnpm install --frozen-lockfile` run in the main checkout for qrcode.
- Live dev server (7489/7499) still answered 401 to local at push time: the backend
  reload is deferred while turns run. Not force-restarted.
- Worktree removal blocked by git ("working trees containing submodules cannot be
  moved or removed"); left for daily.sh reaping. Branches feat/auth-local-trust-pairing
  and integrate/auth-main are merged.

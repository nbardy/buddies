# Launch video v10: render provenance (2026-10-05)

Artifact: `product/releases/launch-2.0/edit/out/launch-v10_4af67b0.mp4`,
SHA256 `06cfb007f12ae6a2c4afa63776f85bb43a3b495a8f4ac5eb088c1d09b71c1c9d`, 48,012,849 bytes.

Source of everything below: the Marketing Designer session transcript
`~/.claude/projects/-Users-nicholasbardy-git-unleashd/19f9d0bb-f44d-4eff-b06c-3c7ece8e5865.jsonl`
(tool calls 05:07:16Z to 05:39:24Z). Times are WITA (UTC+8) unless marked Z.

## Not an isolated snapshot

Both passes ran in the live checkout (`product/releases/launch-2.0/edit`), not in a
`git archive` / worktree snapshot. The evidence that the source matched commits is below.
Next time, render from an isolated snapshot (as v9 did: `/tmp/launch-v9-39ae2db.*`), so the
commit is certain from the start.

## Commands (all through the render queue, `render.mjs`, guarded since 689f91b)

Picture, started 13:07:16, PID 47842, finished ~13:37:54 (30 min):

    cd product/releases/launch-2.0/edit
    node render.mjs render src/index.ts Assembly out/launch-v10.video.mp4 --crf=18 --muted --timeout=240000 --log=error > /tmp/v10-video.log 2>&1

Audio, first attempt, started 13:07:16 in the same shell (PID 47843 / remotion-cli 47844), and
KILLED at ~13:08:51 before writing any file (it predated the benefits fix). Same log path, so its
log was overwritten by the rerun.

Audio, the one used, started 13:10:16, exited 0 after 1521 s (13:35:36):

    node render.mjs render src/index.ts Assembly out/launch-v10.wav --codec=wav --timeout=240000 --log=error > /tmp/v10-wav.log 2>&1

Mux, 13:38:32:

    cd out
    ffmpeg -y -loglevel error -i launch-v10.video.mp4 -i launch-v10.wav -map 0:v -map 1:a -c:v copy \
      -af "volume=-3.7dB" -c:a aac -b:a 256k -ar 48000 -movflags +faststart launch-v10_4af67b0.mp4

Intermediates:
- `launch-v10.video.mp4` SHA256 `7234dad97505a13880f3206d87c24d8e9be64e7ca3a89dd8d5b381ecf3fe6537`
- `launch-v10.wav` SHA256 `4ae0e2356370f7bd58369fc5ed7519856ada1a25d7411c0ee46cfed7e646e430`

## Logs (copied from /tmp to `edit/out/v10-qa/`, gitignored, local only)

- `v10-video.log`, `v10-wav.log`: 652 B each. Both hold only Remotion's zod version-mismatch
  warning (`--log=error` suppresses progress). No errors.
- `chain-video-and-killed-wav.output`: `start 13:07:16 at f11bd45 dirty=5`, then exit 144 (the
  wrapper shell was killed with the stale audio pass; the picture process kept running).
- `wav-rerun.output`: `wav rc=0 in 1521 s at 4af67b0`.

The mux and the loudness/visual checks have no log file; their output is in the transcript.

## Picture source = 4d7f290 (and 4af67b0, for picture)

- At start, HEAD was `f11bd45` with 5 dirty files under `launch-2.0`: the uncommitted glitch
  removal (OverloadReveal, Overload, Assembly, Root, post-intro-entry), edited at 05:06:55Z.
- 05:07:22Z (6 s after start, nothing edited in between): `git add` of exactly those 5 files,
  commit `4d7f290`; `git status --porcelain -- product/releases/launch-2.0` then counted 0.
  So the tracked tree the picture pass bundled equals `4d7f290`.
- The only later source edit during the picture pass was `PostIntroBenefits.tsx` (05:09:22Z
  to 05:09:59Z, committed as `4af67b0`). `git diff 4d7f290 4af67b0` touches only that file and
  only the `BenefitsSound` cues (marimba `Audio` elements removed). The picture pass is `--muted`,
  so whether its bundle saw that edit or not, the picture is identical for both commits.
  Not proven: the exact moment Remotion finished bundling (the log level hid it).

## Audio source = 4af67b0

- Started 5 s after commit `4af67b0`, with 0 dirty files under `launch-2.0`.
- No commit has touched `launch-2.0` since `4af67b0`, and the only tracked file there modified
  after 13:07:16 is `PostIntroBenefits.tsx` (13:09:59, i.e. the 4af67b0 edit itself).

## Untracked (gitignored) inputs

The public dir is `../footage` (`remotion.config.ts`). Checked 2026-10-05 after the render:
46 gitignored files under `launch-2.0` (excluding `edit/out`, `edit/node_modules`); none has an
mtime after 13:07:16. This shows they were not changed since the render started, not what bytes
the commits would reference (footage is not in git).

## Loudness evidence (transcript, 05:38:17Z and 05:38:32Z)

- Pre-mux WAV: 88.767 s, integrated -10.3 LUFS, LRA 5.9 LU, sample peak -2.44 dBFS, 0 clipped
  samples. Per-section RMS/peak table in the transcript.
- Song alignment: cross-correlation 0.999 at -0.3 ms against `sound/launch.wav` at its cue.
- Final MP4 (after -3.7 dB): integrated -14.1 LUFS, LRA 5.8 LU, true peak -5.1 dBFS;
  video 88.766667 s, audio 88.767 s; 5326 frames.
- Not done: an end-to-end listen by a person.

## Visual evidence (`edit/out/v10-qa/`)

- `v10-sheet.png`: frames 450, 700, 960, 1200, 1600, 2050, 2700, 3280, 3500, 3730, 3900, 4010,
  4180, 4400, 4750, 5150 (one per section).
- `vim-strip.png`: frames 4520 to 4960, every 40.
- `fork-strip.png`: frames 4070 to 4280.
- Reviewed by eye for blank/broken frames only. Privacy and branding are open (16 workspace
  names on the emblem sheet, Buddy names in the swarm shot, old repo/app name).

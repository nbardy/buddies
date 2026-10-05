#!/usr/bin/env bash
# v15: v14's picture with the eased sound (owner, 2026-10-05: the drop → home step at 0:16-0:17 "cuts
# in like a hard shift"; launch.py now crossfades it over 2 bars). The picture is unchanged, so the
# v14 video stream is copied as is (no re-encode); only the sound is rendered. Then the X upload (the
# Vim card as the first 2 frames, x-cover.sh). Run from edit/.
set -euo pipefail
V14=../renders/v14-chain/launch-v14.mp4
node render.mjs render src/index.ts AssemblySound out/v15.wav --codec=wav --log=error
ffmpeg -y -loglevel error -i "$V14" -i out/v15.wav -map 0:v -map 1:a -c:v copy -af "volume=-3.7dB" \
  -c:a aac -b:a 256k -ar 48000 -movflags +faststart out/launch-v15.mp4
./x-cover.sh out/launch-v15.mp4 4455 out/launch-v15-x.mp4

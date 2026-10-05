#!/usr/bin/env bash
# v16 by stitching: AI color themes, 4 bars after the benefits ("Completely customizable") and before
# the Vim line (owner, 2026-10-06). Only that section and the sound are rendered; the picture before
# and after it is cut, frame-exact, from v14 (= v15's picture; v15 only changed the sound). The song
# (../sound/launch.py) gained 4 FULL bars there and is bit-identical to v15's before them.
# bar(b) = 916 + round((b - 1) * 112.5). Run from edit/; the clip comes from ./trim-palette-4bar.sh.
#
#   v16 section            v16 frames   v14 frames (reused)
#   open … benefits        0-4290       0-4290
#   palette (new)          4291-4740    rendered
#   vim+end                4741-5550    4291-5100
set -euo pipefail
V14=../renders/v14-chain/launch-v14.mp4
node render.mjs render src/index.ts AssemblyPicture out/v16-palette.video.mp4 --frames=4291-4740 --crf=16 --timeout=240000 --log=error
node render.mjs render src/index.ts AssemblySound out/v16.wav --codec=wav --log=error

cut() { echo "[0:v]trim=start_frame=$1:end_frame=$2,setpts=PTS-STARTPTS[$3]"; }
ffmpeg -y -loglevel error -i "$V14" -i out/v16-palette.video.mp4 -i out/v16.wav \
  -filter_complex "$(cut 0 4291 head);$(cut 4291 5101 tail);[head][1:v][tail]concat=n=3:v=1:a=0[v];[2:a]volume=-3.7dB[a]" \
  -map '[v]' -map '[a]' -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -r 60 -c:a aac -b:a 256k -ar 48000 -movflags +faststart \
  out/launch-v16.mp4
ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 out/launch-v16.mp4
# The X upload: the settled Vim card (v14 4455 + the 450 inserted frames) as its first 2 frames.
./x-cover.sh out/launch-v16.mp4 4905 out/launch-v16-x.mp4

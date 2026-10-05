#!/usr/bin/env bash
# v12 by stitching: "Mobile Friendly!" moves to the first scene after the swarm and grows to 2 bars
# (owner, 2026-10-05). Only that scene and the sound are rendered; everything else is cut,
# frame-exact, from v11 (out/launch-v11.mp4, 82af5d4). bar(b) = 916 + round((b - 1) * 112.5).
# Run from edit/.
#
#   v12 section          v12 frames   v11 frames (reused)
#   open+home+swarm      0-1928       0-1928
#   mobile (new)         1929-2153    rendered
#   ask                  2154-2603    1929-2378
#   show their work      2604-3503    2379-3278
#   harness+picker       3504-3953    3279-3728
#   subscriptions        3954-4065    3841-3952 (its first 112 of v11's 113 frames)
#   fork+run             4066-4515    3954-4403
#   benefits             4516-4965    4404-4853
#   vim+end              4966-5775    4854-5663
set -euo pipefail
node render.mjs render src/index.ts AssemblyPicture out/v12-mobile.video.mp4 --frames=1929-2153 --crf=16 --timeout=240000 --log=error
node render.mjs render src/index.ts AssemblySound out/v12.wav --codec=wav --log=error

V11=out/launch-v11.mp4
cut() { echo "[1:v]trim=start_frame=$1:end_frame=$2,setpts=PTS-STARTPTS[$3]"; }
ffmpeg -y -loglevel error -i out/v12-mobile.video.mp4 -i "$V11" -i out/v12.wav \
  -filter_complex "$(cut 0 1929 open);$(cut 1929 2379 ask);$(cut 2379 3279 show);$(cut 3279 3729 hp);$(cut 3841 3953 subs);$(cut 3954 4404 fr);$(cut 4404 4854 ben);$(cut 4854 5664 ve);[open][0:v][ask][show][hp][subs][fr][ben][ve]concat=n=9:v=1:a=0[v];[2:a]volume=-3.7dB[a]" \
  -map '[v]' -map '[a]' -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -r 60 -c:a aac -b:a 256k -ar 48000 -movflags +faststart \
  out/launch-v12.mp4
ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 out/launch-v12.mp4

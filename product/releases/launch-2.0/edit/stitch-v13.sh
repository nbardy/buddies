#!/usr/bin/env bash
# v13 by stitching: "Open Source" shimmers on the Vim card (owner pick, 2026-10-05) and the end card
# says github.com/nbardy/buddies (repo renamed). Only vim+end is rendered; everything before it is
# cut, frame-exact, from v12 (out/launch-v12.mp4, 9079273). The sound is unchanged: v12's wav.
# Run from edit/.
#
#   v13 section          v13 frames   v12 frames (reused)
#   open … benefits      0-4965       0-4965
#   vim+end (new)        4966-5775    rendered
set -euo pipefail
node render.mjs render src/index.ts AssemblyPicture out/v13-vimend.video.mp4 --frames=4966-5775 --crf=16 --timeout=240000 --log=error

V12=out/launch-v12.mp4
ffmpeg -y -loglevel error -i "$V12" -i out/v13-vimend.video.mp4 -i out/v12.wav \
  -filter_complex "[0:v]trim=start_frame=0:end_frame=4966,setpts=PTS-STARTPTS[head];[head][1:v]concat=n=2:v=1:a=0[v];[2:a]volume=-3.7dB[a]" \
  -map '[v]' -map '[a]' -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -r 60 -c:a aac -b:a 256k -ar 48000 -movflags +faststart \
  out/launch-v13.mp4
ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 out/launch-v13.mp4

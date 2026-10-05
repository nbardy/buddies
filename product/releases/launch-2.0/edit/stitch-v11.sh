#!/usr/bin/env bash
# v11 by stitching (owner, 2026-10-05: "can we cache partial scenes and stitch?"). Only the sections
# that changed are rendered; every other section is cut, frame-exact, from the v10 picture
# (out/launch-v10.video.mp4, rendered from 4d7f290), which already has the captions burnt in. The
# sound is its own composition (no footage), muxed last. Frame ranges are Assembly's bar grid:
# bar(b) = 916 + round((b - 1) * 112.5); the end card is 360 frames. Run from edit/.
#
#   new picture        frames      v10 picture (reused)     v10 frames
#   overload+home+swarm 0-1928
#   ask                 1929-2378  ask                      1816-2265
#   show their work     2379-3278  show their work          2266-3165
#   harness+picker      3279-3728  harness+picker           3166-3615
#   features+subs       3729-3953  (1-bar sections shift by a frame when they move: re-rendered)
#   fork+run            3954-4403  fork+run                 4066-4515
#   benefits            4404-4853
#   vim+end             4854-5663  vim+end                  4516-5325
set -euo pipefail
R="node render.mjs render src/index.ts AssemblyPicture"
$R out/v11-a.video.mp4 --frames=0-1928 --crf=16 --timeout=240000 --log=error &
$R out/v11-b.video.mp4 --frames=3729-3953 --crf=16 --timeout=240000 --log=error &
wait
$R out/v11-c.video.mp4 --frames=4404-4853 --crf=16 --timeout=240000 --log=error
node render.mjs render src/index.ts AssemblySound out/v11.wav --codec=wav --log=error

V10=out/launch-v10.video.mp4
cut() { echo "[1:v]trim=start_frame=$1:end_frame=$2,setpts=PTS-STARTPTS[$3]"; }
ffmpeg -y -loglevel error -i out/v11-a.video.mp4 -i "$V10" -i out/v11-b.video.mp4 -i out/v11-c.video.mp4 -i out/v11.wav \
  -filter_complex "$(cut 1816 2266 ask);$(cut 2266 3166 show);$(cut 3166 3616 hp);$(cut 4066 4516 fr);$(cut 4516 5326 ve);[0:v][ask][show][hp][2:v][fr][3:v][ve]concat=n=8:v=1:a=0[v];[4:a]volume=-3.7dB[a]" \
  -map '[v]' -map '[a]' -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -r 60 -c:a aac -b:a 256k -ar 48000 -movflags +faststart \
  out/launch-v11.mp4
ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 out/launch-v11.mp4

#!/usr/bin/env bash
# The X/Twitter upload: the cut with the settled Vim "Open Source" card as its first 2 frames (1/30 s),
# so the preview shown before play is that card, not the dark opening (owner, 2026-10-05). X previews
# an uploaded video by its first frame; the sound is delayed by the same 2 frames, so sync is kept.
#   ./x-cover.sh out/launch-v14.mp4 4455 out/launch-v14-x.mp4
# The frame is the cut's settled Vim card: v14 4455 (= v13 5130, the site poster). Run from edit/.
set -euo pipefail
IN=$1; FRAME=$2; OUT=$3
ffmpeg -v error -y -i "$IN" -vf "select=eq(n\,$FRAME)" -frames:v 1 out/x-cover.png
ffmpeg -v error -y -loop 1 -framerate 60 -t 0.0333333 -i out/x-cover.png -i "$IN" \
  -filter_complex "[0:v]format=yuv420p,setsar=1,fps=60,trim=end_frame=2,setpts=PTS-STARTPTS[c];[1:v]setsar=1[m];[c][m]concat=n=2:v=1:a=0[v];[1:a]adelay=33.333|33.333[a]" \
  -map '[v]' -map '[a]' -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -r 60 -c:a aac -b:a 256k -ar 48000 -movflags +faststart \
  "$OUT"
ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0 "$OUT"

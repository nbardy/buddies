#!/usr/bin/env bash
# AI Color Palettes for the launch video (owner, 2026-10-06: "just need to cook"): the owner's 29.7 s
# take cut to exactly 4 bars of the song (450 frames, 7.5 s) so it sits on the bar grid after the
# benefits. Faster than the 12.4 s review trim (trim-palette.sh): the hero beats ("Let the AI Cook",
# the chef, Matrix Rain landing) stay near 1x; navigation and typing fly.
#
#   seg  source range (s)  speed  out (s)  shows
#   1    1.15 –  4.90      3x     1.25     gear → Color Palette → AI Generate
#   2    4.90 – 12.30      6x     1.23     the prompt typed
#   3   12.30 – 15.00      1x     2.70     "Let the AI Cook" pressed, the chef appears
#   4   19.95 – 22.60      1.4x   1.89     (4.8 s wait cut) Matrix Rain lands, Save
#   5   22.60 – 23.50      2x     0.45     the app goes green on Threads (ends before the thread list
#                                          scrolls on to a message with "fuck" in it, ~25 s)
#
# The prompt's "shit" (source x 1212–1278, y 384–424) is blurred in segs 2–3, the only ones where the
# prompt is on screen. Output is the 1458×960 card the Palette scene places (scale 0.53), so Remotion
# never decodes the 2750×1812 source. Source is never modified. Run from edit/.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=footage/2026-10-05_color-palette_raw.mov
OUT=clips/10_ai-color-palettes-4bar.mp4

seg() { # index start end speed
  echo "[s$1]trim=start=$2:end=$3,setpts=(PTS-STARTPTS)/$4,fps=60[r$1];"
}
blur() { # index: blur the word in seg's frames
  echo "[r$1]split[a$1][b$1];[b$1]crop=66:40:1212:384,boxblur=9:2[w$1];[a$1][w$1]overlay=1212:384[v$1];"
}

ffmpeg -v error -y -i "$SRC" -filter_complex "\
[0:v]split=5[s1][s2][s3][s4][s5];\
$(seg 1 1.15 4.90 3)$(seg 2 4.90 12.30 6)$(seg 3 12.30 15.00 1)$(seg 4 19.95 22.60 1.4)$(seg 5 22.60 23.50 2)\
$(blur 2)$(blur 3)\
[r1][v2][v3][r4][r5]concat=n=5:v=1:a=0,scale=1458:960:flags=lanczos,trim=end_frame=450[out]" \
  -map "[out]" -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$OUT"
ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets,width,height -of csv=p=0 "$OUT"

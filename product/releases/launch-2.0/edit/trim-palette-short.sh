#!/usr/bin/env bash
# AI color themes short (owner, 2026-10-06: its own quick product video, "a little longer going" than
# the launch cut's 4 bars): the owner's 29.7 s take at exactly 8 bars (900 frames, 15 s), kept at full
# 2750×1812 so edit/src/PaletteShort.tsx can zoom in on the prompt without going soft.
#
#   seg  source range (s)  speed  out (s)      shows
#   1    1.15 –  4.90      1.25x   0.0 –  3.0  gear → Color Palette → AI Generate
#   2    4.90 –  8.80      2x      3.0 –  4.95 the prompt typed up to "Let's make this" (the camera is on it)
#   2b   8.80 – 12.30      2x      4.95 – 6.7  the rest of the prompt
#   3   12.30 – 15.00      1x      6.7 –  9.4  "Let the AI Cook" pressed (6.8), the chef appears (8.0)
#   4   15.00 – 19.80      3x      9.4 – 11.0  the chef cooks (the wait, sped up)
#   5   19.80 – 20.60      1x     11.0 – 11.8  the chef finishes; Matrix Rain lands (source 20.55)
#   6   20.60 – 22.60      1x     11.8 – 13.8  the palette, Save
#   7   22.60 – 23.80      1x     13.8 – 15.0  the app in green on Threads (ends before the thread list
#                                              scrolls on to a message with "fuck" in it, ~25 s)
#
# The prompt's "shit" (source x 1212–1278, y 384–424) is blurred in segs 2b–5, every frame where the
# word is on screen (typing reaches it at source ~9.0) (it leaves at source 20.55, when the palette replaces it). Source is never modified. Run from edit/.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=footage/2026-10-05_color-palette_raw.mov
OUT=clips/11_ai-color-themes-short.mp4

seg() { # index start end speed
  echo "[s$1]trim=start=$2:end=$3,setpts=(PTS-STARTPTS)/$4,fps=60[r$1];"
}
blur() { # index: blur the word in seg's frames
  echo "[r$1]split[a$1][b$1];[b$1]crop=66:40:1212:384,boxblur=9:2[w$1];[a$1][w$1]overlay=1212:384[v$1];"
}

ffmpeg -v error -y -i "$SRC" -filter_complex "\
[0:v]split=8[s1][s2][s9][s3][s4][s5][s6][s7];\
$(seg 1 1.15 4.90 1.25)$(seg 2 4.90 8.80 2)$(seg 9 8.80 12.30 2)$(seg 3 12.30 15.00 1)$(seg 4 15.00 19.80 3)$(seg 5 19.80 20.60 1)$(seg 6 20.60 22.60 1)$(seg 7 22.60 23.80 1)\
$(blur 9)$(blur 3)$(blur 4)$(blur 5)\
[r1][r2][v9][v3][v4][v5][r6][r7]concat=n=8:v=1:a=0,trim=end_frame=900[out]" \
  -map "[out]" -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$OUT"
ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets,width,height -of csv=p=0 "$OUT"

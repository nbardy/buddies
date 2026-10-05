#!/usr/bin/env bash
# AI Color Palettes review cut: the owner's 29.7 s take (2026-10-05 4.28.50 PM, #unleashd final-video
# thread) trimmed to ~12 s. Padding, the typing and the ~4 s "Cooking your palette…" wait are cut;
# the action and the Matrix Rain result stay at 1x so they read.
#
#   seg  source range (s)  speed  shows
#   1    1.15 –  4.90      1.5x   gear → menu → Color Palette → dialog → "AI Generate"
#   2    4.90 – 12.30      3x     prompt box, typing "Let's make this … go matrix style" (typing ends ~12.2)
#   3   12.30 – 15.00      1x     "Let the AI Cook" pressed ~12.4, sparkles, chef robot appears ~13.6
#   4   19.80 – 22.60      1x     (wait cut) result lands at ~20.3, hover, Save at ~22.3, dialog closes
#   5   22.60 – 26.40      2x     the whole app in green: Threads, then #bugfixes, #case-studies, #channels-feature
#
# Source is never modified. Usage: ./trim-palette.sh  (from edit/)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=footage/2026-10-05_color-palette_raw.mov
OUT=clips/10_ai-color-palettes.mp4

seg() { # index start end speed
  echo "[0:v]trim=start=$2:end=$3,setpts=(PTS-STARTPTS)/$4,fps=60[v$1];"
}

ffmpeg -v error -y -i "$SRC" -filter_complex "\
$(seg 1 1.15 4.90 1.5)\
$(seg 2 4.90 12.30 3)\
$(seg 3 12.30 15.00 1)\
$(seg 4 19.80 22.60 1)\
$(seg 5 22.60 26.40 2)\
[v1][v2][v3][v4][v5]concat=n=5:v=1:a=0[out]" \
  -map "[out]" -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$OUT"
ffmpeg -v error -y -ss 9.0 -i "$OUT" -frames:v 1 -q:v 3 "${OUT%.mp4}.jpg"
ffprobe -v error -show_entries format=duration:stream=nb_frames,width,height -of compact "$OUT"

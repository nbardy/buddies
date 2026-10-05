"""The AI color themes short: the launch song's jingle, intro and ending around one feature.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/palette_short.py

Owner, 2026-10-06: the palette scene was "too much" in the launch video, so it gets its own quick
product video with "the buddies intro and outro with the little jingle": the robots' boops ("doop doop
doop") and the logo drop from launch.py, the feature on the groove, then the end card's ringing chord.
Same instruments, seeds and grid as launch.py (128 bpm in D, bar = 1.875 s); cue time 0 is the first
robot's pop (BuddiesIntro.POP_AT in the picture, edit/src/PaletteShort.tsx).

  bar  1        ROBOTS  five boops = the melody's first notes       (the robots pop in)
  bar  2        BUILD   snare roll, riser, a beat of silence         (they gather)
  bar  3        DROP    full band + the hook                         (the logo locks)
  bar  4        FULL    + scene accent                               ("AI color themes.")
  bars 5-12     FULL    + scene accent on 5                          (the recording)
  bar  13       END     one ringing D chord, the hook on a pluck     (the end card), 6 s, faded

Writes palette-short.wav: stereo 48 kHz 16-bit, peak -3 dBFS.
"""

from launch import DROP_SONG, RING, end_bar, scene_accent
from edm import at, write
from reveal import DROP, Mix, build_bar, master, robots_bar

FULL = range(4, 13)
SCENES = (4, 5)
END = 13
FADE = 4.0


def song():
    f = DROP_SONG
    mix = Mix(at(END) + RING, FADE)
    robots_bar(mix)
    build_bar(mix)
    f.drop(mix, DROP)
    for bar in FULL:
        f.full(mix, bar)
    for bar in SCENES:
        scene_accent(mix, bar)
    end_bar(mix, END)
    return master(mix, f.pump)


if __name__ == "__main__":
    write("palette-short", song())

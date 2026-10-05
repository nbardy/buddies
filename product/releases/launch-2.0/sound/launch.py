"""The launch song: reveal.py's Drop flavour, run under the whole video.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/launch.py

Owner, 2026-10-05: of the three reveal songs, the EDM "Drop" is the one: "great", with "the staggered
fun non-monotone beat that comes in when the buddies launch" (the hook: the robots' boop line an
octave up, on the 8ths 0, 2, 3, 4, 6). It replaces the edm.py build version of this file. The robots
pop on the "AI Overload" screen during bar 1; the logo locks on the drop (bar 3). Cue bar b is
Assembly bar b - 2 (Assembly's bar 1 is the lock):

  bar  1        ROBOTS  five boops = the melody's first notes       (on the AI Overload screen)
  bar  2        BUILD   snare roll, riser, a beat of silence         (the robots gather)
  bar  3        DROP    full band + the hook                         (the logo)
  bars 4-6      HOME    lighter: filtered chords, soft kick          (home)
  bars 7-34     FULL    the groove; on each scene's downbeat a crash and the hook again
  bars 35-38    CODA    the home texture again, quiet                (the Vim line)
  bar  39       END     one ringing D chord, the hook on a pluck     (the end card), 6 s, faded

Writes launch.wav: stereo 48 kHz 16-bit, peak -3 dBFS.
"""

import numpy as np

from edm import at, bass_note, chord, crash, hz, pluck, t_axis, write
from reveal import (
    BUILD,
    DROP,
    FLAVOURS,
    VOICING,
    Mix,
    build_bar,
    hook,
    lead,
    master,
    robots_bar,
)

DROP_SONG = next(f for f in FLAVOURS if f.name == "drop")
HOME = range(4, 7)
FULL = range(7, 35)
SCENES = (7, 11, 15, 23, 27, 31)  # benefits, ask, show their work, harness, swarms, fork
CODA = range(35, 39)
END = 39
RING = 6.0
FADE = 4.0


def scene_accent(mix: Mix, bar: int) -> None:
    mix.add("drums", crash(mix.rng("crash")), at(bar), 0.22, 0.3)
    hook(mix, bar, lambda n: lead(n, 0.45, mix.rng("lead")), 0.32)


def end_bar(mix: Mix, bar: int) -> None:
    t = t_axis(RING)
    voicing = VOICING["D"][0]
    ring = chord(voicing, mix.rng("chords"), 0.4, RING, np.minimum(1, t / 0.01) * np.exp(-t / 1.6))
    mix.add("music", ring / len(voicing), at(bar), 0.8, 0.5)
    mix.add("bass", bass_note(hz("D2"), RING, np.minimum(1, t / 0.004) * np.exp(-t / 1.2)), at(bar), 0.4)
    mix.add("drums", crash(mix.rng("crash")), at(bar), 0.2, 0.3)
    hook(mix, bar, lambda n: pluck(hz(n), 0.8), 0.45)


def render() -> np.ndarray:
    f = DROP_SONG
    mix = Mix(at(END) + RING, FADE)
    robots_bar(mix)
    build_bar(mix)
    f.drop(mix, DROP)
    for bar in HOME:
        f.home(mix, bar)
    for bar in FULL:
        f.full(mix, bar)
    for bar in SCENES:
        scene_accent(mix, bar)
    for bar in CODA:
        f.home(mix, bar)
    end_bar(mix, END)
    return master(mix, f.pump)


assert BUILD == 2 and DROP == 3, "the picture locks the logo on bar 3"

if __name__ == "__main__":
    write("launch", render())

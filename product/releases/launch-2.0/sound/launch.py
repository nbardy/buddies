"""The launch song: reveal.py's Drop flavour, run under the whole video.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/launch.py

Owner, 2026-10-05: of the three reveal songs, the EDM "Drop" is the one: "great", with "the staggered
fun non-monotone beat that comes in when the buddies launch" (the hook: the robots' boop line an
octave up, on the 8ths 0, 2, 3, 4, 6). It replaces the edm.py build version of this file. The robots
pop on the "AI Overload" screen during bar 1; the logo locks on the drop (bar 3). Cue bar b is
Assembly bar b - 2 (Assembly's bar 1 is the lock). Order of 2026-10-05: the logo holds two bars,
the swarm comes right after the home, then "Mobile Friendly!", and the benefits move to just before
the Vim line; "They show their work" is 2 bars (the emblem shots were cut):

  bar  1        ROBOTS  five boops = the melody's first notes       (on the AI Overload screen)
  bar  2        BUILD   snare roll, riser, a beat of silence         (the robots gather)
  bar  3        DROP    full band + the hook                         (the logo)
  bars 4-7      HOME    lighter: filtered chords, soft kick          ("buddies" holds, then the home);
                        bars 4-5 crossfade from the full band into it, so the drop eases down
  bars 8-36     FULL    the groove; on each scene's downbeat a crash and the hook again
                        (bars 33-36: AI color themes, added 2026-10-06)
  bars 37-40    CODA    the home texture again, quiet                (the Vim line)
  bar  41       END     one ringing D chord, the hook on a pluck     (the end card), 6 s, faded

Writes launch.wav: stereo 48 kHz 16-bit, peak -3 dBFS.
"""

import numpy as np

from edm import SR, at, bass_note, chord, crash, hz, pluck, t_axis, write
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
HOME = range(4, 8)
FULL = range(8, 37)
SCENES = (8, 12, 14, 18, 20, 25, 29, 33)  # swarms, mobile, ask, show their work, harness, fork, benefits, palette
CODA = range(37, 41)
END = 41
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


def render(soft_from: int) -> np.ndarray:
    """The song with the home section starting at bar `soft_from` (bars before it play full)."""
    f = DROP_SONG
    mix = Mix(at(END) + RING, FADE)
    robots_bar(mix)
    build_bar(mix)
    f.drop(mix, DROP)
    for bar in range(HOME.start, soft_from):
        f.full(mix, bar)
    for bar in range(soft_from, HOME.stop):
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

# Owner, 2026-10-05: the step down from the drop into the home "cuts in like a hard shift" at 0:16-0:17
# (the bar line after the drop). The softer level is right for the visual scenes; the switch is not.
# So bars 4-5 crossfade from a render where they still play full into the one where they are already
# home. The renders are identical before bar 4 (same seeds, same order); master() normalises each, so
# `full` is first matched to `soft` on the bars before the fade. The two share correlated parts (kick,
# chords), so equal-power gains overshot (+1 dB at the start, a 2.4 dB step at the end): the fade is a
# linear crossfade, then a gain curve steers its beat-smoothed level onto a straight line in dB from
# the full level to the soft one. The correction is tapered to 0 at both ends of the fade.
EASE_BARS = 2


def level_db(x: np.ndarray, hop: int, window: int) -> np.ndarray:
    """RMS level in dB every `hop` samples, averaged over `window` samples."""
    power = np.convolve((x**2).mean(axis=0), np.ones(window) / window, mode="same")[::hop]
    return 10 * np.log10(power + 1e-12)


def eased_song() -> np.ndarray:
    full, soft = render(soft_from=HOME.start + EASE_BARS), render(soft_from=HOME.start)
    a, b = round(at(1) * SR), round(at(HOME.start) * SR)
    full *= np.sum(full[:, a:b] * soft[:, a:b]) / np.sum(full[:, a:b] ** 2)
    t0, t1 = round(at(HOME.start) * SR), round(at(HOME.start + EASE_BARS) * SR)
    u = np.clip((np.arange(soft.shape[1]) - t0) / (t1 - t0), 0, 1)
    out = full * (1 - u) + soft * u

    hop, beat = 240, round(SR * 60 / 128)
    lo, hi = t0 - beat, t1 + beat  # measure a beat past each end so the smoothing window is full
    start = level_db(full[:, t0 - beat : t0 + beat], hop, beat).mean()
    end = level_db(soft[:, t1 - beat : t1 + beat], hop, beat).mean()
    have = level_db(out[:, lo:hi], hop, beat)
    grid = lo + np.arange(have.size) * hop
    v = np.clip((grid - t0) / (t1 - t0), 0, 1)
    fix_db = np.clip(start + (end - start) * v - have, -6, 6) * np.sin(np.pi * v)
    gain = 10 ** (np.interp(np.arange(lo, hi), grid, fix_db) / 20)
    out[:, lo:hi] *= gain
    ceiling = 10 ** (-1 / 20)
    return out * min(1.0, ceiling / np.abs(out).max())


if __name__ == "__main__":
    write("launch", eased_song())

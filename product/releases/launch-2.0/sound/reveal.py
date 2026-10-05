"""The Buddies reveal: the song that starts with the robots and drops on the logo. Synthesized here.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/reveal.py

Owner, 2026-10-04: every one-shot "BOOM" on the logo read as kitsch. The plan (INTRO_SOUND_PLAN.md):
the logo is where the song starts. The robots' boops are the first notes of its melody, on the
song's grid; "Replying…" rolling up is a one-bar build; the lock is the drop, the first downbeat of
the full band, and the song keeps going under the home statement and the benefits.

128 bpm in D (edm.py's grid; bar = 1.875 s). Cue time 0 is the first robot's pop: the edit starts
the file at Overload's title + BuddiesIntro.POP_AT.

  bar  1   0.000  ROBOTS    G   five boops on the melody's 8ths (0, 2, 3, 4, 6), a soft pad, muffled kick
  bar  2   1.875  BUILD     A   kick in quarters, snare roll 8ths -> 32nds, riser, filter opening;
                                the last 8th is silent but for a reversed crash breathing in
  bar  3   3.750  DROP      D   the logo locks: the full band and the hook (the boops' line, an octave up)
  bars 4-6 5.625  HOME          lighter: no claps or snare, filtered chords (the 2 Oct "tasteful" home)
  bars 7-12 11.25 FULL          the benefits and the first demo
  then a 1 s fade (drafts stop at the first demo; the chosen flavour gets the full length)

Three flavours share that structure; each is one handler set (FLAVOURS):
  drop      EDM: four-on-the-floor, pumped supersaw chords, off-beat bass, clap, a vocal chop on the drop
  halftime  cinematic: kick on 1, a big snare on 3 in a long room, wide pads, deep sub, a pluck hook
  marimba   bright and friendly: felt kick on the beat, rim, shaker, the marimba motif, plucked bass
Writes reveal-<flavour>.wav: stereo 48 kHz 16-bit, peak -3 dBFS (the Overload boom also peaks near -3).
"""

from dataclasses import dataclass
from typing import Callable

import numpy as np

from calm import UP_DOWN, felt_kick, marimba, motif_tones, pad, plucked_bass, rim, shaker, sub
from edm import (
    BAR,
    BEAT,
    SR,
    at,
    bass_note,
    chop,
    chord,
    clap,
    crash,
    fft_filter,
    gate,
    hat,
    hp,
    hz,
    impact,
    kick,
    limiter_gain,
    lp,
    panned,
    place,
    pluck,
    pump,
    reverb,
    riser,
    rng_for,
    snare,
    soft_clip,
    supersaw,
    t_axis,
    tv_filter,
    write,
)

ROBOTS, BUILD, DROP = 1, 2, 3
HOME = (4, 5, 6)
FULL = tuple(range(7, 13))
LAST = 12
FADE = 1.0
LENGTH = at(LAST + 1) + FADE
PEAK = 10 ** (-3 / 20)
GAP = at(BUILD, 3.5)  # the build's last 8th: silence before the drop

# I-V-vi-IV from the drop; IV under the robots and V under the build lead into it.
VOICING = {
    "G": (["G3", "B3", "D4", "G4", "B4"], "G1"),
    "A": (["E3", "A3", "C#4", "E4", "A4"], "A1"),
    "D": (["F#3", "A3", "D4", "F#4", "A4"], "D2"),
    "Bm": (["F#3", "B3", "D4", "F#4", "B4"], "B1"),
}
CYCLE = ["D", "A", "Bm", "G"]


def harmony(bar: int) -> tuple[list[str], str]:
    name = {ROBOTS: "G", BUILD: "A"}.get(bar, CYCLE[(bar - DROP) % 4])
    return VOICING[name]


# The melody: the robots' rhythm (BuddiesIntro CAST[5].pops, in 8ths) and the boops' notes, climbing
# D major pentatonic. The hook on the drop is the same line an octave up.
MELODY = [(0, "D4"), (2, "F#4"), (3, "A4"), (4, "B4"), (6, "D5")]


def up(note: str) -> str:
    return note[:-1] + str(int(note[-1]) + 1)


# ---- The mix: dry buses plus two reverb sends; "music" can be pumped by the kick.


class Mix:
    def __init__(self, length: float, fade: float):
        self.length, self.fade = length, fade
        self.n = round(length * SR)
        self.time = np.arange(self.n) / SR
        self.bus = {k: np.zeros((2, self.n)) for k in ("drums", "room", "music", "hall", "bass", "swell")}
        self.kicks: list[float] = []
        self.seeds: dict[str, np.random.Generator] = {}

    def rng(self, element: str) -> np.random.Generator:
        return self.seeds.setdefault(element, rng_for(f"reveal-{element}"))

    def add(self, bus: str, x: np.ndarray, t0: float, gain: float, send: float = 0.0) -> None:
        stereo = x if x.ndim == 2 else panned(x, 0)
        place(self.bus[bus], stereo, t0, gain)
        if send:
            place(self.bus[{"drums": "room", "music": "hall", "bass": "hall"}[bus]], stereo, t0, gain * send)

    def kick(self, x: np.ndarray, t0: float, gain: float) -> None:
        self.add("drums", x, t0, gain, 0.12)
        self.kicks.append(t0)


def master(mix: Mix, pump_depth: float) -> np.ndarray:
    b = mix.bus
    music = (b["music"] + reverb(b["hall"], 2.8, "reveal-hall", 0.03) * 0.45) * pump(mix.n, pump_depth, mix.kicks)
    out = b["drums"] + reverb(b["room"], 1.9, "reveal-room", 0.015) * 0.5 + music + b["bass"]
    out[:, round(GAP * SR) : round(at(DROP) * SR)] *= 0.0  # the dry beat of silence before the drop
    out += b["swell"]
    out = soft_clip(out, 1.15)
    top = np.max(np.abs(out))
    # A light limiter (+2 dB): more drive flattened the arc, and the robots bar read only 3 dB under
    # the drop. The robots should be soft, the drop the loudest bar, the home a step down.
    out = out * limiter_gain(out / top, drive=10 ** (2 / 20)) / top
    out *= np.clip((mix.length - mix.time) / mix.fade, 0, 1) ** 2
    return out * PEAK / np.max(np.abs(out))


# ---- Shared instruments and the two shared bars (robots, build).


def boop(note: str) -> np.ndarray:
    """The robots' boop (the owner's pick, 2026-10-03): a sine gliding down from a fifth above."""
    t = t_axis(0.55)
    f = hz(note)
    phase = 2 * np.pi * np.cumsum(f * (1 + 0.5 * np.exp(-t / 0.04))) / SR
    body = np.sin(phase) + 0.18 * np.sin(2 * phase) * np.exp(-t / 0.05)
    return body * np.minimum(1, t / 0.008) * np.exp(-t / 0.13)


def lead(note: str, seconds: float, r: np.random.Generator) -> np.ndarray:
    """The hook voice: a bright supersaw with a quick filter blip and a short decay."""
    t = t_axis(seconds)
    x = supersaw(hz(note), seconds, r) * np.minimum(1, t / 0.004) * np.exp(-t / 0.35)
    return fft_filter(x, lambda f: lp(7000)(f) * hp(300)(f))


def chord_hold(bar: int, r: np.random.Generator, cutoff: float) -> np.ndarray:
    voicing = harmony(bar)[0]
    seconds = BAR + 0.02
    x = chord(voicing, r, 0.4, seconds, gate(seconds, 0.006, 0.04))
    return fft_filter(x, lambda f: lp(cutoff)(f) * hp(170)(f)) / len(voicing)


def robots_bar(mix: Mix) -> None:
    for i, (eighth, note) in enumerate(MELODY):
        mix.add("music", panned(boop(note), 0.25 * (i - 2) / 2), at(ROBOTS, eighth / 2), 0.55, 0.3)
    mix.add("music", pad(harmony(ROBOTS)[0], mix.rng("pad"), BAR + 0.4, 900), at(ROBOTS), 0.22, 0.4)
    muffled = fft_filter(kick(mix.rng("kick")), lp(220))
    for beat in (0, 2):
        mix.add("drums", muffled, at(ROBOTS, beat), 0.3)


def build_bar(mix: Mix) -> None:
    t0 = at(BUILD)
    k = kick(mix.rng("kick"))
    for beat in range(4):
        if at(BUILD, beat) < GAP:
            mix.add("drums", k, at(BUILD, beat), 0.4 + 0.12 * beat)
    # Snare roll: 8ths, then 16ths, then 32nds, rising in pitch, band and level up to the gap.
    hits = [b / 2 for b in range(4)] + [2 + b / 4 for b in range(4)] + [3 + b / 8 for b in range(4)]
    for i, beat in enumerate(hits):
        u = beat / 3.5
        s = snare(mix.rng("snare"), tone=180 + 170 * u**1.5, band=1800 + 2800 * u, decay=0.09 - 0.05 * u)
        mix.add("drums", panned(s, 0.15 * (-1) ** i * u), at(BUILD, beat), 0.15 + 0.5 * u**1.6, 0.2)
    # The chord opens from 400 Hz to 14 kHz across the bar; the riser climbs to the gap.
    voicing = harmony(BUILD)[0]
    x = chord(voicing, mix.rng("chords"), 0.0, BAR, gate(BAR, 0.006, 0.03)) / len(voicing)
    sweep = lambda f, tt: lp(400 * (14000 / 400) ** np.clip(tt / BAR, 0, 1) ** 1.3, 1.2)(f) ** 2  # noqa: E731
    mix.add("music", fft_filter(tv_filter(x, sweep), hp(170)), t0, 0.9, 0.3)
    mix.add("drums", fft_filter(riser(mix.rng("riser"), GAP - t0), lp(9000)), t0, 0.32)
    # A reversed crash breathing in through the gap, peaking on the drop.
    swell = crash(mix.rng("swell"), seconds=0.7)[:, ::-1]
    swell = fft_filter(swell, lp(9000)) * np.linspace(0, 1, swell.shape[1]) ** 2
    mix.add("swell", swell, at(DROP) - swell.shape[1] / SR, 0.2)


def hook(mix: Mix, bar: int, voice: Callable[[str], np.ndarray], gain: float) -> None:
    for eighth, note in MELODY:
        mix.add("music", voice(up(note)), at(bar, eighth / 2), gain, 0.35)


def drop_accents(mix: Mix, impact_gain: float, crash_gain: float) -> None:
    mix.add("drums", crash(mix.rng("crash")), at(DROP), crash_gain, 0.3)
    mix.add("drums", impact(mix.rng("impact")), at(DROP), impact_gain)


# ---- Flavours. One handler set each: the drop bar, a lighter bar (home), a full bar.


def edm_full(mix: Mix, bar: int) -> None:
    k = kick(mix.rng("kick"), seconds=0.36, decay=0.15)
    for beat in range(4):
        mix.kick(k, at(bar, beat), 0.85)
        mix.add("drums", hat(mix.rng("hat"), 0.07), at(bar, beat + 0.5), 0.22)
    for s in range(16):
        mix.add("drums", panned(hat(mix.rng("hat"), 0.018), -0.3), at(bar, s / 4), 0.07 * (1.0 if s % 2 else 0.6))
    for beat in (1, 3):
        mix.add("drums", clap(mix.rng("clap")), at(bar, beat), 0.45, 0.25)
    mix.add("music", chord_hold(bar, mix.rng("chords"), 11000), at(bar), 1.0, 0.25)
    root = hz(harmony(bar)[1])
    for beat in range(4):
        mix.add("bass", bass_note(root, BEAT / 2, gate(BEAT / 2, 0.004, 0.03)), at(bar, beat + 0.5), 0.5)
    for s in range(0, 16, 2):
        notes = harmony(bar)[0]
        mix.add("music", panned(pluck(hz(up(notes[(s // 2) % len(notes)]))), 0.35 * (-1) ** s), at(bar, s / 4), 0.16)


def edm_home(mix: Mix, bar: int) -> None:
    k = fft_filter(kick(mix.rng("kick"), seconds=0.36, decay=0.15), lp(400))
    for beat in range(4):
        mix.kick(k, at(bar, beat), 0.45)
    mix.add("music", chord_hold(bar, mix.rng("chords"), 2400), at(bar), 0.6, 0.4)
    root = hz(harmony(bar)[1])
    for beat in range(4):
        mix.add("bass", bass_note(root, BEAT / 2, gate(BEAT / 2, 0.004, 0.03)), at(bar, beat + 0.5), 0.25)


def edm_drop(mix: Mix, bar: int) -> None:
    edm_full(mix, bar)
    mix.kick(kick(mix.rng("kick"), seconds=0.9, f_top=190, f_bottom=42, decay=0.38, click=0.5), at(bar), 0.6)
    drop_accents(mix, 0.75, 0.45)
    hook(mix, bar, lambda n: lead(n, 0.45, mix.rng("lead")), 0.5)
    mix.add("music", chop(2), at(bar), 0.6, 0.4)


def half_full(mix: Mix, bar: int) -> None:
    mix.kick(kick(mix.rng("kick"), seconds=0.6, decay=0.28), at(bar), 0.95)
    mix.kick(kick(mix.rng("kick"), seconds=0.4, decay=0.18), at(bar, 1.5), 0.5)
    mix.add("drums", snare(mix.rng("snare"), tone=190, band=2000, decay=0.22), at(bar, 2), 0.75, 0.9)
    for e in range(8):
        mix.add("drums", panned(hat(mix.rng("hat"), 0.02), 0.25), at(bar, e / 2), 0.06 if e % 2 else 0.04)
    voicing, root = harmony(bar)
    mix.add("music", pad(voicing, mix.rng("pad"), BAR + 0.4, 3800), at(bar), 1.1, 0.5)
    mix.add("bass", panned(sub(hz(root) * 2, BAR, 1.8), 0), at(bar), 0.55)
    tones = motif_tones(voicing)
    for k, step in enumerate((0, 2, 3, 2)):  # a slow pluck answer in quarters
        mix.add("music", panned(pluck(tones[step] * 2, 0.6), 0.3 * (-1) ** k), at(bar, k), 0.2, 0.5)


def half_home(mix: Mix, bar: int) -> None:
    mix.kick(fft_filter(kick(mix.rng("kick"), seconds=0.6, decay=0.28), lp(300)), at(bar), 0.7)
    voicing, root = harmony(bar)
    mix.add("music", pad(voicing, mix.rng("pad"), BAR + 0.4, 1800), at(bar), 0.6, 0.6)
    mix.add("bass", panned(sub(hz(root) * 2, BAR, 1.8), 0), at(bar), 0.3)


def half_drop(mix: Mix, bar: int) -> None:
    half_full(mix, bar)
    mix.kick(kick(mix.rng("kick"), seconds=1.2, f_top=160, f_bottom=36, decay=0.5, click=0.4), at(bar), 0.7)
    drop_accents(mix, 0.95, 0.5)
    hook(mix, bar, lambda n: pluck(hz(n), 0.8), 0.55)
    hook(mix, bar, lambda n: lead(n, 0.6, mix.rng("lead")), 0.22)


def marimba_motif(mix: Mix, bar: int, gain: float) -> None:
    tones = motif_tones(harmony(bar)[0])
    for k, step in enumerate(UP_DOWN):
        mix.add("music", panned(marimba(tones[step], mix.rng("marimba")), 0.3 * (-1) ** k), at(bar, k / 2), gain, 0.3)


def marimba_full(mix: Mix, bar: int) -> None:
    for beat in range(4):
        mix.kick(felt_kick(mix.rng("kick")), at(bar, beat), 0.8)
    for beat in (1, 3):
        mix.add("drums", rim(mix.rng("rim")), at(bar, beat), 0.35, 0.3)
        mix.add("drums", clap(mix.rng("clap")), at(bar, beat), 0.2, 0.3)
    for s in range(16):
        mix.add("drums", panned(shaker(mix.rng("shaker")), 0.35), at(bar, s / 4), 0.1 if s % 2 else 0.06)
    marimba_motif(mix, bar, 0.32)
    voicing, root = harmony(bar)
    mix.add("music", pad(voicing, mix.rng("pad"), BAR + 0.4, 2600), at(bar), 0.55, 0.4)
    for beat in (0, 1.5, 2.5):
        mix.add("bass", panned(plucked_bass(hz(root) * 2, 0.5), 0), at(bar, beat), 0.5)


def marimba_home(mix: Mix, bar: int) -> None:
    marimba_motif(mix, bar, 0.26)
    for s in range(0, 16, 2):
        mix.add("drums", panned(shaker(mix.rng("shaker")), 0.35), at(bar, s / 4), 0.06)
    voicing, root = harmony(bar)
    mix.add("music", pad(voicing, mix.rng("pad"), BAR + 0.4, 1600), at(bar), 0.35, 0.5)
    mix.add("bass", panned(plucked_bass(hz(root) * 2, 0.5), 0), at(bar), 0.3)


def marimba_drop(mix: Mix, bar: int) -> None:
    marimba_full(mix, bar)
    mix.kick(kick(mix.rng("kick"), seconds=0.8, f_top=170, f_bottom=44, decay=0.35, click=0.3), at(bar), 0.6)
    drop_accents(mix, 0.6, 0.35)
    hook(mix, bar, lambda n: marimba(hz(n), mix.rng("marimba")), 0.55)
    hook(mix, bar, lambda n: pluck(hz(n), 0.5), 0.3)


@dataclass(frozen=True)
class Flavour:
    name: str
    drop: Callable[[Mix, int], None]
    home: Callable[[Mix, int], None]
    full: Callable[[Mix, int], None]
    pump: float  # sidechain depth on the music bus


FLAVOURS = [
    Flavour("drop", edm_drop, edm_home, edm_full, 0.6),
    Flavour("halftime", half_drop, half_home, half_full, 0.0),
    Flavour("marimba", marimba_drop, marimba_home, marimba_full, 0.25),
]


def render(f: Flavour) -> np.ndarray:
    mix = Mix(LENGTH, FADE)
    robots_bar(mix)
    build_bar(mix)
    f.drop(mix, DROP)
    for bar in HOME:
        f.home(mix, bar)
    for bar in FULL:
        f.full(mix, bar)
    return master(mix, f.pump)


if __name__ == "__main__":
    for flavour in FLAVOURS:
        write(f"reveal-{flavour.name}", render(flavour))

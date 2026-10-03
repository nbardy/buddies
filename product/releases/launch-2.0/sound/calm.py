"""Three calmer scores for the launch video after the intro. Synthesized here, so we own them.

Owner, 2026-09-30: "the intro is great but then it goes just too upbeat and generic"; try three
versions that cut down the tempo and the pop-EDM energy. Each keeps edm.py's 128 BPM bar grid and
its Bm G D A harmony, so every cut in the edit still lands on a phrase and the intro's marimba
handoff (PostIntroBenefits.tsx) still fits. What changes is the feel: no four-on-the-floor, no
pumped supersaw, no vocal chops, no impacts.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/calm.py

Writes calm-halftime.wav, calm-pulse.wav, calm-downtempo.wav next to this file: stereo 48 kHz
16-bit, 74 s each, peak -10 dBFS (the intro's boom peaks near -3; see `master`).

  bars  1-4    0.000  OPENING a dark pad opens slowly, sparse marimba: the new home and its type
  bars  5-8    7.500  BUILD   the pad opens and the bass enters; a dark reversed swell into the drop
  bars  9-28  15.000  FEEL    one per version, below; an accent or a new layer on 13, 17, 21, 25, 29
  bars 33-36  60.000  CODA    no drums, dark pad, sparse marimba (the Vim line)
  bar  37     67.500  END     one soft D chord, a low D, a muffled boom; fades to 73.5 (end card)

  halftime   the pulse at half speed: kick on 1, a big roomy snare on 3, warm open pads, sustained
             sub, the marimba motif in 8ths; closed hats from the second phrase, a high marimba answer from the third
  pulse      no drum kit: a marimba 8th-note pulse, felt kick on each downbeat, sustained sub;
             layers arrive by phrase: the 2nd a high marimba line, the 3rd a shaker, the 4th the
             pad opens, the 5th the shaker drops out again
  downtempo  a swung half-time groove: kick on 1 and the "and" of 2, rimshot on 3, swung hats,
             a round plucked bass, dark pads, the marimba in sparse dotted 8ths
"""

from dataclasses import dataclass

import numpy as np

from edm import (
    BAR,
    BEAT,
    END_VOICING,
    PEAK,
    SR,
    at,
    bp,
    chord,
    crash,
    fft_filter,
    harmony,
    hat,
    hp,
    hz,
    kick,
    limiter_gain,
    lp,
    panned,
    place,
    reverb,
    rng_for,
    snare,
    soft_clip,
    t_axis,
    write,
)

LAST_GROOVE = 32
CODA = 33
END = 37
RING = 6.0
FADE = 4.0
LENGTH = at(END) + RING
PHRASES = (13, 17, 21, 25, 29)


# ---- The mix: four buses and two reverb sends, summed once at the end.


class Mix:
    def __init__(self):
        self.n = round(LENGTH * SR)
        self.time = np.arange(self.n) / SR
        self.bus = {name: np.zeros((2, self.n)) for name in ("drums", "room", "music", "hall", "bass")}
        self.r = {}

    def rng(self, element: str) -> np.random.Generator:
        """One generator per element, shared across bars, so every render is identical."""
        return self.r.setdefault(element, rng_for(f"calm-{element}"))

    def add(self, bus: str, x: np.ndarray, t0: float, gain: float, send: float = 0.0) -> None:
        """Place a clip on a bus; `send` also feeds that bus's reverb (drums → room, music → hall)."""
        stereo = x if x.ndim == 2 else panned(x, 0)
        place(self.bus[bus], stereo, t0, gain)
        if send:
            place(self.bus[{"drums": "room", "music": "hall"}[bus]], stereo, t0, gain * send)


def master(mix: Mix) -> np.ndarray:
    b = mix.bus
    out = b["drums"] + reverb(b["room"], 2.2, "calm-room", 0.02) * 0.45
    out += b["music"] + reverb(b["hall"], 3.0, "calm-hall", 0.03) * 0.4 + b["bass"]
    out = soft_clip(out, 1.1)
    top = np.max(np.abs(out))
    out = out * limiter_gain(out / top, drive=10 ** (4 / 20)) / top
    out *= np.clip((LENGTH - mix.time) / FADE, 0, 1) ** 2
    # The intro's boom peaks near -3 dBFS and its calm marimba sits around -19 dB mean. Mastered to a
    # -1 dBFS peak the groove read at -9 dB mean, 10 dB above the intro (owner, 2026-09-30: "too
    # loud"). -10 dBFS peak lands the groove near the intro's marimba level.
    return out * SCORE_PEAK / np.max(np.abs(out))


# ---- Instruments.

PAD_RMS = 0.2
SCORE_PEAK = 10 ** (-10 / 20)


def marimba(f: float, r: np.random.Generator, seconds: float = 2.0) -> np.ndarray:
    """The intro's marimba (synth.py): three decaying bar modes plus a felt click."""
    t = t_axis(seconds)
    scale = (262 / f) ** 0.5
    modes = [(1.0, 1.0, 0.9), (3.93, 0.3, 0.22), (9.8, 0.08, 0.06)]
    tone = sum(a * np.sin(2 * np.pi * f * m * t) * np.exp(-t / (d * scale)) for m, a, d in modes)
    felt = fft_filter(r.standard_normal(len(t)), lp(1200)) * np.exp(-t / 0.004) * 0.6
    return (tone + felt) * np.minimum(1, t / 0.002)


def pad(voicing: list[str], r: np.random.Generator, seconds: float, cutoff: float) -> np.ndarray:
    """A slow-breathing, darkened chord: soft attack and release, no sidechain."""
    t = t_axis(seconds)
    env = np.minimum(1, t / 0.35) * np.clip((seconds - t) / 0.45, 0, 1)
    x = fft_filter(chord(voicing, r, 0.0, seconds, env), lambda f: lp(cutoff)(f) * hp(140)(f))
    # Five stacked supersaws are loud and get louder as the filter opens; left raw they buried
    # everything else and flattened the coda to the groove's level. Normalise to a fixed RMS so the
    # gains below mean the same thing at every cutoff.
    return x * PAD_RMS / np.sqrt(np.mean(x**2))


def sub(root: float, seconds: float, decay: float) -> np.ndarray:
    t = t_axis(seconds)
    return np.sin(2 * np.pi * root * t) * np.minimum(1, t / 0.02) * np.exp(-t / decay) * np.clip((seconds - t) / 0.05, 0, 1)


def plucked_bass(root: float, seconds: float) -> np.ndarray:
    t = t_axis(seconds)
    body = np.sin(2 * np.pi * root * t) + 0.25 * np.sin(4 * np.pi * root * t) * np.exp(-t / 0.08)
    return np.tanh(1.4 * body) * np.minimum(1, t / 0.004) * np.exp(-t / 0.3)


def felt_kick(r: np.random.Generator) -> np.ndarray:
    return fft_filter(kick(r, seconds=0.6, f_top=120, f_bottom=45, decay=0.25, click=0.05), lp(220))


def rim(r: np.random.Generator) -> np.ndarray:
    t = t_axis(0.08)
    click = fft_filter(r.standard_normal(len(t)), bp(2400, 1.5)) * np.exp(-t / 0.01)
    tone = np.sin(2 * np.pi * 1650 * t) * np.exp(-t / 0.018)
    x = click / np.max(np.abs(click)) + 0.6 * tone
    return x * np.minimum(1, t / 0.0005)


def shaker(r: np.random.Generator) -> np.ndarray:
    return fft_filter(hat(r, 0.025), bp(7000, 0.8))


def swell(r: np.random.Generator, seconds: float) -> np.ndarray:
    """A reversed, darkened crash: a breath in that peaks on the next downbeat."""
    x = fft_filter(crash(r, seconds=seconds)[:, ::-1], lp(4500))
    return x * np.linspace(0, 1, x.shape[1]) ** 2


def into(mix: Mix, bar: int, seconds: float, gain: float) -> None:
    x = swell(mix.rng("swell"), seconds)
    mix.add("drums", x, at(bar) - x.shape[1] / SR, gain)


# The marimba motif: four chord tones, D4 and up, walked up and down in 8ths.
UP_DOWN = [0, 1, 2, 3, 2, 1, 0, 1]


def motif_tones(voicing: list[str]) -> list[float]:
    low = [hz(n) for n in voicing[2:5]]
    return low + [low[0] * 2]


def motif_bar(mix: Mix, bar: int, gain: float, every: int = 1, swing: float = 0.0) -> None:
    tones = motif_tones(harmony(bar)[0])
    for k, step in enumerate(UP_DOWN):
        if k % every:
            continue
        late = swing * BEAT if k % 2 else 0.0
        mix.add("music", panned(marimba(tones[step], mix.rng("marimba")), 0.3 * (-1) ** k), at(bar, k / 2) + late, gain, 0.35)


def pad_bar(mix: Mix, bar: int, cutoff: float, gain: float) -> None:
    mix.add("music", pad(harmony(bar)[0], mix.rng("pad"), BAR + 0.4, cutoff), at(bar), gain, 0.5)


def sub_bar(mix: Mix, bar: int, gain: float) -> None:
    mix.add("bass", sub(hz(harmony(bar)[1]) * 2, BAR, 1.6), at(bar), gain)


# ---- Feels: one per version, bars 5-24. A sum type with one handler each.


@dataclass(frozen=True)
class HalfTime:
    name = "halftime"


@dataclass(frozen=True)
class Pulse:
    name = "pulse"


@dataclass(frozen=True)
class Downtempo:
    name = "downtempo"


Feel = HalfTime | Pulse | Downtempo


def halftime(mix: Mix) -> None:
    for bar in range(9, LAST_GROOVE + 1):
        rel = bar - 4  # phrase position as before the opening was added: layers enter at rel 9, 13, 17, 21
        pad_bar(mix, bar, 3200, 0.24)
        sub_bar(mix, bar, 0.45)
        motif_bar(mix, bar, 0.3)
        mix.add("drums", kick(mix.rng("kick"), decay=0.24, click=0.2), at(bar), 0.6)
        mix.add("drums", kick(mix.rng("kick"), decay=0.18, click=0.1), at(bar, 2.5), 0.35)
        mix.add("drums", snare(mix.rng("snare"), tone=190, band=2200, decay=0.14), at(bar, 2), 0.36, 1.4)
        if rel >= 9:
            for k in range(8):
                mix.add("drums", hat(mix.rng("hat"), 0.02), at(bar, k / 2), 0.05 if k % 2 else 0.03)
        if rel >= 17:
            for k in (0, 2):
                mix.add("music", marimba(motif_tones(harmony(bar)[0])[3] * 2, mix.rng("marimba")), at(bar, k), 0.12, 0.6)
    for bar in PHRASES:
        mix.add("drums", fft_filter(crash(mix.rng("crash")), lp(7000)), at(bar), 0.12, 0.5)


def pulse(mix: Mix) -> None:
    for bar in range(9, LAST_GROOVE + 1):
        rel = bar - 4  # phrase position as before the opening was added: layers enter at rel 9, 13, 17, 21
        pad_bar(mix, bar, 3600 if rel >= 17 else 1800, 0.3)
        sub_bar(mix, bar, 0.18)
        motif_bar(mix, bar, 0.3 if rel < 21 else 0.25)
        mix.add("drums", felt_kick(mix.rng("kick")), at(bar), 0.55, 0.2)
        if rel >= 9:
            tones = motif_tones(harmony(bar)[0])
            for k, step in enumerate((3, 2, 1, 2)):
                mix.add("music", marimba(tones[step] * 2, mix.rng("marimba")), at(bar, k), 0.13, 0.6)
        if 13 <= rel < 21:
            for s in range(16):
                mix.add("drums", shaker(mix.rng("shaker")), at(bar, s / 4), 0.05 if s % 2 else 0.025)
    for bar in PHRASES:
        into(mix, bar, 0.9, 0.12)


def downtempo(mix: Mix) -> None:
    swing = 0.16  # offbeat 8ths land this many beats late
    for bar in range(9, LAST_GROOVE + 1):
        rel = bar - 4  # phrase position as before the opening was added: layers enter at rel 9, 13, 17, 21
        pad_bar(mix, bar, 2000, 0.3)
        motif_bar(mix, bar, 0.24, every=3, swing=swing)
        root = hz(harmony(bar)[1]) * 2
        for b in (0, 1.5 + swing, 2.5 + swing):
            mix.add("bass", plucked_bass(root, 0.45), at(bar, b), 0.3)
        for b, g in ((0, 0.7), (1.5 + swing, 0.45)):
            mix.add("drums", kick(mix.rng("kick"), decay=0.16, click=0.15), at(bar, b), g)
        mix.add("drums", rim(mix.rng("rim")), at(bar, 2), 0.32, 0.5)
        for k in range(8):
            mix.add("drums", hat(mix.rng("hat"), 0.018), at(bar, k / 2 + (swing if k % 2 else 0)), 0.05 if k % 2 else 0.03)
    for bar in PHRASES:
        mix.add("drums", fft_filter(crash(mix.rng("crash")), lp(6000)), at(bar), 0.1, 0.4)


FEELS = {HalfTime: halftime, Pulse: pulse, Downtempo: downtempo}


# ---- Shared sections: the build under the benefits, the coda under the Vim line, the end chord.


def opening(mix: Mix) -> None:
    """Bars 1-4, under the new home and its two lines of type: no beat yet, the intro's calm kept going.
    A dark pad opens slowly and the marimba picks the motif out in sparse notes (owner, 2026-10-02:
    "then we go into the faster paced music")."""
    for bar in range(1, 5):
        u = (bar - 1) / 3
        pad_bar(mix, bar, 500 + 900 * u, 0.12 + 0.1 * u)
        motif_bar(mix, bar, 0.2, every=3)
    sub_bar(mix, 3, 0.08)
    sub_bar(mix, 4, 0.1)


def build(mix: Mix) -> None:
    """Bars 5-8, under the four benefits: the pad opens and the bass enters; the drop is bar 9."""
    for bar in range(5, 9):
        u = (bar - 5) / 3
        pad_bar(mix, bar, 700 + 2100 * u, 0.3 + 0.2 * u)
        if bar >= 7:
            sub_bar(mix, bar, 0.12)
    into(mix, 9, 1.6, 0.22)


def coda(mix: Mix) -> None:
    for bar in range(CODA, END):
        pad_bar(mix, bar, 1200, 0.2)
        tones = motif_tones(harmony(bar)[0])
        for k in (0, 3, 6):
            mix.add("music", marimba(tones[UP_DOWN[k]], mix.rng("marimba")), at(bar, k / 2), 0.2, 0.7)
    into(mix, END, 1.2, 0.15)
    t0 = at(END)
    mix.add("music", pad(END_VOICING, mix.rng("pad"), RING, 4000) * np.exp(-t_axis(RING) / 1.6), t0, 0.6, 0.6)
    mix.add("bass", sub(hz("D2"), RING, 1.4), t0, 0.25)
    mix.add("drums", felt_kick(mix.rng("kick")), t0, 0.4, 0.3)


def score(feel: Feel) -> np.ndarray:
    mix = Mix()
    opening(mix)
    build(mix)
    FEELS[type(feel)](mix)
    coda(mix)
    return master(mix)


if __name__ == "__main__":
    for feel in (HalfTime(), Pulse(), Downtempo()):
        write(f"calm-{feel.name}", score(feel))

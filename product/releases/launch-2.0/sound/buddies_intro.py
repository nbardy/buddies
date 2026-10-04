"""Sound for the Buddies robot intro (edit/src/BuddiesIntro.tsx). Synthesized here, so we own it.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/buddies_intro.py
Writes 16-bit mono 48 kHz WAVs next to this file. Deterministic (fixed seed).

Owner, 2026-10-03, on the first cut: "slow down the boop sound on each popping in, and the ding
dong is way too door bell and should be more intro style". So the pops are long, round boops
(the old pop-*.wav were 0.14 s blips), and the two marimba notes on the logo lock became a
swell into a boom plus a wide chord. The swell's length is tied to the picture: it ends exactly
on the lock (SWELL_SECONDS; BuddiesIntro.tsx starts it SWELL_SECONDS before `lock`).
Then: the swell ("zoom") and the hit's ring-out want more timbre and warmth, and the hit more ring.
"""

from pathlib import Path
import wave

import numpy as np

SR = 48_000
OUT = Path(__file__).parent
SWELL_SECONDS = 1.1
# The hit rings on past the intro's last frame, under the start of the home scene: the cut places
# it outside the intro's Sequence (Overload.OverloadTail), so the tail is not chopped.
# Owner, 2026-10-04, on the warm ring-out: "this is supposed to be the BOOM climax! Announcing
# buddies". So the hit is a big impact; three versions to choose from (HITS below).
PRE_DROP_GAP = 0.08  # the swell stops this long before the lock: a breath of silence before the boom
rng = np.random.default_rng(20261003)


def t_axis(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * SR)) / SR


def hz(semitones_from_a4: float) -> float:
    return 440.0 * 2 ** (semitones_from_a4 / 12)


def onepole(x: np.ndarray, cutoff: np.ndarray) -> np.ndarray:
    """One-pole lowpass with a per-sample cutoff."""
    a = 1 - np.exp(-2 * np.pi * np.broadcast_to(cutoff, x.shape) / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def saw(f: float, t: np.ndarray) -> np.ndarray:
    return 2 * ((f * t) % 1) - 1


def write(name: str, x: np.ndarray, peak: float) -> None:
    n = int(SR * 0.003)
    x = x.copy()
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    x = x / np.max(np.abs(x)) * peak
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    print(f"{name}.wav  {len(x) / SR:.2f}s")


# Boops: one per robot, climbing D major pentatonic (D4 F#4 A4 B4 D5, the marimba's key). Each is
# a sine that starts a fifth high and glides down over 120 ms, with a soft octave on top and a
# 0.45 s decay: a bubble, not a click. All five are made the same way (owner, 2026-10-03: "I liked
# the old version ... they were nice and all the same"; warmer 2nd/3rd boops were a misread).
BOOP_NOTES = [-7, -3, 0, 2, 5]
for k, semis in enumerate(BOOP_NOTES):
    t = t_axis(0.55)
    f = hz(semis)
    glide = f * (1 + 0.5 * np.exp(-t / 0.04))
    phase = 2 * np.pi * np.cumsum(glide) / SR
    env = np.minimum(1, t / 0.008) * np.exp(-t / 0.13)
    body = np.sin(phase) + 0.18 * np.sin(2 * phase) * np.exp(-t / 0.05)
    write(f"boop-{k}", body * env, peak=0.8)

# Swell (the "zoom" after the boops): a detuned D-major chord of saws over a sub D, the filter
# opening as it climbs, with only a little air on top; soft saturation rounds it. It was mostly
# noise; now it is mostly tone. Cut on the last sample so the hit lands as the drop.
t = t_axis(SWELL_SECONDS)
u = t / t[-1]
chord = [-19, -12, -7, -3]  # D3 A3 D4 F#4
tone = sum(saw(hz(s) * (1 + d), t) for s in chord for d in (-0.005, 0.005)) / (2 * len(chord))
sub = np.sin(2 * np.pi * hz(-31) * t)  # D2
air = rng.standard_normal(len(t))
swell = onepole(tone + 0.6 * sub + 0.12 * air, 220 + 3400 * u**2)
swell = np.tanh(2.0 * swell) * u**2.2 * (t < SWELL_SECONDS - PRE_DROP_GAP)
write("intro-swell", swell, peak=0.7)



def reverb(x: np.ndarray, seconds: float, tau: float, wet: float) -> np.ndarray:
    """Convolution with a decaying-noise impulse response (dark: one-pole at 5 kHz)."""
    t = t_axis(seconds)
    ir = onepole(rng.standard_normal(len(t)) * np.exp(-t / tau), np.full(len(t), 5000.0))
    ir /= np.sqrt(np.sum(ir**2))
    n = len(x) + len(ir)
    tail = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)[: len(x)]
    return x + wet * tail / np.max(np.abs(tail)) * np.max(np.abs(x))


def stab(t: np.ndarray, open_hz: float, close_hz: float, decay: float) -> np.ndarray:
    """A bright supersaw D major stab (D3 F#3 A3 D4 F#4 A4), filter closing from open_hz to close_hz."""
    notes = [-19, -15, -12, -7, -3, 0]
    x = sum(saw(hz(s) * (1 + d), t) for s in notes for d in (-0.008, -0.004, 0.0, 0.004, 0.008)) / (5 * len(notes))
    cutoff = close_hz + (open_hz - close_hz) * np.exp(-t / 0.5)
    return onepole(x, cutoff) * np.minimum(1, t / 0.004) * np.exp(-t / decay)


def faded(x: np.ndarray, t: np.ndarray, seconds: float, fade: float) -> np.ndarray:
    return x * np.clip((seconds - t) / fade, 0, 1) ** 2


# A: Drop. An EDM drop on the lock: a punchy kick into a D1 sub, a clap crack, and a bright stab
# that pumps on quarter notes at the score's 128 bpm, all into a reverb.
T_A = 4.0
t = t_axis(T_A)
kick = np.sin(2 * np.pi * np.cumsum(45 + 115 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.35)
sub = np.tanh(2.5 * np.sin(2 * np.pi * hz(-43) * t) * np.exp(-t / 1.2))  # D1
clap = sum(np.roll(rng.standard_normal(len(t)) * np.exp(-t / 0.012), int(k * 0.011 * SR)) for k in range(3))
clap = (clap - onepole(clap, np.full(len(t), 900.0))) * np.exp(-t / 0.15)
pump = 1 - 0.65 * np.exp(-((t % (60 / 128)) / 0.09))
drop = 1.0 * kick + 0.6 * sub + reverb(0.35 * clap + 0.55 * stab(t, 9000, 1400, 1.0) * pump, 2.5, 0.7, 0.5)
write("intro-hit-drop", faded(drop, t, T_A, 1.0), peak=0.9)

# B: Trailer. A movie-trailer slam: a huge distorted boom sweeping 70 → 30 Hz, a metallic hit of
# inharmonic partials over a noise crack, a low saw chord swelling under it, and a long dark wash.
T_B = 4.5
t = t_axis(T_B)
boom = np.tanh(3.0 * np.sin(2 * np.pi * np.cumsum(30 + 40 * np.exp(-t / 0.25)) / SR) * np.exp(-t / 1.6))
metal = sum(np.sin(2 * np.pi * f * t) / (1 + i) for i, f in enumerate([181, 263, 397, 541, 713, 979, 1311])) * np.exp(-t / 0.6)
crack = rng.standard_normal(len(t)) * np.exp(-t / 0.03)
low = onepole(sum(saw(hz(s) * (1 + d), t) for s in (-31, -24, -19) for d in (-0.005, 0.005)) / 6, np.full(len(t), 900.0))
low *= np.minimum(1, t / 0.4) * np.exp(-t / 2.0)
trailer = 1.0 * boom + reverb(0.45 * metal + 0.3 * crack + 0.5 * low, 4.0, 1.4, 0.7)
write("intro-hit-trailer", faded(trailer, t, T_B, 1.3), peak=0.9)

# C: Boom + stab. The "AI Overload!" impact (synth.py's impact.wav, the boom the owner liked) with
# the bright stab on top, into a reverb.
with wave.open(str(OUT / "impact.wav")) as w:
    impact = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(float) / 32767
T_C = 4.0
t = t_axis(T_C)
boom_c = np.zeros(len(t))
boom_c[: min(len(t), len(impact))] = impact[: len(t)]
both = 1.0 * boom_c + reverb(0.6 * stab(t, 7000, 1200, 1.2), 3.0, 0.9, 0.55)
write("intro-hit-impact", faded(both, t, T_C, 1.0), peak=0.9)

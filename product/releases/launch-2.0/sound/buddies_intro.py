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
# The hit rings 4.5 s: past the intro's last frame and under the start of the home scene. The cut
# places it outside the intro's Sequence (Overload.OverloadTail), so the ring is not chopped.
HIT_SECONDS = 4.5
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
write("intro-swell", np.tanh(2.0 * swell) * u**2.2, peak=0.7)

# Hit: a sub boom (90 → 48 Hz) under a wide D add9 chord. Detuned saws bloom open and settle low;
# a warm sine chord and a high shimmer ring on underneath, beating slowly as they fade; the last
# 1.2 s fade to silence.
t = t_axis(HIT_SECONDS)
boom = np.sin(2 * np.pi * np.cumsum(48 + 42 * np.exp(-t / 0.06)) / SR) * np.exp(-t / 0.5)
pad_notes = [-31, -19, -12, -7, -3, 7]  # D2 D3 A3 D4 F#4 E5
saws = sum(saw(hz(s) * (1 + d), t) for s in pad_notes for d in (-0.006, 0.0, 0.006)) / (3 * len(pad_notes))
bloom = 380 + 2400 * np.exp(-((t - 0.25) ** 2) / 0.08)
saws = onepole(saws, bloom) * np.exp(-t / 1.6)
warm = sum(np.sin(2 * np.pi * hz(s) * (1 + d) * t) for s in pad_notes for d in (-0.0015, 0.0015))
warm = warm / (2 * len(pad_notes)) * np.exp(-t / 2.2)
shimmer = sum(np.sin(2 * np.pi * hz(s) * t) for s in (19, 24, 28)) / 3 * np.exp(-t / 2.0)
shimmer *= 0.75 + 0.25 * np.sin(2 * np.pi * 3.2 * t)
chord = np.tanh(1.6 * (0.9 * saws + 0.8 * warm)) + 0.12 * shimmer
chord *= np.minimum(1, t / 0.02)
tail = np.clip((HIT_SECONDS - t) / 1.2, 0, 1) ** 2
write("intro-hit", (boom + 0.55 * chord) * tail, peak=0.85)

"""Sound for the Buddies robot intro (edit/src/BuddiesIntro.tsx). Synthesized here, so we own it.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/buddies_intro.py
Writes 16-bit mono 48 kHz WAVs next to this file. Deterministic (fixed seed).

Owner, 2026-10-03, on the first cut: "slow down the boop sound on each popping in, and the ding
dong is way too door bell and should be more intro style". So the pops are long, round boops
(the old pop-*.wav were 0.14 s blips), and the two marimba notes on the logo lock became a
swell into a boom plus a wide chord. The swell's length is tied to the picture: it ends exactly
on the lock (SWELL_SECONDS; BuddiesIntro.tsx starts it SWELL_SECONDS before `lock`).
"""

from pathlib import Path
import wave

import numpy as np

SR = 48_000
OUT = Path(__file__).parent
SWELL_SECONDS = 1.1
# The hit ends with the intro: in the cut the intro's Sequence ends 2.0 s after the lock and would
# chop a longer tail, so it fades out over its last 0.8 s instead (lock -> end in BuddiesIntro.tsx).
HIT_SECONDS = 2.0
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
# a sine that starts a fifth high and glides down over 120 ms, with a soft octave on top: a bubble,
# not a click. Owner, 2026-10-03: the 2nd and 3rd want "more timbre and warmth", and the 3rd "a
# little more ring on the fade out". So each boop has a `warmth` (a sub-octave sine, slower-decaying
# 2nd and 3rd partials, gentle tanh saturation) and a `ring` (decay time constant and length).
# 2nd and 3rd only.
Boop = tuple[int, float, float, float, float]  # semitones from A4, warmth 0..1, decay tau (s), length (s), ring 0..1
BOOPS: list[Boop] = [
    (-7, 0.0, 0.13, 0.55, 0.0),
    (-3, 0.7, 0.16, 0.65, 0.0),
    (0, 0.8, 0.34, 1.20, 1.0),
    (2, 0.0, 0.13, 0.55, 0.0),
    (5, 0.0, 0.13, 0.55, 0.0),
]
for k, (semis, warmth, tau, length, ring_mix) in enumerate(BOOPS):
    t = t_axis(length)
    f = hz(semis)
    glide = f * (1 + 0.5 * np.exp(-t / 0.04))
    phase = 2 * np.pi * np.cumsum(glide) / SR
    env = np.minimum(1, t / 0.008) * np.exp(-t / tau)
    body = (
        np.sin(phase)
        + 0.18 * np.sin(2 * phase) * np.exp(-t / (0.05 + 0.15 * warmth))
        + warmth * 0.22 * np.sin(3 * phase) * np.exp(-t / 0.12)
        + warmth * 0.35 * np.sin(0.5 * phase)
    )
    body = np.tanh(body * (1 + 1.2 * warmth)) / np.tanh(1 + 1.2 * warmth)
    # The ring: a faint detuned copy beating slowly against the fundamental as it fades.
    ring = ring_mix * 0.25 * np.sin(phase * 1.003) * np.exp(-t / (tau * 1.4))
    write(f"boop-{k}", (body + ring) * env, peak=0.8)

# Swell: noise and a detuned D-major chord rising together, the filter opening as they climb,
# then cut on the last sample so the hit lands as the drop.
t = t_axis(SWELL_SECONDS)
u = t / t[-1]
chord = [-19, -12, -7, -3]  # D3 A3 D4 F#4
tone = sum(np.sin(2 * np.pi * hz(s) * (1 + d) * t) for s in chord for d in (-0.004, 0.004))
noise = rng.standard_normal(len(t))
swell = onepole(0.5 * tone + 0.8 * noise, 300 + 6000 * u**2) * u**2.2
write("intro-swell", swell, peak=0.7)

# Hit: a sub boom (90 → 48 Hz) under a wide D add9 chord of detuned saws whose filter blooms open
# and closes again, with a high shimmer that rings out under the logo hold.
t = t_axis(HIT_SECONDS)
boom = np.sin(2 * np.pi * np.cumsum(48 + 42 * np.exp(-t / 0.06)) / SR) * np.exp(-t / 0.5)


def saw(f: float) -> np.ndarray:
    return 2 * ((f * t) % 1) - 1


pad_notes = [-31, -19, -12, -7, -3, 7]  # D2 D3 A3 D4 F#4 E5
pad = sum(saw(hz(s) * (1 + d)) for s in pad_notes for d in (-0.006, 0.0, 0.006))
bloom = 500 + 3500 * np.exp(-((t - 0.25) ** 2) / 0.08)
pad = onepole(pad, bloom) * np.minimum(1, t / 0.02) * np.exp(-t / 1.1)
shimmer = sum(np.sin(2 * np.pi * hz(s) * t) for s in (19, 24, 28)) * np.exp(-t / 0.9) * np.minimum(1, t / 0.05)
tail = np.clip((HIT_SECONDS - t) / 0.8, 0, 1) ** 2
write("intro-hit", (1.0 * boom + 0.22 * pad / len(pad_notes) + 0.05 * shimmer) * tail, peak=0.85)

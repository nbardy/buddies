"""Up-tempo EDM cue under the product-features section of the launch video. Synthesized here, so we own it.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/edm.py

128 BPM in B minor / D major, next to the D-major marimba intro. beat = 0.46875 s, bar = 1.875 s.
Two cues come from one set of elements. Each is a table of sections (BUILD_CUE, FULL_CUE, below);
retime a cue by editing the table's bars.

edm-build.wav, 15 s. A locked cut uses it, so it must stay sample-identical:
  bar 1   0.000  BUILD  Bm  half-time filtered kick, chords at 400 Hz lowpass, vocal chop "oh-ah"
  bar 2   1.875         G   four-on-the-floor, snare roll in 8ths
  bar 3   3.750         D   vocal chop "ay-oh", snare 16ths, noise/pitch riser starts
  bar 4   5.625         A   snare 32nds, filter fully open; GAP 7.266-7.500 (tails + reversed crash)
  bar 5   7.500  DROP   Bm  impact + crash + big kick, pumped supersaws, bass, clap, vocal chop
  bar 6   9.375  GROOVE G
  bar 7  11.250         D   crash (quiet), vocal chop
  bar 8  13.125         A   cue ends at 15.000

edm-full.wav, 58.5 s. Runs from the title to the end card (script v2, 2026-09-30); every scene is
one 4-bar phrase, so every section change lands where the ear expects it:
  bars  1-4    0.000  BUILD      as above; the four benefits, over the intro's marimba handing off
  bar   5      7.500  DROP       as above; "Ask your agents"
  bars  6-24   9.375  GROOVE     crashes + chops on 9, 13, 17, 21 (the phrase starts)
  bars 25-28  45.000  CODA       Bm G D A: no drums or bass, chords lowpassed at 1.2 kHz and softly
                                 pumped, sparse arp, one chop drenched in ping-pong echo (the Vim line)
  bar  29     52.500             a quiet reversed swell into one soft D-major chord, a low D and a
                                 muffled boom; no impact, no crash (the end card); fades to 58.5

The drop lands at exactly 7.500 s (sample 360000) in both. Writes stereo 48 kHz 16-bit WAVs next
to this file: edm-build.wav / edm-full.wav (the mix, peak -1 dBFS) and
edm-stem-{drums,music,vox}.wav / edm-full-stem-{drums,music,vox}.wav. The stems sum to the mix
(to 16-bit rounding): the master limiter is a gain envelope computed from the mix and applied
identically to every stem, so the edit can rebalance them. Drums stem also carries the riser, crash
and impact. Deterministic: every element draws noise from its own fixed seed, and each seeded
generator is shared across sections in bar order, so the full cue's bars 1-5 match the build.

Filters are applied in the frequency domain (whole-buffer FFT, or STFT frames for time-varying
cutoffs) instead of synth.py's per-sample loop, which would take minutes on 15 s of stereo.
"""

from dataclasses import dataclass
from functools import cache
from pathlib import Path
import wave
import zlib

import numpy as np

SR = 48_000
OUT = Path(__file__).parent
BPM = 128
BEAT = 60 / BPM  # 0.46875 s
BAR = 4 * BEAT  # 1.875 s
DROP = 4 * BAR  # 7.5 s
GAP = DROP - BEAT / 2  # 7.265625 s: the last 1/8 of bar 4 is dry silence
PEAK = 10 ** (-1 / 20)  # -1 dBFS


def rng_for(name: str) -> np.random.Generator:
    """Each element owns its seed, so retuning one element never reshuffles another's noise."""
    return np.random.default_rng(zlib.crc32(name.encode()))


def t_axis(seconds: float) -> np.ndarray:
    return np.arange(round(seconds * SR)) / SR


def at(bar: int, beat: float = 0.0) -> float:
    """Time of a 1-based bar plus a 0-based (fractional) beat."""
    return (bar - 1) * BAR + beat * BEAT


NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi(note: str) -> int:
    return NAMES.index(note[:-1]) + 12 * (int(note[-1]) + 1)


def mhz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def hz(note: str) -> float:
    return mhz(midi(note))


# ---- Filters: analog prototype responses evaluated on FFT bins. fc may be an array (per frame).


def lp(fc, q=0.707):
    return lambda f: 1 / (1 - (f / fc) ** 2 + 1j * f / (fc * q))


def hp(fc, q=0.707):
    return lambda f: -((f / fc) ** 2) / (1 - (f / fc) ** 2 + 1j * f / (fc * q))


def bp(fc, q=1.0):
    return lambda f: (1j * f / (fc * q)) / (1 - (f / fc) ** 2 + 1j * f / (fc * q))


def fft_filter(x: np.ndarray, response) -> np.ndarray:
    """Constant filter over the whole buffer (last axis). Zero-padded so the tail does not wrap."""
    n = x.shape[-1]
    nfft = 1 << int(np.ceil(np.log2(n + SR // 4)))
    f = np.fft.rfftfreq(nfft, 1 / SR)
    return np.fft.irfft(np.fft.rfft(x, nfft) * response(f), nfft)[..., :n]


def tv_filter(x: np.ndarray, response_at, frame: int = 1024, hop: int = 256) -> np.ndarray:
    """Time-varying filter: Hann STFT frames (75% overlap), each multiplied by response_at(f, t)
    at the frame's centre time. f broadcasts as (1, bins), t as (frames, 1)."""
    x2 = np.atleast_2d(x)
    ch, n = x2.shape
    padded = np.concatenate([np.zeros((ch, frame)), x2, np.zeros((ch, 2 * frame))], axis=1)
    count = (n + frame) // hop + 1
    frames = np.lib.stride_tricks.sliding_window_view(padded, frame, axis=1)[:, ::hop][:, :count]
    starts = np.arange(count) * hop
    centres = (starts + frame / 2 - frame) / SR
    f = np.fft.rfftfreq(2 * frame, 1 / SR)
    window = np.hanning(frame + 1)[:-1]  # periodic Hann: overlap-adds to exactly 2 at hop=frame/4
    spec = np.fft.rfft(frames * window, 2 * frame) * response_at(f[None, :], centres[:, None])
    y = np.fft.irfft(spec, 2 * frame)
    out = np.zeros((ch, padded.shape[1] + 2 * frame))
    for k, s in enumerate(starts):
        out[:, s : s + 2 * frame] += y[:, k]
    return (out[:, frame : frame + n] / 2.0).reshape(np.shape(x))


# ---- Placement and envelopes


def panned(x: np.ndarray, pan: float) -> np.ndarray:
    """Mono -> stereo, equal power. pan in [-1, 1]."""
    a = (pan + 1) * np.pi / 4
    return np.stack([np.cos(a) * x, np.sin(a) * x])


def place(bus: np.ndarray, x: np.ndarray, t0: float, gain: float = 1.0) -> None:
    """Add a stereo clip into a bus at t0, truncating at the bus end."""
    s = round(t0 * SR)
    e = min(s + x.shape[-1], bus.shape[-1])
    bus[:, s:e] += gain * x[:, : e - s]


def gate(seconds: float, attack: float, release: float) -> np.ndarray:
    t = t_axis(seconds)
    return np.minimum(1, t / attack) * np.clip((seconds - t) / release, 0, 1)


def smoothstep(u: np.ndarray) -> np.ndarray:
    u = np.clip(u, 0, 1)
    return u * u * (3 - 2 * u)


# ---- Oscillators


def saw(freq: float, n: int, phase0: float) -> np.ndarray:
    """PolyBLEP band-limited sawtooth, vectorised."""
    dt = freq / SR
    ph = (phase0 + dt * np.arange(1, n + 1)) % 1.0
    y = 2 * ph - 1
    lo = ph < dt
    u = ph[lo] / dt
    y[lo] -= 2 * u - u * u - 1
    hi = ph > 1 - dt
    u = (ph[hi] - 1) / dt
    y[hi] -= u * u + 2 * u + 1
    return y


DETUNE_CENTS = [-26, -17, -8, 0, 8, 17, 26]
SPREAD = [-0.9, -0.6, -0.3, 0.0, 0.3, 0.6, 0.9]


def supersaw(f: float, seconds: float, r: np.random.Generator) -> np.ndarray:
    """Seven detuned saws, spread across the stereo field."""
    n = round(seconds * SR)
    return sum(
        panned(saw(f * 2 ** (c / 1200), n, r.uniform()), p) for c, p in zip(DETUNE_CENTS, SPREAD)
    ) / np.sqrt(7)


# ---- Harmony: vi-IV-I-V in D. Bm first answers the intro's D chord; A (V) leads into the drop.

PROGRESSION = [  # (voicing, bass)
    (["F#3", "B3", "D4", "F#4", "B4"], "B1"),
    (["G3", "B3", "D4", "G4", "B4"], "G1"),
    (["F#3", "A3", "D4", "F#4", "A4"], "D2"),
    (["E3", "A3", "C#4", "E4", "A4"], "A1"),
]


CHORDS = dict(zip(("Bm", "G", "D", "A"), PROGRESSION))
END_VOICING = ["D3", "A3", "D4", "F#4", "A4", "D5"]  # the final hit: D major, root on top


def harmony(bar: int):
    return PROGRESSION[(bar - 1) % 4]


def chord(voicing: list[str], r: np.random.Generator, octave_layer: float, seconds: float, env):
    body = sum(supersaw(hz(n), seconds, r) for n in voicing)
    top = supersaw(hz(voicing[-1]) * 2, seconds, r) * octave_layer
    return (body + top) * env


def chord_bar(voicing: list[str], r: np.random.Generator, octave_layer: float) -> np.ndarray:
    """One bar of sustained supersaw chord, slightly overlapping the next bar's attack."""
    seconds = BAR + 0.015
    return chord(voicing, r, octave_layer, seconds, gate(seconds, 0.006, 0.03))


def ring_chord(voicing: list[str], r: np.random.Generator, seconds: float) -> np.ndarray:
    """The end hit: struck once, decaying over `seconds` instead of holding for a bar."""
    t = t_axis(seconds)
    return chord(voicing, r, 0.45, seconds, np.minimum(1, t / 0.006) * np.exp(-t / 1.1))


def bass_note(root: float, seconds: float, env: np.ndarray) -> np.ndarray:
    """Sine plus a dark saw an octave up, saturated."""
    t = t_axis(seconds)
    body = np.sin(2 * np.pi * root * t) + 0.35 * fft_filter(saw(root * 2, len(t), 0.0), lp(900))
    return panned(np.tanh(1.6 * body) * env, 0)


def pump(n: int, depth: float, kicks: list[float], release: float = 0.75 * BEAT) -> np.ndarray:
    """Sidechain gain over n samples: duck by `depth` at each kick, back to unity over `release`."""
    g = np.ones(n)
    for k in kicks:
        s = round(k * SR)
        e = min(n, s + round(release * SR))
        tt = np.arange(e - s) / SR
        duck = depth * (1 - tt / release) ** 2 * np.minimum(1, tt / 0.003)
        g[s:e] = np.minimum(g[s:e], 1 - duck)
    return g


# ---- Drums and FX


def kick(r, seconds=0.42, f_top=170.0, f_bottom=47.0, decay=0.2, click=0.35) -> np.ndarray:
    t = t_axis(seconds)
    f = f_bottom + (f_top - f_bottom) * np.exp(-t / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    tick = fft_filter(r.standard_normal(len(t)), hp(2500)) * np.exp(-t / 0.002)
    return np.tanh(1.8 * (body + click * tick)) * np.clip((seconds - t) / 0.02, 0, 1)


def snare(r, tone: float, band: float, decay: float) -> np.ndarray:
    t = t_axis(0.3)
    body = np.sin(2 * np.pi * tone * t) * np.exp(-t / 0.035)
    body += 0.5 * np.sin(2 * np.pi * tone * 1.62 * t) * np.exp(-t / 0.025)
    noise = fft_filter(r.standard_normal(len(t)), bp(band, 0.7)) * np.exp(-t / decay)
    x = 0.5 * body + 1.4 * noise / np.max(np.abs(noise))
    return x * np.minimum(1, t / 0.0008)


HAT_PARTIALS = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]  # 808-style square cluster


def hat(r, decay: float) -> np.ndarray:
    t = t_axis(decay * 6)
    metal = sum(np.sign(np.sin(2 * np.pi * f * 1.5 * t + r.uniform(0, 6.3))) for f in HAT_PARTIALS)
    x = fft_filter(0.6 * metal + r.standard_normal(len(t)), hp(7500, 0.9))
    x = fft_filter(x, lp(14000))
    return x / np.max(np.abs(x)) * np.exp(-t / decay) * np.minimum(1, t / 0.0005)


def clap(r) -> np.ndarray:
    t = t_axis(0.45)
    bursts = sum((t >= o) * np.exp(-np.clip(t - o, 0, None) / 0.006) for o in (0, 0.011, 0.023))
    tail = (t >= 0.034) * np.exp(-np.clip(t - 0.034, 0, None) / 0.13)
    noise = fft_filter(r.standard_normal((2, len(t))), bp(1400, 0.8))
    x = noise * (bursts + tail)
    return x / np.max(np.abs(x))


def crash(r, seconds=3.0) -> np.ndarray:
    t = t_axis(seconds)
    noise = fft_filter(r.standard_normal((2, len(t))), hp(4500))
    metal = sum(
        np.sin(2 * np.pi * r.uniform(3000, 9000) * t + r.uniform(0, 6.3)) for _ in range(40)
    ) / 6
    x = (noise / np.max(np.abs(noise)) + 0.35 * metal) * np.exp(-t / 0.8)
    x = fft_filter(x, lp(13000))
    return x / np.max(np.abs(x)) * np.minimum(1, t / 0.001)


def impact(r) -> np.ndarray:
    t = t_axis(2.4)
    f = 30 + 45 * np.exp(-t / 0.25)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.75)
    boom = fft_filter(r.standard_normal(len(t)), lp(900)) * np.exp(-t / 0.06)
    x = np.tanh(2.0 * (sub + 0.8 * boom / np.max(np.abs(boom))))
    return x * np.minimum(1, t / 0.001)


def riser(r, seconds: float) -> np.ndarray:
    """Noise through a rising bandpass plus a two-octave pitch sweep, loudness growing to the end."""
    t = t_axis(seconds)
    u = t / t[-1]
    centre = lambda f, tt: bp(400 * (9000 / 400) ** np.clip(tt / seconds, 0, 1), 1.6)(f)  # noqa: E731
    noise = tv_filter(r.standard_normal((2, len(t))), centre)
    noise /= np.max(np.abs(noise))
    tone = np.sin(2 * np.pi * np.cumsum(220 * 8 ** (u**1.5)) / SR)
    return (noise + 0.25 * np.stack([tone, tone])) * u**2.2


# ---- Pluck arpeggio: additive "harmonics", upper partials decay faster (bright tick -> soft tone)


def pluck(f: float, seconds: float = 0.34) -> np.ndarray:
    t = t_axis(seconds)
    ks = np.arange(1, int(12000 // f) + 1)
    x = sum(k**-0.9 * np.sin(2 * np.pi * k * f * t) * np.exp(-t * (6 + 4.5 * k)) for k in ks)
    return x * np.minimum(1, t / 0.001) * np.clip((seconds - t) / 0.02, 0, 1)


ARP_STEPS = [0, 1, 2, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3, 4, 5, 4]  # rolling climb within a bar


def arp_notes(voicing: list[str], start: str) -> list[float]:
    """16 sixteenths climbing through chord tones from `start` upward."""
    classes = {midi(n) % 12 for n in voicing}
    ladder = [m for m in range(midi(start), 110) if m % 12 in classes]
    return [mhz(ladder[s]) for s in ARP_STEPS]


# ---- Voice: additive formant synthesis. The glottal source is a harmonic series with spectral
# tilt; each harmonic is weighted by the vocal-tract envelope (5 formant resonators) evaluated at
# that harmonic's instantaneous frequency, so vowel glides and pitch glides stay coherent.
# Soprano formant table (Hz, dB, bandwidth Hz), the classic Csound/Peterson values.

SOPRANO = {
    "a": [(800, 0, 80), (1150, -6, 90), (2900, -32, 120), (3900, -20, 130), (4950, -50, 140)],
    "e": [(350, 0, 60), (2000, -20, 100), (2800, -15, 120), (3600, -40, 150), (4950, -56, 200)],
    "i": [(270, 0, 60), (2140, -12, 90), (2950, -26, 100), (3900, -26, 120), (4950, -44, 120)],
    "o": [(450, 0, 70), (800, -11, 80), (2830, -22, 100), (3800, -22, 130), (4950, -50, 135)],
    "u": [(325, 0, 50), (700, -16, 60), (2700, -35, 170), (3800, -40, 180), (4950, -60, 200)],
}
CR = 1000  # control rate for pitch/formant trajectories


def unit_noise(r: np.random.Generator, n: int, cutoff: float) -> np.ndarray:
    """Slow random wobble: lowpassed noise scaled to unit standard deviation."""
    x = fft_filter(r.standard_normal(n), lp(cutoff))
    return x / np.std(x)


def trajectory(keys: list[tuple[float, np.ndarray]], seconds: float, glide: float) -> np.ndarray:
    """Hold each key value until `glide` before the next key, ramp, then smooth. Returns control
    samples at CR with the value arrays stacked on axis 0."""
    pts_t = [keys[0][0]]
    pts_v = [keys[0][1]]
    for (_, v0), (t1, v1) in zip(keys, keys[1:]):
        pts_t += [t1 - glide, t1]
        pts_v += [v0, v1]
    tc = np.arange(0, seconds, 1 / CR)
    vals = np.array(pts_v).reshape(len(pts_v), -1)
    ctrl = np.stack([np.interp(tc, pts_t, vals[:, j]) for j in range(vals.shape[1])])
    kernel = np.hanning(31)
    kernel /= kernel.sum()
    padded = np.pad(ctrl, ((0, 0), (15, 15)), mode="edge")
    return np.stack([np.convolve(row, kernel, mode="valid") for row in padded])


def to_audio(ctrl: np.ndarray, seconds: float) -> np.ndarray:
    tc = np.arange(ctrl.shape[-1]) / CR
    t = t_axis(seconds)
    return np.stack([np.interp(t, tc, row) for row in ctrl])


def tract(f: np.ndarray, fmt: np.ndarray) -> np.ndarray:
    """Vocal-tract gain at frequencies f given formants fmt (15, ...) = 5 x (freq, dB, bw)."""
    F, L, B = fmt[0::3], 10 ** (fmt[1::3] / 20), fmt[2::3]
    return np.sum(L * F * B / np.sqrt((F**2 - f**2) ** 2 + (f * B) ** 2), axis=0)


def voice(phrase: list[tuple[float, str, str]], seconds: float, seed: str, cents: float) -> np.ndarray:
    """phrase = [(time, note, vowel)]: sung vowel glides with scoop, vibrato, jitter and breath."""
    r = rng_for(seed)
    t = t_axis(seconds)
    pitch_keys = [(tk, np.array([np.log2(hz(n))])) for tk, n, _ in phrase]
    vowel_keys = [(tk, np.array(SOPRANO[v], float).ravel()) for tk, _, v in phrase]
    logf = to_audio(trajectory(pitch_keys, seconds, 0.07), seconds)[0]
    fmt_ctrl = trajectory(vowel_keys, seconds, 0.09)
    fmt = to_audio(fmt_ctrl, seconds)

    scoop = -0.05 * np.exp(-t / 0.05)  # start ~60 cents flat and slide up, like a singer does
    vib_depth = 0.026 * smoothstep((t - 0.16) / 0.3)  # ~30 cents, entering after the onset
    vib_rate = 5.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t + r.uniform(0, 6.3))
    vib = vib_depth * np.sin(2 * np.pi * np.cumsum(vib_rate) / SR)
    jitter = unit_noise(r, len(t), 12) * 0.004  # ~5 cents of slow pitch drift
    f0 = 2 ** (logf + scoop + vib + jitter + cents / 1200)
    phase = 2 * np.pi * np.cumsum(f0) / SR

    voiced = np.zeros(len(t))
    for k in range(1, int(15000 / f0.min()) + 2):
        fk = k * f0
        # Taper, not a hard cut: a harmonic toggling at 15 kHz under vibrato clicks.
        voiced += k**-1.1 * tract(fk, fmt) * np.clip((15000 - fk) / 3000, 0, 1) * np.sin(k * phase)
    shimmer = 1 + 0.04 * unit_noise(r, len(t), 30)  # ~4% amplitude wobble
    voiced *= shimmer

    frame_fmt = lambda tt: np.stack(  # noqa: E731
        [np.interp(tt[:, 0], np.arange(fmt_ctrl.shape[1]) / CR, row) for row in fmt_ctrl]
    )[:, :, None]
    air = lambda f, tt: tract(f, frame_fmt(tt)) * hp(1200)(f)  # noqa: E731
    breath = tv_filter(r.standard_normal(len(t)), air)
    breath /= np.max(np.abs(breath))
    voiced /= np.max(np.abs(voiced))

    onset = np.clip((t - 0.035) / 0.03, 0, 1)  # an aspirated "h" leads the voice by 35 ms
    breath_env = 0.45 * np.exp(-t / 0.05) + 0.08
    release = np.clip((seconds - t) / 0.18, 0, 1) ** 1.5
    return (voiced * onset + breath * breath_env) * release * np.minimum(1, t / 0.004)


CHOP_PHRASES = [  # (phrase, seconds, octave-down weight); index i sings from seeds "vox-{i}*"
    ([(0.0, "B4", "o"), (0.38, "D5", "a")], 1.0, 0.0),  # "oh-ah"
    # "ay-oh"
    ([(0.0, "A4", "e"), (0.16, "A4", "i"), (0.42, "F#4", "o"), (0.8, "F#4", "u")], 1.05, 0.0),
    ([(0.0, "D5", "o"), (0.22, "F#5", "a"), (0.62, "D5", "e"), (0.76, "D5", "i")], 1.0, 0.15),
    ([(0.0, "F#5", "e"), (0.14, "F#5", "i"), (0.4, "D5", "o"), (0.8, "D5", "u")], 1.1, 0.15),
]


def lower_octave(phrase):
    return [(tk, n[:-1] + str(int(n[-1]) - 1), v) for tk, n, v in phrase]


@cache
def chop(i: int) -> np.ndarray:
    """A chop is a sample: lead + detuned double + octave-down, rendered once, placed many times."""
    phrase, seconds, low = CHOP_PHRASES[i]
    lead = voice(phrase, seconds, f"vox-{i}", 0.0)
    double = voice(phrase, seconds, f"vox-{i}-double", 9.0)
    octave = voice(lower_octave(phrase), seconds, f"vox-{i}-low", -4.0)
    return panned(lead, 0) + 0.45 * panned(double, 0.35) + low * panned(octave, -0.25)


# ---- Effects


def ping_pong(x: np.ndarray, delay: float, feedback: float, taps: int = 10) -> np.ndarray:
    """Mono in, stereo out: echoes alternate L, R, L... each one darker and thinner than the last."""
    n = x.shape[-1]
    nfft = 1 << int(np.ceil(np.log2(n + taps * delay * SR + SR)))
    f = np.fft.rfftfreq(nfft, 1 / SR)
    X = np.fft.rfft(x, nfft)
    colour = lp(5000)(f) * hp(300)(f)
    echo = [feedback**n * colour**n * np.exp(-2j * np.pi * f * n * delay) for n in range(1, taps + 1)]
    left = sum(echo[0::2])
    right = sum(echo[1::2])
    return np.stack([np.fft.irfft(X * left, nfft)[:n], np.fft.irfft(X * right, nfft)[:n]])


def reverb(x: np.ndarray, rt60: float, seed: str, predelay: float = 0.02) -> np.ndarray:
    """Convolution with decorrelated stereo decaying noise; highs die ~2.5x faster than lows."""
    r = rng_for(seed)
    t = t_axis(rt60 * 1.2)
    noise = r.standard_normal((2, len(t)))
    low = fft_filter(noise, lp(2500))
    ir = low * 10 ** (-3 * t / rt60) + (noise - low) * 10 ** (-3 * t / (0.4 * rt60))
    ir *= np.minimum(1, t / 0.008)
    ir /= np.sqrt(np.sum(ir**2, axis=1, keepdims=True))
    ir = np.pad(ir, ((0, 0), (round(predelay * SR), 0)))
    n = x.shape[-1]
    nfft = 1 << int(np.ceil(np.log2(n + ir.shape[1])))
    mono = np.fft.rfft(x.sum(axis=0) / 2, nfft)
    return np.fft.irfft(mono[None, :] * np.fft.rfft(ir, nfft), nfft)[:, :n]


def soft_clip(x: np.ndarray, drive: float) -> np.ndarray:
    return np.tanh(drive * x) / drive


# ---- Arrangement: a cue is a table of sections, 1-based bars, contiguous. One dataclass per kind.


@dataclass(frozen=True)
class Build:  # the 4-bar build and gap; fixed at bars 1-4 (DROP, GAP and the locked cut rely on it)
    first: int
    last: int


@dataclass(frozen=True)
class Drop:  # impact + crash + big kick + chop, then a groove bar
    bar: int

    first = last = property(lambda self: self.bar)


@dataclass(frozen=True)
class Groove:  # the drop groove, progression cycling by bar number
    first: int
    last: int
    crashes: tuple[int, ...]  # bars with a quiet crash on the downbeat
    chops: tuple[tuple[int, int, float], ...]  # (bar, CHOP_PHRASES index, gain)


@dataclass(frozen=True)
class Hit:  # impact + full crash on the downbeat, then a groove bar
    bar: int

    first = last = property(lambda self: self.bar)


@dataclass(frozen=True)
class Breakdown:  # no drums or bass; riser + snare roll over the last 2 beats into what follows
    first: int
    last: int
    chords: tuple[str, ...]  # one CHORDS name per bar
    chop: int  # CHOP_PHRASES index, drenched in echo on the first bar


@dataclass(frozen=True)
class End:  # impact + crash + one ringing D-major chord; the file ends `ring` s after the downbeat
    bar: int
    ring: float
    fade: float  # master fade over the last `fade` s, on a squared curve

    first = last = property(lambda self: self.bar)


@dataclass(frozen=True)
class Coda:  # the quiet close: breakdown texture with no lead-in, then one soft ringing D chord
    first: int
    last: int  # the bar the final chord is struck on
    chords: tuple[str, ...]  # one CHORDS name per bar before `last`
    chop: int  # CHOP_PHRASES index, drenched in echo on the first bar
    ring: float  # the file ends `ring` s after the final chord
    fade: float  # master fade over the last `fade` s, on a squared curve


Section = Build | Drop | Groove | Hit | Breakdown | End | Coda

BUILD_CUE = [
    Build(1, 4),
    Drop(5),
    Groove(6, 8, crashes=(7,), chops=((7, 3, 0.75),)),
]

FULL_CUE = [  # script v2 (2026-09-30): every scene is one 4-bar phrase; a crash marks each start
    Build(1, 4),  # the four benefits, one per bar, over the marimba handoff
    Drop(5),  # "Ask your agents"
    Groove(
        6,
        28,
        crashes=(9, 13, 17, 21, 25),  # show their work (2 phrases), any harness, swarms, you own it
        chops=((9, 3, 0.55), (13, 2, 0.55), (17, 3, 0.55), (21, 2, 0.55), (25, 3, 0.55)),
    ),
    # Owner, 2026-09-30: the Vim line's breakdown "adds tension", but the beat coming back for a
    # recap hit read as weird; close quiet and dramatic instead. A -> D resolves on the end card.
    Coda(29, 33, chords=("Bm", "G", "D", "A"), chop=0, ring=6.0, fade=4.0),
]

CUT_FADE = 0.015  # a cue that ends mid-groove is cut with a 15 ms linear fade
ENDINGS = {  # last section -> (cue length, master fade seconds, fade curve exponent)
    Groove: lambda s: (at(s.last + 1), CUT_FADE, 1),
    # Squared: a linear fade left the reverb/echo tail at -56 dBFS in the last 0.1 s.
    End: lambda s: (at(s.bar) + s.ring, s.fade, 2),
    Coda: lambda s: (at(s.last) + s.ring, s.fade, 2),
}


def checked(cue: list[Section]) -> list[Section]:
    assert cue[0] == Build(1, 4), "the build is bars 1-4: the drop must land at 7.5 s"
    for a, b in zip(cue, cue[1:]):
        assert b.first == a.last + 1, f"{b} does not follow {a}"
    assert type(cue[-1]) in ENDINGS, f"a cue ends on {' or '.join(k.__name__ for k in ENDINGS)}"
    for s in cue:
        assert type(s) is not Breakdown or len(s.chords) == s.last - s.first + 1, s
        assert type(s) is not Coda or len(s.chords) == s.last - s.first, s
    return cue


# ---- Mix: one bus per element. Buses are summed in a fixed order at mixdown, so the float
# summation order (hence every output sample) is the same however sections interleave. That is
# what keeps edm-build.wav sample-identical to the pre-table script, which summed element by
# element.

BUSES = ("kick", "roll", "open-hat", "closed-hat", "clap", "riser", "crash", "impact", "swell",
         "arp", "bass", "vox", "vox-drench")  # fmt: skip

CHORD_TREATMENTS = {  # bus -> (filter, sidechain depth)
    # Build filter: 24 dB/oct resonant lowpass opening from 400 Hz to 18 kHz across bars 1-4.
    "build": (lambda x: fft_filter(tv_filter(x, build_sweep), hp(170)), 0.3),
    "groove": (lambda x: fft_filter(x, lambda f: lp(11000)(f) * hp(170)(f)), 0.72),
    "breakdown": (lambda x: fft_filter(x, lambda f: lp(1200)(f) * hp(170)(f)), 0.35),
    "end": (lambda x: fft_filter(x, lambda f: lp(11000)(f) * hp(170)(f)), 0.0),
}


def build_sweep(f, tt):
    cutoff = 400 * (18000 / 400) ** (np.clip(tt / GAP, 0, 1) ** 1.4)
    return lp(cutoff, 1.3)(f) ** 2


@dataclass(frozen=True)
class Kit:
    """One-shots rendered once per cue, drawn from each element's seed in a fixed order."""

    k_build: np.ndarray
    k_bar1: np.ndarray
    k_drop: np.ndarray
    k_first: np.ndarray
    open_hat: np.ndarray
    closed_hat: np.ndarray
    clap: np.ndarray
    impact: np.ndarray


def make_kit() -> Kit:
    r = rng_for("kick")
    k_build = kick(r)
    k_bar1 = fft_filter(k_build, lp(260, 0.9))  # bar 1: half-time and muffled, as if behind a wall
    k_drop = kick(r, seconds=0.36, decay=0.15)  # shorter tail: the off-beat bass needs the room
    k_first = kick(r, seconds=0.9, f_top=190, f_bottom=42, decay=0.38, click=0.5)
    r = rng_for("hats")
    open_hat, closed_hat = hat(r, 0.07), hat(r, 0.018)
    return Kit(
        *(panned(k, 0) for k in (k_build, k_bar1, k_drop, k_first)),
        panned(open_hat, 0.2),
        panned(closed_hat, -0.3),
        clap(rng_for("clap")),
        panned(impact(rng_for("impact")), 0),
    )


class Seeds(dict):
    """element -> its generator, shared across sections, so e.g. the chords draw bar 1, 2, 3... in
    order. That is why the full cue's bars 1-5 are the build's bars 1-5."""

    def __missing__(self, element: str) -> np.random.Generator:
        self[element] = rng_for(element)
        return self[element]


class Mix:
    def __init__(self, length: float):
        self.length = length
        self.n = round(length * SR)
        self.time = np.arange(self.n) / SR
        self.bus = {name: np.zeros((2, self.n)) for name in BUSES}
        self.chords = {name: np.zeros((2, self.n)) for name in CHORD_TREATMENTS}
        self.pulses = {name: [] for name in CHORD_TREATMENTS}  # sidechain triggers per chord bus
        self.kit = make_kit()
        self.rng = Seeds()

    def add(self, bus: str, x: np.ndarray, t0: float, gain: float = 1.0) -> None:
        place(self.bus[bus], x, t0, gain)

    def add_chord(self, treatment: str, x: np.ndarray, t0: float, pulses: list[float]) -> None:
        place(self.chords[treatment], x, t0)
        self.pulses[treatment] += pulses


# ---- Section builders: one per kind, each writing its events into the mix.

BUILD_KICKS = [at(1, 0), at(1, 2)] + [at(b, k) for b in (2, 3, 4) for k in range(4)]


def snare_hit(mix: Mix, tk: float, u: float, i: int) -> None:
    """One roll hit; u in [0, 1] is how far into the roll: rising pitch, band, level and spread."""
    r = mix.rng["snare"]
    hit = snare(r, tone=180 + 170 * u**1.5, band=1800 + 2800 * u, decay=0.09 - 0.05 * u)
    mix.add("roll", panned(hit, 0.15 * (-1) ** i * u), tk, 0.18 + 0.55 * u**1.6)


def arp_bar(mix: Mix, voicing: list[str], bar: int, start: str, gain: float, every: int = 1):
    """16ths climbing through chord tones; every=3 keeps a sparse dotted-8th pattern."""
    for s, f in list(enumerate(arp_notes(voicing, start)))[::every]:
        mix.add("arp", panned(pluck(f), 0.35 * (-1) ** s), at(bar, s / 4), gain)


def groove_bar(mix: Mix, bar: int, downbeat_kick: np.ndarray) -> None:
    kit = mix.kit
    kicks = [at(bar, k) for k in range(4)]
    for tk, k in zip(kicks, (downbeat_kick, kit.k_drop, kit.k_drop, kit.k_drop)):
        mix.add("kick", k, tk)
    for k in range(4):
        mix.add("open-hat", kit.open_hat, at(bar, k + 0.5), 0.26)
    for s in range(16):
        accent = 1.0 if s % 2 else 0.6
        mix.add("closed-hat", kit.closed_hat, at(bar, s / 4), 0.09 * accent * (s % 4 != 2))
    for k in (1, 3):
        mix.add("clap", kit.clap, at(bar, k), 0.5)
    voicing, root = harmony(bar)
    mix.add_chord("groove", chord_bar(voicing, mix.rng["chords"], 0.45), at(bar), kicks)
    for k in range(4):
        note = bass_note(hz(root), BEAT / 2, gate(BEAT / 2, 0.004, 0.03))
        mix.add("bass", note, at(bar, k + 0.5), 0.55)
    arp_bar(mix, voicing, bar, "D5", 0.3)


def build_section(s: Build, mix: Mix) -> None:
    kit = mix.kit
    mix.add("kick", kit.k_bar1, at(1, 0), 0.5)
    mix.add("kick", kit.k_bar1, at(1, 2), 0.5)
    for tk in BUILD_KICKS[2:]:
        mix.add("kick", kit.k_build, tk, 0.55 + 0.15 * tk / GAP)
    # Snare roll: quarters (bar 1) -> 8ths -> 16ths -> 32nds (bar 4).
    for bar, per_beat in ((1, 1), (2, 2), (3, 4), (4, 8)):
        for i in range(4 * per_beat):
            tk = at(bar, i / per_beat)
            snare_hit(mix, tk, tk / GAP, i)
    for bar in range(1, 5):
        for k in range(4):
            mix.add("open-hat", kit.open_hat, at(bar, k + 0.5), 0.1 + 0.12 * (bar - 1) / 3)
    mix.add("riser", fft_filter(riser(mix.rng["riser"], GAP - at(3)), lp(9000)), at(3), 0.3)
    for bar, start in zip(range(1, 5), ("B3", "D4", "A4", "E5")):
        voicing = harmony(bar)[0]
        mix.add_chord("build", chord_bar(voicing, mix.rng["chords"], 0.0), at(bar), [])
        arp_bar(mix, voicing, bar, start, 0.3 + 0.35 * (bar - 1) / 3)
    mix.pulses["build"] += BUILD_KICKS
    mix.add("vox", chop(0), at(1), 0.5)
    mix.add("vox", chop(1), at(3), 0.6)
    # Reversed crash: swells from nothing to its peak exactly on the drop. Its own bus is added
    # after the dry mask, so it plays through the gap.
    swell = crash(rng_for("reverse-crash"), seconds=0.6)[:, ::-1]
    swell = fft_filter(swell, lp(9000)) * np.linspace(0, 1, swell.shape[1]) ** 2
    mix.add("swell", swell, DROP - swell.shape[1] / SR, 0.3)


def drop_section(s: Drop, mix: Mix) -> None:
    groove_bar(mix, s.bar, mix.kit.k_first)
    mix.add("crash", crash(mix.rng["crash"]), at(s.bar), 0.42)
    mix.add("impact", mix.kit.impact, at(s.bar), 0.85)
    mix.add("vox", chop(2), at(s.bar), 1.0)


def groove_section(s: Groove, mix: Mix) -> None:
    for bar in range(s.first, s.last + 1):
        groove_bar(mix, bar, mix.kit.k_drop)
    for bar in s.crashes:
        mix.add("crash", crash(mix.rng["crash"]), at(bar), 0.22)
    for bar, phrase, gain in s.chops:
        mix.add("vox", chop(phrase), at(bar), gain)


def hit_section(s: Hit, mix: Mix) -> None:
    groove_bar(mix, s.bar, mix.kit.k_drop)
    mix.add("crash", crash(mix.rng["crash"]), at(s.bar), 0.42)
    mix.add("impact", mix.kit.impact, at(s.bar), 0.85)


def breakdown_bars(mix: Mix, first: int, chords: tuple[str, ...], chop_index: int) -> None:
    """No drums or bass: lowpassed chords, a sparse arp, one chop drenched in echo."""
    for bar, name in zip(range(first, first + len(chords)), chords):
        voicing = CHORDS[name][0]
        # Ghost sidechain on the quarters: no kick, but the chords still breathe.
        quarters = [at(bar, k) for k in range(4)]
        mix.add_chord("breakdown", chord_bar(voicing, mix.rng["chords"], 0.0), at(bar), quarters)
        arp_bar(mix, voicing, bar, "D5", 0.22, every=3)
    mix.add("vox-drench", chop(chop_index), at(first), 0.7)


def breakdown_section(s: Breakdown, mix: Mix) -> None:
    breakdown_bars(mix, s.first, s.chords, s.chop)
    # Lead-in over the last 2 beats: riser, and a snare roll in 16ths then 32nds.
    t0 = at(s.last, 2)
    mix.add("riser", fft_filter(riser(mix.rng["riser"], 2 * BEAT), lp(9000)), t0, 0.3)
    beats = [2 + i / 4 for i in range(4)] + [3 + i / 8 for i in range(8)]
    for i, b in enumerate(beats):
        tk = at(s.last, b)
        snare_hit(mix, tk, 0.6 + 0.4 * (tk - t0) / (2 * BEAT), i)


def end_section(s: End, mix: Mix) -> None:
    t0 = at(s.bar)
    mix.add("crash", crash(mix.rng["crash"]), t0, 0.42)
    mix.add("impact", mix.kit.impact, t0, 0.85)
    mix.add_chord("end", ring_chord(END_VOICING, mix.rng["chords"], s.ring), t0, [])
    t = t_axis(s.ring)
    low_d = bass_note(hz("D2"), s.ring, np.minimum(1, t / 0.004) * np.exp(-t / 0.9))
    mix.add("bass", low_d, t0, 0.6)
    for i, note in enumerate(("D5", "F#5", "A5", "D6")):  # a quick strummed pluck on top
        mix.add("arp", panned(pluck(hz(note), 0.6), 0.35 * (-1) ** i), t0 + 0.025 * i, 0.35)


def coda_section(s: Coda, mix: Mix) -> None:
    breakdown_bars(mix, s.first, s.chords, s.chop)
    t0 = at(s.last)
    # A breath in, not a riser: the build's reversed crash, quiet and dark, peaking on the chord.
    swell = crash(rng_for("coda-swell"), seconds=1.2)[:, ::-1]
    swell = fft_filter(swell, lp(4000)) * np.linspace(0, 1, swell.shape[1]) ** 2
    mix.add("swell", swell, t0 - swell.shape[1] / SR, 0.18)
    # The final chord: soft, no impact or crash; one low boom under it.
    mix.add_chord("end", ring_chord(END_VOICING, mix.rng["chords"], s.ring) * 0.5, t0, [])
    t = t_axis(s.ring)
    mix.add("bass", bass_note(hz("D2"), s.ring, np.minimum(1, t / 0.004) * np.exp(-t / 1.4)), t0, 0.45)
    mix.add("kick", fft_filter(mix.kit.k_first, lp(180)), t0, 0.35)


BUILDERS = {
    Build: build_section,
    Drop: drop_section,
    Groove: groove_section,
    Hit: hit_section,
    Breakdown: breakdown_section,
    End: end_section,
    Coda: coda_section,
}


# ---- Mixdown

# Dry mask: everything dry fades out over 40 ms at GAP and resumes on the drop.
# Owner, rough cut 1 (2026-09-26): the transition into the drop was "a bit rough". Then the
# fade was 5 ms and every tail died within 80 ms, so the whole mix fell off a cliff into dead
# air. Now the dry cut is a short fade, the rooms ring out (180 ms), and a reversed crash
# swells through the gap into the downbeat, so the silence reads as a breath, not a dropout.
GAP_FADE = 0.04


def dry_mask(time: np.ndarray) -> np.ndarray:
    return np.where(time >= DROP, 1.0, np.clip(1 - (time - GAP) / GAP_FADE, 0, 1))


def gap_tail(time: np.ndarray) -> np.ndarray:
    in_gap = (time >= GAP) & (time < DROP)
    return np.where(in_gap, np.exp(-(time - GAP) / 0.18), 1.0)


def build_swell(time: np.ndarray) -> np.ndarray:
    """The build rises from -10 dB to -3 dB at the gap, so the drop is the peak."""
    return 10 ** ((-10 + 7 * np.clip(time / GAP, 0, 1) ** 1.2) / 20)


def mixdown(mix: Mix) -> dict[str, np.ndarray]:
    b, dry, tail = mix.bus, dry_mask(mix.time), gap_tail(mix.time)

    # DRUMS (+ FX)
    roll = fft_filter(b["roll"], lp(10000))  # bright but not fizzy
    drums = b["kick"] + roll * dry
    for name in ("open-hat", "closed-hat", "clap", "riser", "crash", "impact"):
        drums += b[name]
    drums *= dry
    drums += b["swell"]
    drums += reverb(roll * dry, 1.4, "drum-room", 0.01) * 0.28 * tail
    drums = soft_clip(drums, 1.3)

    # MUSIC: chords, arp, bass
    chords = {name: f(mix.chords[name]) for name, (f, _) in CHORD_TREATMENTS.items()}
    ref = chords["groove"][:, round(DROP * SR) : round((DROP + 4 * BAR) * SR)]  # the drop phrase
    level = 1 / np.sqrt(np.mean(ref**2))
    pumped = sum(
        chords[name] * pump(mix.n, depth, mix.pulses[name])
        for name, (_, depth) in CHORD_TREATMENTS.items()
    )
    arp = b["arp"] * dry
    music_dry = (pumped * level * 0.16 + arp * 0.32) * build_swell(mix.time) * dry + b["bass"]
    music = music_dry + reverb(music_dry, 1.8, "music-hall") * 0.18 * tail
    music += ping_pong(arp.sum(axis=0) / 2 * 0.32, 0.75 * BEAT, 0.35) * 0.35 * tail
    music = soft_clip(music, 1.1)

    # VOX: formant chops, ping-pong dotted-1/8 delay, reverb; the drenched bus is mostly echo.
    band = lambda f: hp(220)(f) * lp(12000)(f)  # noqa: E731
    vox_dry = fft_filter(b["vox"], band)
    vox = vox_dry * 0.68
    vox += ping_pong(vox_dry.sum(axis=0) / 2, 0.75 * BEAT, 0.45) * 0.62
    vox += reverb(vox_dry, 2.4, "vox-plate", 0.03) * 0.34
    drench = fft_filter(b["vox-drench"], band)
    vox += drench * 0.3
    vox += ping_pong(drench.sum(axis=0) / 2, 0.75 * BEAT, 0.62, taps=16) * 0.9
    vox += reverb(drench, 2.4, "vox-plate", 0.03) * 0.5
    return {"drums": drums, "music": music, "vox": vox}


# ---- Master


def limiter_gain(mix: np.ndarray, drive: float, block: int = 32, release: float = 0.09) -> np.ndarray:
    """Look-ahead peak limiter as a gain envelope (instant attack one block early, smooth
    release). Returned as a gain curve so the same curve can be applied to every stem."""
    n = mix.shape[1]
    peak = np.abs(mix * drive).max(axis=0)
    nb = -(-n // block)
    blocks = np.pad(peak, (0, nb * block - n)).reshape(nb, block).max(axis=1)
    ahead = np.maximum.reduce([np.roll(blocks, -s) for s in (-1, 0, 1, 2)])
    target = np.minimum(1.0, 1.0 / ahead)
    a = np.exp(-block / (release * SR))
    g = np.empty(nb)
    acc = 1.0
    for i, v in enumerate(target):
        acc = min(v, v + a * (acc - v))
        g[i] = acc
    centres = (np.arange(nb) + 0.5) * block
    return drive * np.interp(np.arange(n), centres, g)


def render(cue: list[Section]) -> dict[str, np.ndarray]:
    """Mastered, peak -1 dBFS: {"mix": ..., "drums": ..., "music": ..., "vox": ...}."""
    length, fade, curve = ENDINGS[type(cue[-1])](cue[-1])
    mix = Mix(length)
    for section in checked(cue):
        BUILDERS[type(section)](section, mix)
    stems = mixdown(mix)
    peak_mix = sum(stems.values())
    top = np.max(np.abs(peak_mix))
    gain = limiter_gain(peak_mix / top, drive=10 ** (7 / 20)) / top
    tail = np.clip((length - mix.time) / fade, 0, 1) ** curve
    stems = {name: x * gain * tail for name, x in stems.items()}
    out = sum(stems.values())
    scale = PEAK / np.max(np.abs(out))
    return {"mix": out * scale} | {name: x * scale for name, x in stems.items()}


def write(name: str, x: np.ndarray) -> None:
    pcm = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.T.reshape(-1).tobytes())
    peak_db = 20 * np.log10(np.max(np.abs(x)))
    print(f"{name}.wav  {x.shape[1] / SR:.3f}s  peak {peak_db:+.2f} dBFS")


def write_cue(cue: list[Section], name: str, stem_prefix: str) -> None:
    for s in cue:
        print(f"  {type(s).__name__:9s} bars {s.first:2d}-{s.last:2d}  {at(s.first):7.3f} s")
    out = render(cue)
    write(name, out.pop("mix"))
    for stem, x in out.items():
        write(f"{stem_prefix}-{stem}", x)


if __name__ == "__main__":  # calm.py imports the instruments without re-rendering these
    write_cue(BUILD_CUE, "edm-build", "edm-stem")
    write_cue(FULL_CUE, "edm-full", "edm-full-stem")

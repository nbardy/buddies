"""The launch song: edm.py's build under "AI Overload" and the robots, the drop on the Buddies logo.

Run:  uv run --with numpy python product/releases/launch-2.0/sound/launch.py

Owner, 2026-10-05: the reveal songs (reveal.py: robots' boops as the melody) read as "a weird boring
jingle"; the reveal should be "a way more exciting announcement / launch". The build the owner liked
on 2026-09-26 (edm.py bars 1-4) now starts on the cut to "AI Overload", the robots pop in during its
second bar, they gather in the fourth, and the drop (bar 5, 7.5 s) is the logo lock. The song then
runs under the whole video. Cue bar b is Assembly bar b - 4 (Assembly's bar 1 is the lock):

  bars  1-4    0.000  BUILD   "AI Overload." / robots pop (bar 2) / "covered" (3) / gather (4)
  bar   5      7.500  DROP    the logo locks, "buddies" lands
  bars  6-36   9.375  GROOVE  home (6), benefits (9), ask (13), show their work (17), harness (25),
                              swarms (29), fork (33): a crash and a chop on each scene's downbeat
  bars 37-41  67.500  CODA    the Vim line, then one soft D chord on the end card (bar 41)

Writes launch.wav (the mix, peak -1 dBFS) and launch-stem-{drums,music,vox}.wav, which sum to it.
"""

from edm import Build, Coda, Drop, Groove, write_cue

SCENES = (9, 13, 17, 25, 29, 33)
LAUNCH_CUE = [
    Build(1, 4),
    Drop(5),
    Groove(6, 36, crashes=SCENES, chops=tuple((bar, 3 - i % 2, 0.55) for i, bar in enumerate(SCENES))),
    Coda(37, 41, chords=("Bm", "G", "D", "A"), chop=0, ring=6.0, fade=4.0),
]

if __name__ == "__main__":
    write_cue(LAUNCH_CUE, "launch", "launch-stem")

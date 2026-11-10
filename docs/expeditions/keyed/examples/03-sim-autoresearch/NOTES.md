# API gaps still open in this example

Nothing in `api/expedition.d.ts` was changed. Each item says what the case needed and what the
plan does instead.

## 1. The pilot's verdict is the trial's result, and in a search most trials are a "no"

Needed: `wide` over the ideas of a generation, where the pilot proves the pipeline (the candidate
builds, the harness runs, Modal answers) before the rest are paid for. In a population search the
first idea being slower than the baseline is an ordinary outcome and must not stop the others.

`wide` refuses the rest whenever the pilot's result did not pass, and `gate` is written to fail
on a slow candidate so that the host records `reject` for it. So the callback returns the
`implement` result when the gate ran and said no, and the gate result otherwise:
`return scored.t === 'failed' ? built : scored`. That works, but the trial's result is no longer
the trial's outcome, and winners are collected by `keep.push(...)` inside the callback instead of
from `passed(trials)`. One case is still wrong: if the pilot idea itself is invalid (its tests or
the local matched-error screen fail), the whole generation is refused, although the pipeline is fine.

## 2. A staged judgment writes `keep` at the first stage

Needed: one learning row per idea, written when the deciding measurement exists. `tests` must be
on `implement` so that the dry run can refuse a rejected family before any spend, and on `gate`
so that the Modal number decides. The host writes a row for each judged call that carries
`tests`: `implement` passing writes `keep` (meaning only "valid at matched error on the local
screen") and `gate` then writes the real `keep` or `reject`. The log has two rows per idea, told
apart by `from`. There is also no way for a host-written row to say `retune`.

## 3. "Idle host" is not a pool

Local timing wants an idle machine, not only a free GPU. `gpu: { slots: 1, scope: machine }`
serialises GPU runs, but agent seats keep the CPU busy during a local run. The plan therefore
uses the M4 only to check matched error, and takes every speed number from Modal.

## Changed after this was written

`wide` no longer stops the rest when the pilot's judge says no; only an errored or refused pilot
does. The gap above about a failed pilot refusing the rest is closed. The plan still uses its
workaround and could now use `wide` directly.

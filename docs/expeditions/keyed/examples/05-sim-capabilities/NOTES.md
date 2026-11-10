# API gaps still open in this example

Nothing in `api/expedition.d.ts` was changed. Each item says what the case needed and what the
plan does instead.

## 1. A counted pool cannot be per item ("two strikes per row")

Needed: each row has its own budget of two paid scoring runs, enforced by the host at the moment
of spending. `.needs(...)` takes fixed pool names on the cast-table row; `{{slots}}` fill commands
and briefs, not pool names, so there is no `strikes/{{row}}`.

Written instead: one shared pool `strikes: { uses: 6 }` (two per row, three rows) plus a
`for (const round of [1, 2])` loop in the plan. The host enforces the total of six. The per-row
limit of two is plan code, so a rewrite could move strikes from one row to another without the
host objecting.

## 2. Stopping paid runs "pending an owner decision" is a rule, not a state

Needed: a row at two strikes becomes an owner question that, if answered "continue", grants that
row more strikes. `x.ask` can pose the question, but a pool's `uses` is in the Contract and only
the owner's edit of the Contract changes it; the plan cannot act on a "yes".

Written instead: the plan ends the row at two rounds and reports it in the landed matrix with the
decision needed. Raising `strikes` is a Contract change by the owner, followed by a rewrite.

## 3. `wide` does not fit work whose pilot costs as much as the rest

The open rows are independent and run in parallel, but each is a deep serial loop of hours, and a
row failing to close is an expected outcome. `wide` would run one whole row first and refuse the
others if it did not close. The rows therefore use `Promise.all`; `wide` is used only for the
baseline scoring, where the pilot is one cheap cell.

## 4. Parallel repairs cannot each land

`x.land` is fast-forward only and takes one commit. Three row repairs that start from the same
tip cannot all land, so the plan adds an `integrate` agent step that produces one commit, judged
by unit tests, and re-scores the whole matrix on it with a command. Until `matrix` returns, the
combined commit is `Verified` on unit tests alone; the plan lands only after the write-up that
reports the matrix has passed review.

## 5. A staged judgment writes `keep` at the first stage

`tests` is on `repair` (so the dry run can refuse a rejected family before the work) and on
`strike` (the paid score decides). The host writes a row for each: `repair` passing its unit
tests writes `keep` before any score exists, and `strike` then writes the real verdict. Two rows
per repair, told apart by `from`.

## Changed after this was written

`wide` no longer stops the rest when the pilot's judge says no; only an errored or refused pilot
does. The gap above about a failed pilot refusing the rest is closed. The plan still uses its
workaround and could now use `wide` directly.

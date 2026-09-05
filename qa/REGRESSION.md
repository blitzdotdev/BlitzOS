# Recurring Lody regression sweeps

Recurring sweeps test likely drift first and spread the remaining coverage over
time. They do not act as a CI gate.

## Select rows

Use the commit that last updated `qa/baseline.json` as the baseline source
revision. For each active row in `qa/MATRIX.md`, resolve the cited `V/`, `W/`,
`B/`, and `CP/` paths. Select every runnable row whose cited source changed
between that revision and the target commit.

Add a deterministic rotating slice of unchanged runnable rows. Derive the slice
from the row ID and run period so every row is selected over time. Give
`FIXED-UNVERIFIED`, prior `FAIL`, and prior `BLOCKED` rows priority when their
preconditions are now available.

Keep row IDs as the only join key between the matrix, baseline, run output,
issues, and later baseline updates. Do not renumber an ID. Move a dead row to
the matrix Retired section and remove it from the active baseline only in the
same review.

## Run and compare

Follow `qa/RUNBOOK.md` and use `qa/harness/lane-prompt.md` for each lane. Store
one current verdict and its evidence for every selected row.

Compare the current result only with `qa/baseline.json`. Do not compare it with
an uncommitted run, a chat summary, or the last transient observation.

A flip is one of these observed transitions:

- Baseline `PASS` to current `FAIL`.
- Baseline `FAIL` to current `PASS`.

Report `UNTESTED`, `FIXED-UNVERIFIED`, or `BLOCKED` becoming observed as a
coverage update, not as a flip. Keep environment blocks separate from product
results.

## Report and update

Open one GitHub issue for each flip. Put `QA flip: <row ID>` in the title. The
issue body must contain the baseline verdict, current verdict, baseline and
target commits, cited source changes, run ID, retry result, screenshot path,
DOM evidence, and adversarial check.

Update `qa/baseline.json` through a pull request after the sweep is reviewed.
Keep keys sorted by row ID. Update the run, date, and note with the accepted
evidence. Update affected matrix rows in the same pull request when the
expected behavior or source citation changed.

Do not add a workflow, required check, or QA gate for this process.

## Standing coverage gap

`HEADLESS+PROMPT` rows need Claude to be signed in on the QA box. A browser
session and box credential do not provide that sign-in. Record these rows as
`BLOCKED` until the lane has a signed-in Claude agent; keep them in the rotation.

# review-automation — Auto review and merge

Machine-side engine for "Auto review and merge": a review agent reads a branch,
blocking findings go back to the authoring session, and once nothing blocks and
CI is green the pull request is merged.

## Why this is not MCP orchestration

Two hard constraints, not preferences:

- `LODY_MAX_CHAIN_DEPTH = 5` (`packages/shared/src/session-orchestration.ts`) is
  fixed and explicitly non-configurable. A loop that can run several rounds
  cannot be built from MCP session calls — it dies at depth 5.
- `specs/session-orchestration.md`: "MCP observes only Lody-owned state. GitHub,
  CI, webhooks... are outside this contract." This loop is mostly a reaction to
  exactly those.

**Consequence:** stepping around the chain-depth guard is what makes the run's
own budgets load-bearing. They are the replacement safety mechanism. Do not
raise or bypass them without replacing the protection.

## Two modes, one engine

`ReviewRun.mode` is either `review_only` (the "Review this branch" action) or
`review_and_merge` (the checkbox). They are the SAME state machine: a one-shot
review is the full loop with one round and no authority, and it ends in the
terminal `reviewed` state as soon as the reviewer reports. Keep it that way —
the point is that the user learns one concept, and the low-stakes action is how
they meet the reviewer before handing it a branch.

A run whose session has no `SessionMeta.autoReview` is inert: `step()` returns
early. That is what makes unchecking the box stop a run wherever it is.

## Files

- `review-automation-plan.ts` — PURE policy. Every gate that can spend tokens,
  write to GitHub, or merge lives here. All states are "waiting for" states,
  which is what makes a pass safely repeatable: unchanged facts return `wait`
  rather than dispatching the same prompt twice.
- `review-automation-submit.ts` — PURE. Folds one reviewer submission into a
  run. Owns the convergence rules.
- `review-automation-store.ts` — reads/writes the workspace review Flock doc.
- `review-automation-engine.ts` — gathers facts, calls the planner, performs the
  action.
- `review-automation-github.ts` — `gh` access (facts, comment, merge).
- `review-automation-scheduler.ts` / `-workspace.ts` — coalesced passes and the
  document subscriptions.
- `create-review-automation.ts` — assembles the above; wired in `lody-fleet.ts`.

## Invariants

- **Auto-merge must NOT reuse `deriveSessionPullRequestReadiness`.** That helper
  treats an ABSENT CI rollup as ready, which is right for enabling a manual merge
  button and wrong here: right after a push no check suite has registered and `s`
  is undefined, so reusing it merges before CI ever runs. `evaluateAutoMerge`
  requires `s === 's'` explicitly. There is a regression test for this.
- **The no-CI exemption is time-earned, never immediate.** A repository with no
  CI shows `s` undefined forever, so `evaluateAutoMerge` accepts
  `ciAbsentConfirmed` — but only the engine may set it, via `trackCiAbsence`:
  one unchanged head must show no rollup for `NO_CI_GRACE_MS` (5 min, far past
  the check-suite registration race). The stamp map is engine-local, so a
  restart waits a fresh window — the safe direction. A pass waiting out the
  window gets no document events (nothing changes), so the engine arms
  `reevaluateLater` for the expiry. The exemption dies the moment CI reports
  anything: the planner only forwards it while `s` is still undefined.
- **`awaiting_confirmation` alongside transient blockers waits, not blocks.**
  The confirmation is requested only when it is the SOLE remaining blocker;
  mixed with `ci_not_green`/`merge_state_not_clean`/`no_pr` the planner returns
  `wait`. Blocking there reported a false terminal error on every first merge
  whose CI was slower than its review — and on every no-CI repository before
  the exemption existed.
- **`SessionMeta.autoReview` is human-written only.** The reviewer and the author
  both have MCP access to the session; an agent able to grant itself merge
  authority makes the whole gate decorative. Same rule as a Task's `agent`.
- **Restart resumes.** Unlike `task-automation/`, the first pass after a restart
  DOES act. That scheduler records a baseline so a restart cannot replay a
  backlog nobody started; here every run exists because a person ticked a box on
  that session, and the user was told the branch is being watched. Do not copy
  the baseline pattern over.
- **`REVIEW.md` is read from the BASE branch**, via `git show <baseRef>:REVIEW.md`
  in the prompt, and is in the default protected paths. Both halves matter: the
  file is ordinary repository content, so a branch that could rewrite the rules it
  is judged by — and then be merged automatically — would be approving itself.
- **A later round may not raise new suggestions.** Enforced in
  `applyReviewSubmission`, not only in the prompt. Without it the reviewer always
  spends the whole budget: the author fixes what was listed, the reviewer lists
  new things, and neither side is wrong.
- **A dispute ends the loop.** Two agents arguing is the expensive failure mode;
  it escalates to a human instead.
- **The reviewer runs read-only** (`ACP_PLAN_PERMISSION_MODE_ID`) and never posts
  to GitHub itself — the engine posts. That also means Lody can never contribute
  to `reviewDecision`, which the human-review gate reads: the engine writes an
  issue COMMENT, never a review. `LODY_REVIEW_COMMENT_MARKER` is for humans
  reading the thread, not for that gate.
- **The human-review gate reads `reviewDecision`**, not a comment count. Plain
  comments are conversation; `CHANGES_REQUESTED` is where a person said no.
- **`approvedSha` stamping is a DISJUNCTION, and all three neighbouring rules
  have shipped as bugs.** `resolveApprovedShaPatch` is exported and unit-tested
  for exactly this reason. The rule is: a fresh approval (`isFreshApproval`)
  re-stamps, OR an approval with no sha recorded yet stamps the first head that
  becomes known.
  - Stamp only when unset → stale sha. After a CI-fix push the check compares
    old-vs-new forever: spot check → approve → still unequal → spot check. That
    loop consumes no budget and never throws, so nothing stops it.
  - Stamp unconditionally → pins a head the reviewer never judged, silently
    retiring the check.
  - Stamp only on a fresh approval → dead in the approve-then-open-PR order,
    which is the PRIMARY flow. The approval predates the PR, so there is no head
    to record; by the time one exists the state has left `reviewing` for good and
    `approvedSha` stays unset for the whole run, so any later push merges
    unreviewed.
- **The fix prompt must say PUSH when a pull request exists.** The reviewer
  re-checks the local working copy while the merge gate reads the PR head from
  GitHub; a committed-but-unpushed fix therefore passes review and then merges a
  head without it. (Residual gap: nothing yet asserts local HEAD == PR head.)
- **Every gated state needs a reachable exit.** Several deadlocks have been
  shipped and fixed here, most with the same shape — a gate whose only satisfier
  was downstream of the gate. `creating_pr` and `merging` additionally use
  `stateAgeMs` grace windows: PR association arrives out-of-band (webhook or the
  poller's discovery lane), so a turn ending without one is not yet an error, and
  a crash mid-merge must be re-evaluated rather than parked:
  - `awaiting_merge_confirmation` is satisfied by the per-run `mergeConfirmed`
    flag the banner writes, NOT by the policy's `mergeConfirmedOnce` (whose only
    writer is the merge it gates). The grant relaxes only the confirmation
    blocker; every other merge gate still applies.
  - `paused` is left only by the banner's Resume, which restores `pausedFrom`
    AND re-seeds `lastEngineTurnId`. Without the re-seed it re-pauses on the very
    next pass, because the pause condition is that marker not matching.
  When adding a state, ask what writes the thing that lets it leave.
- **Human input pauses the run**, and it outranks everything including a run one
  step from merging. A pause notifies: the user wrote a message, not "stop the
  automation", so it has to say that it stopped.
- **A failing step is counted, not just logged.** A throw leaves durable state
  untouched, so the same action would retry on every document change — for
  `start_review` that is a hot loop attempting session creation. Three
  consecutive failures block the run.
- **Merge method comes from the repository**, via `gh repo view`. A hardcoded
  `--merge` fails outright on squash-only or rebase-only repositories.
- **Finding ids are sequential over the run**, not `r{round}-{n}`: a CI spot
  check deliberately does not bump the round, so round-keyed ids collided.
- **Every terminal state produces a plain-language handoff and flags
  `awaitingUserSince`.** A run that stops silently reads as a run still working.

## Storage

Policy, machine reviewer configurations, and runs share one workspace-scoped
Flock doc (`<workspaceId>:rp`, `packages/shared/src/review.ts`). A dedicated Loro
doc per run was rejected: a new document type needs plane routing
(`getPlaneForDocRoom`), and a room that resolves to no members stops syncing
without erroring. Flock rows also give the scheduler a cheap enumeration of
active runs.

Review standards and budgets remain one workspace policy. Reviewer execution is
configured separately per machine under `['reviewer', machineId]`, using the
exact `agentConfigId` plus ACP mode/model/config-option values. A new run may be
authorized only when the reviewed session's machine has a usable row and that
exact agent config still belongs to it. Authorization freezes the machine
reviewer into `run.policy.reviewer`, so later setting edits do not mutate an
in-flight review. `agentType` stays in the frozen ref for old-daemon/run
compatibility, but new execution resolves by `agentConfigId`; never fall back to
another same-type config when the selected id disappears.

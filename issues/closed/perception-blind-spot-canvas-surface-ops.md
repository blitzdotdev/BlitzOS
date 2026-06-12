# Perception blind spot: canvas-level surface ops never become moments

**Found:** 2026-06-11/12 on the VM rig — by the resident brain ITSELF, twice, independently
confirmed by the test agent.

## Observed

During the #13 scenario the tester moved two windows (`move_surface` Notepad + Working rhythm)
and then asked the brain "did you notice me moving Notepad and Working rhythm?". The brain's
verbatim answer:

> "Honestly, no. I didn't catch those moves in real time."

On #14 it volunteered the generalization: it sees only chat messages in its `/events` stream —
surface ops (move/create/close, whether driven by a human drag or another agent's tools) never
arrive as moments.

## Why (mechanism)

Perception sensors (`INJECT`) live INSIDE web surface pages: input/nav/mutation/idle signals from
page content. The CANVAS itself is not a sensor — window drags, resizes, creates, closes, tiling
changes happen in the renderer/store and emit `os:action` broadcasts, but nothing routes them into
the moment coalescer. So the desktop can be completely rearranged and the brain is never woken,
and even when woken by something else its moment stream carries no record of the rearrangement.

Telemetry had the SAME blind spot for the same reason (surface ops emit via osActions `send()`,
not the tapped adapter path) — fixed for telemetry in build #14 by tapping `send()`/`osBroadcast`.
The perception side is a DESIGN decision, not a bug fix, hence this issue instead of a patch.

## Design question (needs a call before implementing)

Should canvas-level surface ops become moments? Considerations:

- **For:** the agent-runtime thesis says perception should be content-agnostic and rich; the
  desktop's own geometry changing is first-class user activity ("the human is rearranging their
  work" is a signal). The brain being an accountable observer of the desktop it manages seems
  core. The existing `trigger:'action'` moment class + the 350ms drain/coalescer already fit
  (batch drags into one moment, like `select` debouncing).
- **Against / care needed:** an agent's OWN tool-driven ops must not wake itself in a loop
  (self-echo); needs an origin tag (human-gesture vs tool, and WHICH session's tool) so the
  coalescer can suppress self-echo while still informing OTHER sessions. Routine z/focus churn
  should not be a wake — coalesce to layout-significant changes (move/resize/create/close), ride
  the existing batch cadence, never per-pixel drag events.

## Pointer

Cheapest faithful seam: the same two functions telemetry now taps (`send()`/`osBroadcast` in
osActions.ts) could feed a canvas-signal ingest into perception-core's coalescer with an origin
tag; the coalescer decides significance per its existing rules.

## RESOLVED 2026-06-12 — build #16 (commit 48c49ce), VM-verified

The human's call: the brain should see window movement. Implemented as `trigger:'canvas'`
moments (coalesced, origin-tagged, echo-suppressed — see the commit). VM verification re-ran the
exact failing scenario; the brain's verbatim answer flipped from "Honestly, no. I didn't catch
those moves in real time." to:

> "Yes, two things this time. The events stream actually delivered them: **Unlock the personal
> layer** was opened (a new native surface, created by a tool call). **Notepad** was moved to
> (600, -50). Big improvement over last session where I was blind to moves."

Canvas moment timing measured at the designed 15s batch cadence (15523ms move→moment), `[agent
tool]` origin tag present, exact id+coords in `ops[]`, message + canvas moments coexisting in one
stream. Tests: `node scripts/test-canvas-perception.mjs`.

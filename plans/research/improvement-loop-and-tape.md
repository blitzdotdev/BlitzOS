# BlitzOS: the experiment loop and the session tape

Status: first draft, 2026-06-13. A starting point to refine together into a simple design doc.
Supersedes the dashboard-shaped parts of `session-tape-and-daydreaming.md`.

## The idea in one breath

Record what happens in BlitzOS (the human and the agent). Collect those recordings across users.
Then a person on our team has an idea to improve BlitzOS, implements it with Claude Code, and tests it
by replaying it against the recordings, scored on a goal we care about, sanity-checked by watching a
video of a few runs. Keep the changes that test better, ship, get more users, get more recordings. We
cannot retrain the model, but we can keep improving everything around it (prompts, tools, settings, the
harness). That loop is the moat.

Two things to build: the **loop** (how we test ideas) and the **tape** (what we record). The tape is
designed downstream of what the loop needs.

Stage: 3-person team, one person running this full-time at first. So it starts as a human using agents,
and is built so agents can take over the same controls later.

---

## How an engineer actually uses this

Most of the day-to-day work is debugging: an engineer sees that some user's session went wrong (call it a
failure), and wants to understand and fix it. The flow:

1. **Open the failure.** The tool loads that user's exact BlitzOS (same version, same saved state) into a
   sandbox and fast-forwards to the moment things went wrong, so the engineer sees what the user saw right
   before it failed.
2. **Try a fix.** They have an idea and implement it with Claude Code.
3. **Re-run and check two things.** Replay the same situation with the fix: is the original failure gone,
   and did anything that used to work now break.
4. **Work in bulk.** Over a day, group failures into a few problem types, then test a fix against a whole
   batch of recordings of that type at once. Claude Code runs and judges most of the batch; the engineer
   only steps in to stand in for the user when Claude Code is unsure.

So there are two tools over one engine: a **single-recording debugger** for investigating one failure, and
a **batch runner** for testing a fix across a whole problem type. Both do the same three things underneath:
load a saved point, roll forward, judge the result. Everything below exists to make that possible.

---

## Part 1: The loop (a human-run A/B harness, agent-ready)

This is an A/B testing setup, not an autonomous code-search engine. We have under 10 ideas at a time,
run by a person, not a population search.

**The unit of work is one experiment:**
- Inputs: a code change (a BlitzOS variant), a benchmark set (a curated set of recorded trajectories),
  and a goal (what "better" means).
- Outputs: a score, a watchable video of the runs, and a diff versus the baseline.

A person triggers this today through Claude Code. An agent triggers the exact same unit later. That one
clean API is the whole "designed for increasingly autonomous agents" requirement. It just has a human as
its first user.

**The human workflow:** have an idea, implement it with Claude Code, run the experiment, read the score,
watch a few key clips of the video to make sure the score is not gamed, keep or discard.

**The pieces:**
- **A benchmark set.** A curated set of real recorded trajectories that stand in for the goals we care
  about (the email-drafting ones, the layout ones, and so on). Curating this well is most of the work,
  like any eval set.
- **Goals as small, swappable files.** A goal is a checklist or a judge that scores a trajectory. It
  leans on the real human reactions in the recordings (accept, edit, undo) as the gold standard. Goals
  live in our repo, never in the tape, so we can change them anytime.
- **Run once, grade many.** Replaying is expensive (model calls); grading is cheap. So we save each
  replayed run and re-grade it whenever the goal changes, with no re-run. When we add a new goal next
  quarter, we score every run we already have for free.
- **Video replay is first-class.** We want to watch the re-simulated run to catch gaming
  (benchmaxxing). So the harness renders each replayed trajectory as something a person can watch. This
  is the one place telemetry's existing screen-capture is directly reusable, pointed at the new run.
- **How we replay** depends on which model the user ran (see "How faithfully we can re-run" below): an
  exact re-run on a model we host, a rough re-run we gut-check on a vendor model, or a cheap replay of just
  the perception layer with no model at all.

**What we deliberately defer** (over-engineered for this stage): an automatic idea-generator,
population/evolutionary search over many variants, bandit-style early-stopping, and automated
anti-gaming. For now the generator is a person plus Claude Code, and the human watching the video is the
anti-gaming check.

---

## Part 2: The tape (capture the maximum, assume we have the model)

Design principle: capture everything needed to reconstruct a run, given the model. Privacy is a consent
tier layered on top, not a constraint baked into capture. Users can opt into sharing everything
unredacted for a discount; that cohort is the design target, redaction is a downgrade path.

**The unlock: pin an open-source model we run ourselves, and we own the model plane.** The hard limit
before was that the agent runs on a vendor model we do not control, so we could not reproduce a run. For
the cohort running our pinned open-source model, that goes away. We control the weights, the exact
prompt, the sampling, the seed. So we can:
- Capture the exact model input and output, sampling params, seed, weights hash, and token
  probabilities.
- Re-run a recorded situation through the same model with the same seed and reproduce the trajectory
  exactly (deterministic replay). That is our proof the reconstruction is faithful, and the floor every
  A/B sits on.
- Remove the model's own randomness from experiments, so the only thing that changes between A and B is
  our code. That is the signal-to-noise win.

**What the tape captures (for the full-fidelity cohort), losslessly:**
- **Model I/O:** the exact rendered prompt (system + tools + context), the completion, sampling params,
  seed, weights/version hash, and logprobs.
- **Environment:** every perception moment with its snapshot, and the raw signals before they are
  summarized.
- **Effects:** every tool call's full args and results (today the code has these and throws them away).
- **Causality:** a stable id on every agent action, linked to the moments that triggered it. This cannot
  be added later, so it ships from day one.
- **Human reactions:** every accept, edit, undo, ignore, tied to the action it judges, including the edit
  content itself. This is the gold signal.
- **Stamps:** model version, code version, timestamps, ordering.
- Every line tagged **world versus agent** (so it replays), everything **keyed** (so it is a dataset, not
  a log).

**Two decisions that keep this cheap:**
- **We do not rebuild the web pages.** In the sandbox, third-party pages show up blank. We do not need
  them: the agent never reads the raw page, it reads the text BlitzOS pulls out of it, and we capture all
  of that (everything in and out of the model). For the human, the screenshot we already capture shows what
  the page actually looked like. And we cannot change third-party sites anyway, so rebuilding them buys
  nothing.
- **Most of the state is already on disk.** As the user works, the window layout and the contents of each
  window are saved as files, so saving a point to jump back to is nearly free. The one thing we save on
  purpose is the agent's conversation so far. We save points more often around failures, so jumping
  straight to a failure is fast.

**The honest tradeoff:** the model-we-host group runs a model probably weaker than Claude/Opus, so it is a
slightly worse product in exchange for perfect research data. The discount is the lever that makes the
trade worth it to the user. How faithfully we can re-run each kind of user is the next section.

---

## How faithfully we can re-run a recording (two cases)

Whether we can truly re-run a recording depends on which model the user was on.

**On a model we host ourselves: a real time-travel debugger.** We control the model and everything around
it, so we can reproduce a run exactly: same situation in, same behavior out. Re-running the unchanged code
reproduces the original, so the only thing that differs between "before my fix" and "after my fix" is the
fix. Clean, repeatable, and cheap to run in bulk on our own machines. This is where real fixing happens.

**On a vendor model (Claude or Codex, about 99% of users today): a gut-check, not a true re-run.** We
cannot reproduce a vendor model exactly (it is a black box, it is partly random, and it changes over time),
and we do not even see the exact input it received. But we can still restore the user's saved state and
conversation, get the model roughly back into the same situation, apply a change, and eyeball whether it
plausibly helps. It is noisier, so any firm conclusion means running it a few times and averaging.
- The discipline: get the simulation into the right starting situation first (best done by replaying the
  recorded conversation), then run the before and after hands-off and compare. Do not keep nudging the
  model after the change, or you cannot tell whether your fix helped or your nudging did.

**So the two groups of users play different roles.** Vendor sessions are how we FIND and group problems: we
capture what went wrong and let a human watch it, but we cannot perfectly re-run them. Our own hosted model
is where we FIX things, because we can re-run cleanly. A problem found on a vendor session gets re-created
on our model to work out a fix, then the fix ships to everyone. One caveat: our model is not the vendor
model, so a fix gets a quick check on the vendor model before shipping, to be sure it carries over.

---

## How the two connect

The tape feeds the loop: the moments are the situations to replay, the tool args and results are what
gets graded, the model I/O and reasoning are what reconstructs the run and what the person reads, and the
human reactions are the goal's gold standard. Goals and scores never go in the tape; they live in the
experiments repo so they can change freely.

---

## What we reuse from today's code

- **`telemetry.ts` is the right plumbing, wrong data contract.** Reuse its local crash-safe spool, the
  uploader, the tap-from-anywhere pattern, and the screen-capture for video. It already binds the two
  taps we need (`setToolTap`, `setMomentTap`). But it captures the wrong subset (metadata, not full
  args/results; it drops the snapshot), and it already ships data off-device with no redaction. Treat the
  tape as a second, richer capture profile over the same taps, and bring telemetry's existing egress
  under the new redaction boundary (or gate it off) first.
- **The seams to change:** widen the tool tap (the `instrument` wrapper in `os-tools.mjs` already has
  args and result in scope and discards them); keep the moment snapshot (`setMomentTap`); tap the raw
  signals before `ingestSignals` in `perception-core.mjs`; capture the model plane at the agent runtime
  (`agent-runtime.mjs`), full for the pinned-model path, by-reference for vendor; tag agent-driven clicks
  as agent-origin at `cdp.ts` so the agent does not fake human reactions.

---

## Build order (one person, cheapest-proof first)

- **M0** Tape module + widen the tool tap to full args/results + stable action ids + close the telemetry
  egress leak.
- **M1** The experiment-runner skeleton end to end with the cheap no-model perception replay, producing a
  score and a video. Proves the whole pipeline with no model spend.
- **M2** Capture human reactions and tie them to actions.
- **M3** The pinned open-source model path: deterministic replay + the run-once / grade-many split +
  prove a second goal re-grades old runs for free.
- **M4** Single-step counterfactual replay + a live check on real users.
- **M5** Consent-tiered upload (full-share cohort, redacted default, off).

---

## Open questions to settle together

- The exact experiment-runner API (inputs and outputs, how a person and later an agent both call it).
- Benchmark set: how we curate it, how big, how we keep it representative as the product changes.
- Goal / rubric format: checklist versus judge versus human-verdict-replay, and how they compose.
- Do full-fidelity users run the pinned model in production, or only in re-sim? (This decides whether the
  tape is bit-reconstructable or only situation-reconstructable.)
- How the video gets rendered for a re-simulated (not recorded) run.
- How we attribute a human reaction to the exact action it judged.
- How much of `telemetry.ts` to fork versus extend.

---

## Not doing yet

Autonomous idea-generation, population search, bandit scheduling, automated anti-gaming, federated or
on-device re-sim, and any privacy-minimization-first capture. The center is: one person testing ideas
against high-fidelity recordings with quantitative scores and watchable video, on an API an agent can
take over.

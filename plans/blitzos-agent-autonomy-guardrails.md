# BlitzOS resident agent: make it an owner, not an assistant (wiring plan)

The resident stops at the literal deliverable and idles instead of owning the goal. Doctrine edits have not
moved it because the steering STRUCTURE is reactive and the proactivity is only prose (the prose loses).
Approach: define the goal rigorously + get it approved, then keep working it with a /goal-style continuation
that the harness enforces. (To read the agent's own session: `node scripts/export-agent-session.mjs <id>`,
writes to `tmp/agent-sessions/`, gitignored.)

## Primitives (Claude Code 2.1.170, all available)
- **`/goal`** = a session-scoped **Stop hook** (a fast model checks a CONDITION after each turn and forces
  another until it holds): the "do not stop until done" forcing function. A Stop hook fires only when the
  agent YIELDS, which the backgrounding fix (Phase 2) now makes it do. Its engine is the recommended executor,
  installed at launch (the agent cannot type /goal on itself mid-session).
- **NOT `/loop`.** `/loop` is a cron/scheduled-wakeup recurrence that only fires into a persistent IDLE repl
  and expires in 7 days; it never fires from our bootstrapped `claude "<prompt>"` tmux invocation. Wrong tool.
- **Auto mode** (`--permission-mode auto`) + deny rules = the irreversible gate (blocks send/post/deploy/spend,
  honors stated boundaries). Sources: code.claude.com/docs/en/{goal,scheduled-tasks,permission-modes,hooks-guide}.

## Steering-surface map (investigated 2026-06-16) + where the guardrail wires in

The resident's behavior comes from FOUR layers. ALL are reactive-shaped, the proactivity is bolted-on prose,
and NOTHING structurally enforces continuation. This is why every doctrine edit so far has failed: the edits
land in a layer the loop structure overrides.

1. **Served doctrine** `blitzos-agents.md` §"The autonomy loop: watch -> decide -> act" (L143): "BlitzOS WAKES
   you on meaningful moments... run wait.sh again, forever... on each moment DECIDE whether it warrants action
   (**most do not**)... stay quiet otherwise." Canonical loop = react-to-moments, default-quiet.
2. **Bootstrap fragments** (`agent-runtime.mjs buildBootstrap`): the `waitLoop`/`keepChecking` fragments ran
   wait.sh as a blocking FOREGROUND call (deliver -> block -> repeat) [FIXED 2026-06-16: now backgrounded, so
   the agent yields]; and the `say` fragment STILL says verbatim **"It's best not to act unless the user has
   asked for something"** (the assistant, in writing; the next prose steer to fix).
3. **The duty** (`RESIDENT_INITIATIVE_BOOT_TASK`, onboarding.ts): the lone proactivity push, but it is prose
   competing with 1+2 and it ends "Keep polling /events," handing control back to the reactive loop.
4. **The command** (`buildClaudeCommand`): interactive TUI, `--dangerously-skip-permissions`, xhigh, and
   crucially NO Stop hook / settings. Nothing enforces continuation; "keep going" is pure prose.

Net: the STRUCTURE is reactive; proactivity is prose; the prose loses. The failure, located line by line.

### Prerequisite (or /goal just fights the bootstrap)
Neutralize the reactive steers first, or every turn the bootstrap tells the agent to settle and /goal is
overriding prose with prose: (a) drop/flip the `say` "don't act unless asked" line for the resident;
(b) reframe the duty + loop fragments from "react to moments, stay quiet" to "own the goal; check messages
BETWEEN work units." Edits to `buildBootstrap` fragments + the duty, scoped to the resident phase.

### Phase 1 (define): the improved duty
Gather first-hand (code / internal Discord / scan / a question to the user), then write a PROBLEM STATEMENT
(the underlying GOAL, not the literal request) + a staged plan to `.blitzos/onboarding/plan.md`
(status: proposed). Present it for approval as a FULLY EDITABLE plan widget, NOT a yes/no card: the user edits
the plan in place. We supply GENERIC interaction patterns (inline text-edit fields, multiple-choice toggles
per decision, reorder/remove a stage, a free-form comments box under each section) and the agent picks which
to use per plan, case by case. On submit, the edited plan + comments come back; the agent reconciles them into
plan.md and flips status: approved. Interactive; no executor yet.

### Phase 2 (execute): continuation (root cause found + the prerequisite FIXED)
The resident reached `end_turn` (a real Stop) 0 times in 667 turns, because the bootstrap ran wait.sh as a
BLOCKING FOREGROUND call (the `waitLoop` fragment: "10-minute timeout on your Bash tool"), which suspends the
agent inside a tool so it never yields. A Stop hook (which is all /goal is) fires only on a yield, so /goal
would have been a silent no-op. That was the constraint we did not know.

FIXED 2026-06-16: the bootstrap now REQUIRES running wait.sh as a BACKGROUND task (run_in_background), so the
agent yields between events and is re-invoked on each message. Verified live: a background blocking-then-exit
task launches non-blocking and re-invokes the agent on exit (and the BlitzOS skill path already runs its waker
as a Monitor for the same reason). This is the PREREQUISITE; it does not by itself make the agent proactive.

With the agent now yielding, two viable executors for "do not stop until done":
- **Harness-installed Stop hook, gated on plan.md (recommended):** set at launch (the agent cannot type /goal
  on itself mid-session). It fires on each yield: if plan.md is approved + incomplete + not-blocked -> emit
  "continue, next stage X, re-read plan.md"; else allow stop. This is /goal's engine, made viable by the
  backgrounding fix.
- **Plan-aware wait.sh (pull-native alternative):** wait.sh returns a synthetic `{trigger:"continue", stage}`
  instead of idling while plan.md is approved-incomplete; blocks only when complete/blocked. No Stop hook.
Either way needs a machine-readable stage status in plan.md the agent updates, plus a spin-guard (cap
consecutive continues with no plan.md change -> block + flag stuck).

### Irreversible gate (separate decision)
For a real "ask before send/post/deploy/spend," drop `--dangerously-skip-permissions` to `--permission-mode
auto` + deny rules (today bypass defeats Auto mode, so the act/ask boundary is prose only).

### Sequencing
DONE 2026-06-16: wait.sh runs in the BACKGROUND (the `waitLoop`/`keepChecking` bootstrap fragments), removing
the prerequisite that made every Stop-hook path a no-op (foreground blocking, 0/667 yields). Remaining:
1. Prerequisite reactive-line fixes (the `say` "don't act unless asked" line) + the Phase-1 define duty
   (editable plan widget). Without them any continuation fights the bootstrap.
2. The continuation engine: a plan.md-gated Stop hook installed at launch (now viable), or plan-aware
   wait.sh, + the plan.md stage-status convention.
3. Permission-mode change (drop --dangerously-skip-permissions -> auto) decided separately.

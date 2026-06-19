# Connection widget — non-LLM fast-refresh path (future idea)

> Companion to `connecting-external-apps-and-tabs.md`. **Not in v1.** The v1 refresh loop is
> agent-driven (significant change → moment → agent re-reads → `update_surface`). This file
> captures the optimization to reach for *if* that proves too slow/expensive for genuinely
> real-time sources.

## The problem this solves

In v1 every widget refresh is gated by an LLM round-trip:

```
adapter event → debounce → significant moment → agent wakes → connection_read → update_surface{props}
```

For a significant change with an idle agent this is fast (one inference + two cheap round-trips —
the moment fires on the immediate transition path, it does **not** wait the 25s long-poll ceiling).
But it degrades exactly when you don't want it to:

- **Chatty / real-time sources** (Slack, a live dashboard, a stock ticker) change every few seconds —
  faster than an LLM loop can keep a representation fresh.
- **The agent is the single point of failure for display freshness.** If it's mid-task, rate-limited,
  or expensive, *every* connected widget goes stale, with no deterministic fallback renderer.

The mismatch: we've put a language-model inference on the critical path of every pixel, when it
should be on the critical path of *decisions* only.

## The idea: decouple display freshness from agent cognition

Split "the source changed" into two lanes:

1. **Routine delta → widget, no LLM (the fast path).** The adapter pushes raw read-deltas straight
   into the widget's props over a cheap deterministic channel (adapter → surface props), OR the
   widget self-polls its own saved **read**-tool on a timer through the (scoped) widget→tool bridge.
   No moment, no agent, no inference. The agent-authored shell renders the fresh data itself.
2. **Semantic change → agent (the slow path, unchanged).** Only changes that need *interpretation
   or action* (a new actionable item, a state flip the agent should react to) wake the agent — the
   v1 path. The significance classifier (already needed in v1 to decide wake-vs-snapshot) is exactly
   what routes between the two lanes.

Net: the agent stays on the critical path of decisions; the widget stays fresh without it.

## Why it's deferred (prerequisites)

- **Widget-bridge per-`connId` scoping** must land first (v1 prerequisite anyway) — a self-polling
  widget calling `connection_call_tool` needs to be bound to its own connection.
- **A deterministic delta channel** adapter → widget props that bypasses the agent and is *still*
  live-only (never durably flushed; see the 8 KB / sync-flush note in the main plan).
- **A significance classifier good enough to trust** to keep routine churn off the agent. Build it in
  v1 for wake-vs-snapshot; promote it to lane-routing here.

## Build trigger

Build this when telemetry shows real-time sources where agent-driven refresh is visibly too slow or
too costly — not before. Until then, the v1 levers (fire significant moments immediately + a fast
model on the relay) are the cheaper fix.

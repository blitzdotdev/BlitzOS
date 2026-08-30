# ENTRYPOINTS — Slack/Discord as invocation surfaces: gap + e2e target

2026-08-12. Status: known gap, not scheduled. Nothing in this repo implements any of it yet.

> **Stale since 2026-08-29 (branch `lody-sessions`).** Every "the actor" and
> "ACP session" reference below names a box service that is now DELETED, along
> with its journal and its 7444 listener. The gaps this page states are still
> real, but the building blocks it counts on are gone. Read
> `plans/LODY-SESSIONS.md` for what replaces the session plane.
Principle: one runner, N thin connectors — an agent run is one session with many subscribers,
and every surface (Slack thread, webApp UI, future CLI/cron) is just another subscriber.

## The gap today

Zero entrypoint code exists (grep `slack|discord|webhook` → lockfile noise only). Chat flows
browser → SSH tunnel → box ACP on loopback. Control-plane routes are workspaces, sessions,
oauth-device, volumes, broker registry, machine types, cron. No route receives external
commands; no code pushes events outward.

## Missing pieces, dependency order

1. **Machine path to the actor** (structural). The actor binds `127.0.0.1:7444`; its only check
   is an Origin allowlist, and a missing Origin passes (`packages/box/actor/src/config.ts:23`) —
   loopback reachability is the real auth. Server-side callers need either edge-WSS (pairs with
   the still-missing reverse-proxy reference recipe) or an SSH-tunnel connector. Either way the
   actor needs real token auth BEFORE any non-loopback exposure; origin checks are not auth.
2. **Task-runner primitive** (structural). One reusable path: ensure workspace → open ACP
   session → prompt → stream → complete. Build it once (small SDK or control-plane route); each
   surface is then a thin connector. Runs go through the actor journal — never headless agent
   CLI over SSH exec — so every run is visible and replayable from the webApp.
3. **Webhook receivers** (thin). Slack: signing-secret verify, 3s ack, async continue. Discord:
   interactions endpoint, ed25519 verify, answer PING (incoming webhooks only post messages;
   command intake needs a Discord app). The control-plane worker can host both; `phone_home`
   already models signed single-use intake.
4. **Event egress** (thin). Nothing pushes outward today; the control plane never sees turn
   events. The connector holds an ACP subscription and posts thread updates (Slack Web API /
   Discord follow-ups). Portability caution: a durable per-session subscriber on Workers means a
   Durable Object — keep the connector runnable on plain Node.
5. **Identity mapping + thread state** (thin). Single `operator` principal today. Map external
   identity → principal (the permission ceiling when agents inherit a human's access), plus a
   thread ↔ session table so replies in a thread continue the same session.
6. **In-thread approvals** (thin). Render ACP permission requests as Slack buttons; answers flow
   back over the same subscription.

Prereq: the provisioning boot path (cloud-init currently never launches the box). Entrypoints
land after it. Once 1+2 exist, each connector is days of work.

## E2E target (the acceptance test)

Drive one agent session from Slack and interact with THE SAME run from the webApp UI:

1. A Slack slash command starts a task: the runner acquires a workspace, opens an ACP session,
   sends the prompt.
2. Turn events stream into the Slack thread as they happen.
3. Mid-run, open the webApp: the same session is live there — full transcript via journal
   replay — and the next prompt can be sent from either surface.
4. A permission request raised by the agent appears in BOTH surfaces; answering in one resolves
   it in the other.
5. On completion the final message lands in the thread, and journal replay reproduces the whole
   run afterwards.

Why this is cheap: the actor is already one-to-many. SQLite journal, replay, and multiple
concurrent ACP subscribers are implemented and unit-tested
(`packages/box/actor/test/actor.test.ts`). The e2e test proves that fan-out across real
surfaces: Slack and the webApp are just two subscribers of one session. This is also the
product story — default surfaces work out of the box, and an operator can later customize or
replace the webApp without losing the Slack lane.

## Non-goals

- No workflow engine, no playbook DSL. A skill file declares what a repeatable task needs; the
  runner stays a dumb pipe.
- No universal MCP/tool gateway. Credential access is scoped short-lived token injection at
  workspace level; approvals live at the tool-call layer (the actor), not a network proxy.

# Relay reconnect storm — fix draft (DRAFT, nothing applied)

_Drafted by the BlitzOS resident agent, 2026-06-14, from reading the live code. Pairs with `relay-reconnect-storm-mints-new-urls.md`. No code changed yet._

## What the code actually does now (corrects the issue's "no keepalive" guess)

- `src/main/relay.mjs` `startRelay()` is the single shared lifecycle. It imports `@agent-socket/sdk`, which is a **symlink to `vendor/agent-socket-sdk`** (so it already runs the heartbeat-capable build, not a stale copy).
- The vendored SDK **does** have a WS heartbeat: ping every `heartbeatIntervalMs` (default **25000**), and if no pong arrives within `heartbeatTimeoutMs` (default **50000**) it calls `ws.close(1011, "dead heartbeat")` (`session.js` `_sendPing` / `_scheduleNextPing`). Any inbound frame resets the idle timer, so a ping only fires after 25s of silence.
- `relay.mjs` never passes `heartbeatIntervalMs` / `heartbeatTimeoutMs`, so it runs on the 25s/50s defaults.
- On any drop, `onSessionChanged` re-mints the token and adopts the new URL, then `publishUrl()` rewrites `.blitzos/relay-url`. **Local** agent terminals re-read that file per call and self-heal. A **remote** agent holding the old pasted URL has no such file, so it gets `app_offline` / 404 and is dead.

So there are still two distinct problems, but the framing changes:

1. **Drops still happen** even with a 25s heartbeat: in UTM shared-NAT the idle flow is reaped on a short timer, and 25s leaves little margin. A delayed/lost pong then trips the 50s timeout, which itself closes the socket and forces a reconnect (the heartbeat can be self-inflicting churn under loss).
2. **Every reconnect changes the public URL.** This is by SDK design (`mintAgentToken` returns a fresh token; `onSessionChanged.tokensRemapped` just reports old→new). Nothing makes the pasted URL survive a blip. This is the real damage for a remote driver, and it is **not fixable inside `relay.mjs` alone**.

## Proposed fixes (sequenced by leverage / effort)

### 1. Tune the heartbeat for hostile NAT — in-repo, low risk, ship first
File: `src/main/relay.mjs`, the `connect({...})` call.
- Pass `heartbeatIntervalMs: 15000` and `heartbeatTimeoutMs: 40000` so the flow is exercised well under common 30s NAT idle reapers, with a timeout that tolerates one missed pong rather than closing on a single late one.
- Optionally drive `session.ping()` from the existing 20s watchdog as a belt-and-suspenders keepalive (cheap, the SDK no-ops if a ping is already in flight).
Effect: turns ~1 drop / 2.5 min into rare drops. Does not by itself fix URL survival.

### 2. Make the pasted URL survive a reconnect — needs RELAY-side support (the durable fix)
This is the one that actually unblocks an unattended remote agent. Options, in order of preference:
- **Deterministic token per (appId, label):** relay returns the SAME paste URL when the same app re-mints with the same `label`. Then `onSessionChanged`'s re-mint yields an identical URL and the remote agent never loses its handle. Smallest protocol change; `relay.mjs` already mints with a stable `label`.
- **Session resume:** SDK re-registers with the prior `sessionId` on reconnect so existing tokens stay valid (`ConnectOptions` would need a `resume`/`sessionId` field; the relay DO would need to keep the token map warm briefly across reconnects).
- Either lives in the relay Worker + possibly the SDK, NOT in this repo. Action: file a relay-side issue with this contract. Until it lands, fix 1 minimizes how often the gap is hit.

### 3. Make flapping visible — in-repo, small
The adapter already gets `onStatus(online, url)` and `onUrl(url)`. Wire `onStatus` to a toolbar status dot (green/connected, amber/reconnecting) and log a reconnect counter, so a flapping relay is diagnosable without reading `blitzos.log`. Find the `startRelay(cfg, adapter)` caller (agentSocket.ts) and have the adapter push status into the renderer it already feeds.

## Recommended order
Ship **1** now (one-line options object, fully reversible, measurable on the VM rig). File the **2** relay contract in parallel since it is the only thing that makes the agent-socket path usable outside localhost. Do **3** opportunistically.

## Open question for Minjune
Does "background agent working end-to-end" require the remote/VPS path (then fix 2 is mandatory and blocking), or is the unattended host↔VM loop with local relay-url self-heal enough for now (then fix 1 alone clears the storm)?

---

## STATUS UPDATE 2026-06-15: Fix 1 applied to working tree (uncommitted)
Applied in `src/main/relay.mjs` `startRelay()`:
- `heartbeatIntervalMs: 15000`, `heartbeatTimeoutMs: 40000` on the `connect()` options (was relying on SDK defaults 25000/50000).
- An independent keepalive: the 20s watchdog now calls `session.ping()` while online, so the WS path is exercised even if the SDK heartbeat timer is suspended (backgrounded app). no-op if a ping is already in flight.
`node --check` passes. NOT committed, NOT deployed. Reversible via `git checkout src/main/relay.mjs`.
Remaining: Fix 2 (relay-side stable/resumable token, the durable URL-survival fix) and Fix 3 (toolbar status dot).

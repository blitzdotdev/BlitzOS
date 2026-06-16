# Relay Fix 2 — stable paste URL across reconnects (relay-Worker-side contract)

_Drafted 2026-06-15 by the resident agent. The durable half of the reconnect-storm fix (pairs with relay-reconnect-storm-FIX-DRAFT.md). This is NOT a change to this repo: it is a contract for the relay Worker (github.com/teenybase/agentsocket) and possibly the vendored SDK. Filed here so it is tracked next to its symptom._

## The problem this closes
relay.mjs Fix 1 (heartbeat tuning, applied) makes drops rare. But ANY reconnect still mints a fresh token, so the pasted URL changes and a remote agent holding the old URL dies (`app_offline` / 404). Local agents self-heal off `.blitzos/relay-url`; a remote driver has no such side channel. Until the URL survives a blip, the agent-socket path is unusable outside localhost.

## Current protocol (from vendor/agent-socket-sdk/dist/session.js)
- `connect()` sends `{ type: "register", appId }` and waits for `{ type: "register_reply", ok, sessionId }`.
- `mintAgentToken({ label })` sends `{ type: "mint_agent_token", id, label }` and gets back `{ token, url, label, expiresAt }`.
- The relay routes an agent's HTTPS calls by **token → session**. On reconnect the SDK gets a NEW sessionId and re-mints, producing a NEW token/url; the old token no longer routes.

## Proposed contract (Option A, recommended): deterministic token per (appId, label)
Make the public handle a function of `(appId, label)`, not of the session:

1. On `mint_agent_token { label }` from `appId`, the relay returns the SAME `token`/`url` it last issued for that `(appId, label)` if that handle is still live, instead of a fresh random token.
2. Route by `(appId, label) → current live session` rather than `token → session`. The token embeds/maps to `(appId, label)`; the relay points it at whichever session most recently registered that appId.
3. On reconnect, the SDK re-mints with the same `label` (it already does, relay.mjs passes a stable `label`), gets the identical URL back, and `onSessionChanged.tokensRemapped` becomes a no-op (old url === new url). The remote agent's pasted URL keeps working.

Edge cases to define:
- **Two live sessions, same appId** (two app instances): last-registered wins routing, or reject the second register, or namespace by an instance id. Pick last-write-wins for the single-user case; document it.
- **Revocation:** `revokeAgentToken` must invalidate the `(appId, label)` handle, not just one token string.
- **Expiry:** keep `expiresAt`, but a reconnect must not shorten a live handle.
- **Cold relay (DO evicted):** if the relay lost all state, a re-register re-creates the same deterministic token, so the URL still resolves once the app reconnects. This is the big win over random tokens.

## Alternative (Option B): session resume
Add `prevSessionId` (or `resume: true` + last sessionId) to the `register` frame. The relay, if it still holds that session's token map warm, re-attaches it to the new WS instead of orphaning it. Needs a new `ConnectOptions.resume`/`sessionId` field in the SDK and DO-side retention. More moving parts than A; A is preferred because it also survives a cold relay.

## Acceptance test
On the VM rig: paste a URL into a remote agent, force 5 WS drops (toggle the NAT / kill the socket), confirm the remote agent keeps driving on the ORIGINAL URL with no re-paste. Today it dies on drop #1.

## Why A over B
A makes the URL a stable name (paste-once, forever-valid for that app+label) and survives even a full relay restart; B only survives drops while the DO stays warm. A is the smaller surface for the SDK (no new connect option) and the bigger reliability win.

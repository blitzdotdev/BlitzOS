# Relay WS reconnect storm — every reconnect mints a NEW share URL (remote agents lose their handle)

**Found:** 2026-06-11, live on the VM test rig (second catch of the host↔VM loop).
**Build:** v0.0.1-10 (`build-agent-runtime-moments-10`) in a UTM macOS VM (shared/NAT network).

## Observed (verbatim from the VM agent)

> RELAY STORM @15:24-15:59 (35 min). BlitzOS minted **14 new relay URLs in sequence** — its WS
> to the relay is repeatedly dropping. Last tokens: `as_AJF1FEE6_…`, `as_FK8SAS86_zID7…`,
> `as_FK8SAS86_zNUU…`. `session.json` rewritten each time (updatedAt rolling). One
> `[update] check failed: fetch failed` line at 15:24. The repeated agent-socket lines in
> blitzos.log indicate a WS reconnect cycle, not new boots.

≈ one drop every 2.5 minutes. Main process stayed up the whole time (PID stable), so this is
purely the agent-socket connection layer.

## Two distinct problems

1. **The WS drops at all** (transport): in a UTM shared-network (NAT) guest the idle TCP flow
   gets reaped on a short timer. The vendored SDK / relay session appears to have no (or too
   slow) WS keepalive ping, so any NAT/proxy with an idle timeout kills the socket. This is
   exactly what made "Connect AI" look stuck during onboarding — the URL displayed was already
   dead.
2. **Reconnect mints a fresh session → NEW paste URL** (protocol/UX): any agent holding the old
   URL silently loses control (`app_offline` / 404). For the agent-runtime mission this is the
   real damage: a remote driver cannot survive even one blip. The host loop works around it by
   re-reading `/Volumes/blitz/.blitzos/session.json` before every drive, but a real remote agent
   has no such side channel.

## Suggested fixes

1. SDK: send WS ping (or protocol-level heartbeat) every ~25s; reconnect with backoff (it may
   already back off — verify it isn't reconnect-looping faster than needed).
2. Relay/SDK: support **session resume** on reconnect (re-register with the previous session id
   so the minted agent tokens/URLs stay valid), or have BlitzOS re-mint and serve the SAME token
   label such that the old URL keeps routing. The share URL a user pasted into an agent must
   survive transport blips, or the agent-socket path is unusable outside localhost.
3. BlitzOS: rate-limit/log reconnect churn visibly (a status dot in the toolbar), so a flapping
   relay is diagnosable without reading logs.

## Repro

UTM macOS guest, shared network, BlitzOS #10, leave it idle with the relay connected; watch
`~/.blitzos/session.json` updatedAt + blitzos.log re-register lines every few minutes.

# Plan — Handoff card ("Requires user login" and any human-in-the-loop step)

Generalizes the login case the user hit (agent prose-d "go sign in" at an invisible background Blitz Chrome tab). A **handoff card**: the agent hands a connected surface to the user for a human step (login, 2FA, captcha, consent), shown as a screenshot framed with a title; tapping it instantly focuses the real surface; it resumes itself when the step completes. NOT login-specific. Depends on the focus fix's `blitz_chrome_show` (land that on blitz-v1 first).

Locked decisions: **instant BlitzOS-direct focus** (new renderer→main bridge), **general human-takeover** scope, **persistent until the agent marks it done**.

## Flow
1. Agent hits a human-step wall (already reads the page to check signed-in identity per doctrine).
2. Calls `request_handoff {connection, reason}` (reason = "Requires user login", "Enter the 2FA code", etc.).
3. BlitzOS screenshots that connection, stores it in a runtime handoff entry, posts a small handoff card to chat.
4. User taps the screenshot → BlitzOS focuses the real surface directly (no agent round-trip) → user does the step.
5. Step completes → the page navigates → a `connection` moment wakes the agent (confirmed path) → agent `connection_read` to verify → `resolve_handoff {cardId}` → card collapses to "✓ done" → agent continues the task.

## Why this shape
- **Screenshot lives in a runtime store, not the transcript.** The ```blitz-ui fence carries only `{type:'handoff', cardId}`; the card looks up reason/img/status from the store by cardId. Keeps chat.md tiny (a base64 PNG inline would bloat transcript + context).
- **Resume via perception, no polling.** Blitz Chrome main-frame nav → `onMainFrameNav` → `connectionNotify(significant)` → `emitConnectionMoment` → `trigger:'connection'` → agent's `/events` loop (verified end-to-end).
- **Connection-generic reveal.** Reveal by connId: Blitz Chrome → `show(agentId)`; user's real tab (extension) → activate that tab; macOS window → bring app forward. V1 must-have is the Blitz Chrome arm (the screenshot case); others are thin follow-ons.

## Touch points

Main:
- `os-tools.mjs`: new `request_handoff {connection, reason}` → `ops.requestHandoff`; new `resolve_handoff {cardId}` → `ops.resolveHandoff`. (Both Electron-only; 501 on the headless transport.)
- `connection-ops.mjs`: `connectionReveal(connId)` dispatch-by-kind (Blitz Chrome arm → resolve agentId from the connId's window, call `blitzChrome().show(agentId)`); `requestHandoff(connId,{reason})` = screenshot via the adapter + create handoff entry + broadcast + `ops.say` the `{type:'handoff',cardId}` fence; `resolveHandoff(cardId)` = flip status→done + broadcast.
- `osActions.ts`: hold the runtime handoff map `{cardId→{connId,reason,img,status}}` + broadcast it to the renderer (mirror the chat/state broadcast). Runtime-only, not persisted.
- new IPC `os:reveal-connection` → `ops.connectionReveal(connId)`.

Preload (`src/preload/index.ts`):
- `agentOS.revealConnection(connId)` → IPC `os:reveal-connection`. (Handoff state rides the existing os:action/os:state broadcast, or a small `onHandoff` channel.)

Renderer:
- `notch/handoffStore.ts`: external store (module `let` + `useSyncExternalStore`, the stagingStore.ts pattern — NO zustand), fed by the broadcast, keyed by cardId.
- `notch/types.ts`: add `IslandHandoffPart = {type:'handoff', cardId}` to the message-part union.
- `notch/messageParts.ts`: parse `type:'handoff'` out of a ```blitz-ui fence (alongside `choice`).
- `notch/MarkdownMessage.tsx`: render the handoff part — looks up the entry from handoffStore by cardId; styled like `isl-ask-card`: title = reason, a big tappable screenshot; while `status==='awaiting'` each tap calls `agentOS.revealConnection(connId)` (persistent); when `status==='done'` collapse to a slim "✓ {reason} done" line. Past-session card with no live entry → show the reason text only (screenshot is ephemeral).

Doctrine:
- `blitzos-agents.md` (Identity:13, Connections:54) + `blitzos-onboarding.md`:44 + `blitzos-interview.md`:45/49: replace "ask them to sign in" prose with: on a login/account-chooser or any human-step wall, call `request_handoff {connection, reason}` (do NOT write prose telling the user to go sign in); after the connection wakes you, `connection_read` to confirm, then `resolve_handoff` and continue.

## Verify (human-in-the-loop)
1. Agent on a login wall posts the card (title + screenshot), no "go sign in" prose.
2. Tap the screenshot → the real Blitz Chrome tab comes to the front instantly.
3. Sign in → agent wakes on the nav, confirms, card collapses to ✓, task continues (sends the email).
4. Bounce away mid-login → tap the card again → returns to the tab (persistent).
5. 2FA/consent reason string works the same (generality).

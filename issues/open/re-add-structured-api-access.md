# Re-add structured API access (provider_call) — deferred, not abandoned

**Status:** tracked / deferred (user decision 2026-06-16: "track to re-add later")
**Context:** commit `629b40d` removed the entire OAuth/integrations subsystem in favor of
browser-first (`read_window` / `surface_control` on the user's logged-in web surfaces). See
`issues/open/oauth-full-removal.md` for the removal scope. The removal was the right call for
the immediate footgun (an expired `integrations.json` token nagged the user to "reconnect Gmail"
while they were already signed in there). This issue captures what that gave up, so it isn't
silently lost.

## What was lost (capability, not just code)

1. **`provider_call`** — authenticated, *structured* API access to connected providers, token
   injected server-side (the agent never saw it). Broad GET on any provider path; writes
   (POST/PUT/PATCH/DELETE) popped a human approval card; sensitive reads returned
   `consent_required` until approved once. Shipped specs (extensible): GitHub (repos,
   create/comment issue, delete-repo), Gmail (send), Slack (post-message), Jira (create/transition
   issue), Discord (guilds), each with per-route `risk` + OAuth `scopeReq`.
   - **Why it matters:** browser-first DOM-driving needs a loaded, logged-in tab, is flakier for
     structured writes (one Gmail API send vs. driving the compose UI), can't reach what the UI
     doesn't expose, and can't run headless/background. This is a real reliability/capability gap
     for write-heavy or unattended tasks.
2. **The write-approval queue** (`approval-queue.mjs`) — a pure, transport-agnostic,
   concurrency-correct human-in-the-loop "approve this write" primitive (each request resolved
   exactly once; expiry → deny). It was only *wired* to providers, but it's a reusable gating
   primitive. If we want to gate ANY agent write (e.g. a DOM-driven "send"), this needs rebuilding.
3. **`blitz.data`** — widgets could fetch+display live provider data server-side; now a widget only
   gets what the agent scrapes and pushes via `props` (no autonomous refresh).
4. **`account_hint`** (minor) — surfaces were tagged with which connected account matched; the agent
   now `read_window`s to verify (which the doctrine already required).

## Re-add options (when prioritized)

- **Minimal:** restore just the **approval-queue primitive** and wire it to gate DOM-driven writes
  (`surface_control` actions classified as a "send/post/pay"), independent of OAuth. Gets the
  human-in-the-loop safety back without the token-maintenance footgun.
- **Targeted:** re-add `provider_call` as **opt-in per provider**, but key auth off the *browser
  session* where possible, and never nag — treat a missing/expired token as "use the browser
  surface instead," never an interrupt. (The footgun was the nag, not the capability.)
- **Full revert:** `git revert`/cherry-pick `629b40d` to restore the whole subsystem (provider_call,
  approval queue, blitz.data, account_hint, OAuth flow, connector UI). Heaviest; brings back the
  maintenance burden.

The removed code is recoverable from git at `629b40d^` (provider-specs.mjs / provider-call.mjs /
provider-bridge.ts / approval-queue.mjs / integrations.ts / oauth.ts / tokenStore.ts).

# GitHub org path: install once, commit as the member

Status: ABANDONED 2026-08-26. §3 shipped (#71). §1, §2 and §5 shipped as
#74 and were reverted the same day — see the note below. GitHub is moving to a
personal-token connector, the same class as YouTrack.

Original status: plan. App `blitzosauth`, App ID `4334267`, Client ID `Iv23liwiZP2zvQgqlCl5`.
`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` are already set on canary
and prod.

## Target flow

1. **Admin, once per org.** Template page → "Connect with BlitzOS app" →
   GitHub install screen (pick org, pick repos) → back with `installation_id`.
2. **Member, once.** Agent hits a missing credential → `blitz-cred get github`
   refuses and files a request → `blitz connections open github` → member
   clicks Connect → one consent screen → `ghu_` grant.
3. **Every workspace.** Mint prefers the member's grant over the org
   installation token. Agent commits and pushes as the member.

Step 2's prompt **already exists** — agent rules, `blitz-cred`, the
connections-focus contract, and `WorkspaceProviderRows` all ship today. No work.

## What GitHub makes unavoidable

An install grants **repo access**. A user authorization grants **identity**. A
user-to-server token reaches the intersection. So an org needs both: one install
by someone with admin rights, one authorize per member who wants their name on
the work. Nothing removes the second step without giving up attribution.

## Work

### 1. Platform-key app-jwt (server)

`minters/app-jwt/github-app.ts` signs with the private key stored on the org's
connection row. Add: when config carries `platform_key: true`, sign with the
`GITHUB_APP_PRIVATE_KEY` binding instead. Config becomes
`{app_id: "4334267", installation_id, platform_key: true}` — same `app-jwt`
kind, no migration, and the org never holds the key.

`registry.ts` must accept an `app-jwt` PUT with no root when `platform_key` is
set; today root is required.

Secret: `GITHUB_APP_PRIVATE_KEY`, from `/workspace/blitzosauth.2026-08-26.private-key.pem`
(PKCS#1, which the minter already parses).

### 2. Install callback (server)

New `GET /connect/github/installed?installation_id=…&state=…`. Verifies the
signed state the template page issued, writes the connection row, redirects
back to the template.

Requires a **Setup URL** on the App with "Redirect on update" enabled:
`https://blitzos.com/connect/github/installed` and the canary equivalent.
Without it the admin copy-pastes the installation id by hand.

### 3. Git identity, set in the box (replaces the old §3 and §4)

Attribution on a commit comes from `user.email`, not the token, and nothing in
`bootstrap.ts` or `box/rootfs` sets a git identity today. So commits are
unattributed even with a perfect token.

**The box resolves it from the token it just pulled**, rather than the control
plane pushing a copy anywhere:

1. `blitz-cred get github` fetches a token as it does now
   (`broker/internal/workspace/connections.go`, `wireConnectionToken`).
2. If the resolved identity for that token is not already cached, call
   `GET https://api.github.com/user` with it and read `login` and `id`.
3. `git config --global user.name <login>` and
   `git config --global user.email <id>+<login>@users.noreply.github.com`.
4. Cache keyed on a hash of the token, in box state. `ghu_` tokens rotate every
   8 hours, so this re-probes about three times a day and is always correct
   within one rotation.

Nothing is stored in the control plane, and no new wire field is added.

**Why not the workspace-environment route.** It writes a copy of the identity
into each workspace. One live grant exists per user per provider —
`user_oauth_grants_live` is `UNIQUE(user_id, provider) WHERE revoked_at IS NULL`
— so a member who reconnects as a different GitHub account leaves every earlier
workspace carrying the previous account's name while the token is the new one.
Commits then attribute to the wrong account, silently, and every existing
workspace needs rewriting on every reconnect. Deriving from the token in hand
cannot go stale.

It also covers PAT grants for free. A pasted PAT never passes through the OAuth
callback, so any callback-capture design would have to probe `GET /user`
separately anyway — this design has exactly one path.

**Costs.** A box-image change rather than a control-plane one, and one extra
GitHub request per token rotation. `git config --global` is user-writable, so
this is attribution, not a security boundary — a member can still forge an
author locally.

**Edge cases to handle.** No `github` connection: leave git config alone rather
than clearing it. A `GET /user` failure: leave the previous identity and carry
on; a missing byline is better than a wrong one. A user who set their own
`user.email` by hand: overwrite it, since the platform value is the one that
links, and say so in the agent rules.

### 5. Template page (webapp)

- Rename "Add / Replace GitHub key" → **"Connect with my app"**. No behaviour
  change; it is the existing bring-your-own-App form.
- Add **"Connect with BlitzOS app"** → `https://github.com/apps/blitzosauth/installations/new?state=<signed>`.

Both coexist with a stored org key.

## Order

1 → 2 → 5 gives the admin path end to end. 3 gives attribution on its own and
depends on none of the others, so it can ship first — it already improves both
the PAT path and today's member OAuth.

## Not covered

- Revoking or reinstalling the App; the row would need refreshing.
- Members whose GitHub account cannot see a repo the install covers — the
  intersection rule silently narrows them.
- Commit signing. CLI pushes get no Verified badge either way.


## Why §1, §2 and §5 were reverted

A GitHub App has **one** Setup URL, not a list like its callback URLs. So every
install redirect lands on a single host no matter which deployment started it.
An install begun on canary returned to `blitzos.com`, which had neither the
route nor the signed-state cookie — the cookie is host-scoped, so even a
deployed prod could not have verified it.

The workable answers were a second App per deployment, or dropping the redirect
and matching installations through `GET /app/installations`. Both cost more than
the org path was worth: the owner's call was that GitHub should be a personal
token, the same class of connector as YouTrack, and that the org-key path should
go with it.

§3 stands on its own and stays: it derives a git identity from whatever token is
in hand, which is a personal token just as readily as an App user token.

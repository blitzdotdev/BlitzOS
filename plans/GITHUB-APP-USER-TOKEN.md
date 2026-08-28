# GitHub App, user token only: install for reach, authorize for identity

Status: plan. Supersedes the App half of `GITHUB-ORG-PATH.md` (ABANDONED
2026-08-26). Reverses the owner ruling in that document's §7, and needs the
owner's sign-off before any of it is built.

App `blitzosauth`, App ID `4334267`, Client ID `Iv23liwiZP2zvQgqlCl5`.
`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` are already set on canary
and prod, from the earlier attempt.

## The problem this solves

A fine-grained personal access token requires an org owner to approve **each
token**, so approval cost scales with headcount. It also cannot enumerate
organizations at all: `GET /user/orgs` with a fine-grained token is documented
to return `200` with an empty list, which was confirmed against a live token on
2026-08-27. So the repo picker can never show a member which orgs they are in,
and a member of an org that has not approved their token sees only public
resources with no error to distinguish that from "the repo does not exist".

An install is one owner action per org, and it covers every member afterward.

## What is different from the abandoned plan

The abandoned plan stored an `installation_id` on an org connection row and
minted `app-jwt` installation tokens from a platform private key. Two things
followed from that, and both were fatal:

1. It needed an **install callback** to capture the `installation_id`, which
   needed the App's single Setup URL, which cannot serve canary and prod at
   once. This is the reason §1, §2 and §5 were reverted.
2. An installation token attributes every action to the app, which is the
   opposite of what the attribution work exists for. This is the owner's
   reasoning in §7, and it is correct about installation tokens.

**This plan never mints an installation token.** The installation exists only
to grant repo *reach*. Identity comes from the member's own user-to-server
token, exactly as `GITHUB-ORG-PATH.md` §"What GitHub makes unavoidable"
described: an install grants repo access, a user authorization grants identity,
and a user-to-server token reaches the intersection.

Three consequences:

- **No `installation_id` is stored anywhere.** The member's own token discovers
  installations through `GET /user/installations`. Nothing needs to be captured
  at install time.
- **No install callback, so no Setup URL, so no multi-deployment problem.** The
  admin follows a plain link to GitHub and comes back on their own. The blocker
  that killed the last attempt does not exist in this shape.
- **No `app-jwt` kind, no `GITHUB_APP_PRIVATE_KEY` binding, no PKCS#1
  normalizer, no `.pem` drop zone.** All of that stayed deleted. The private key
  at `/workspace/blitzosauth.2026-08-26.private-key.pem` is not used.

Commits attribute to the member. `gitidentity.go` (shipped as §3 of the
abandoned plan, #71) already derives the byline from whatever token is in hand,
and a `ghu_` token answers `GET /user` exactly as a personal token does. That
file needs no change.

## Verified provider facts

Checked against docs.github.com on 2026-08-27.

- Authorize `https://github.com/login/oauth/authorize`, token
  `https://github.com/login/oauth/access_token` — the same endpoints an OAuth
  App uses.
- A user access token "does not use scopes. Instead, it uses fine-grained
  permissions", and the `scope` response parameter "will always be an empty
  string". Permissions come from the App registration.
- PKCE is supported: `code_challenge` and `code_challenge_method=S256` are both
  "strongly recommended".
- User access tokens expire after 8 hours when token expiration is enabled, and
  arrive with a `ghr_` refresh token that expires after 6 months. The comment in
  `gitidentity.go` already assumes this 8-hour rotation.
- A user token can only reach an org "if the app is also installed on that
  organization", and only repositories "that the user has access to". The
  intersection rule.
- `GET /user/installations` and `GET /user/installations/{id}/repositories`
  both require a user access token, not an installation token.

## Work

### 1. App configuration (no code)

On App `blitzosauth`:

- Repository permissions: **Contents** read and write, **Metadata** read,
  **Pull requests** read and write.
- Enable **expire user authorization tokens**. This is what produces the `ghr_`
  refresh token that `refreshedAccessToken` needs. `GITHUB-ORG-PATH.md` records
  the failure mode when a token expires with no refresh path, and migration
  `0035` revoked grants stuck in exactly that state.
- Leave **"Request user authorization (OAuth) during installation"** OFF.
  Turning it on starts the web flow right after install, which would drag the
  Setup URL problem back in through the redirect.
- Do **not** set a Setup URL. Nothing in this plan reads one.

Callback URLs: add both the canary and prod `\/connect/github/callback` hosts.
Unlike the Setup URL, callback URLs are a list, which is why the authorize half
was never the broken half.

### 2. Restore `auth` on the GitHub manifest

`core/connections/catalog/github.ts`. Change `StaticProviderManifest` to
`OAuthProviderManifest` and fill `auth`:

- `authorizeUrl` and `tokenUrl` as above.
- `clientIdVar: "GITHUB_APP_CLIENT_ID"`, `clientSecretVar:
  "GITHUB_APP_CLIENT_SECRET"`. The names are already correct for an App and are
  already bound on both deployments.
- `pkce: true`.
- `accessTtlMs`: 8 hours.
- `authorizeParams: []`.
- `scopeDelimiter: " "` — unused in practice, but the type requires it.

Keep `scopes: []` and `defaultScopes: []`: a GitHub App has no scope
vocabulary, and the existing comment on `scopes` already explains why an empty
list is the honest value for a credential that carries its own reach.

Keep `personalToken` unchanged. The paste path stays as the fallback for anyone
whose org will not install the App.

Keep `custody: "cp"`. Git talks to github.com directly and cannot ride the
proxy.

Rewrite the doc comment. It currently asserts that the App paths are gone and
that both cost an install dance. State instead that the install is one org
action rather than one per member, and that no installation token is ever
minted.

### 3. Two changes to the connect round trip

**3a. Omit `scope` when a manifest declares none.**
`core/connections/connect.ts:139` sets `scope` unconditionally from
`manifest.defaultScopes.join(...)`. With an empty list that sends `scope=`,
which GitHub ignores but which reads as a bug to the next person. Set the
parameter only when `defaultScopes.length > 0`.

**3b. Return to the surface the round trip started from.**

This flow is **never** started from `/settings/connections`. It starts from
template creation or workspace creation, and it must land back there with the
picker ready. Today it cannot: `ConnectOAuthExtra` carries only `workspaceId`,
and `returnUrl` sends everything else to `CONNECT_RETURN_PATH`, which is
`/settings/connections`. A member who connects from the template screen would
lose the half-filled template and land in settings.

Add a `returnTo` to the signed state, resolved to one of the routes
`parseAppRoute` already knows (`packages/webapp/src/sessions-page-state.ts`):

| `returnTo` | Path | Surface |
| --- | --- | --- |
| `template-new` | `/templates/new` | admin builds a template |
| `template-edit:<id>` | `/templates/<id>/edit` | admin edits one |
| `workspace-new` | `/workspaces/new` | member creates a workspace |

`/workspaces/new` is not in the `AppRoute` union; `CloudApp.tsx:684` matches it
directly. Either shape works, but the resolver must not assume the union.

Two constraints:

- **Allow-list, never a free path.** `returnTo` arrives as a query parameter on
  `/start`, so an arbitrary value is an open redirect. Validate it into a
  closed enum before it reaches the signed state, the same discipline
  `controllableWorkspace` already applies to a workspace id.
- **`workspaceId` keeps precedence.** The connect grid inside a workspace still
  returns to `/workspaces/:id`. `returnTo` only replaces the settings fallback.

The `connect=ok|authorized|denied` and `provider=` query parameters ride along
unchanged, so each surface can report what happened.

`CONNECT_RETURN_PATH` stays for the paths that genuinely start in settings.
Nothing in this plan uses it.

Everything else in the round trip works unchanged: `/connect/:provider/start`,
the PKCE challenge, the callback, `exchangeTokens`, `storeGrant`, and
`refreshedAccessToken`.

### 4. New route: list installations and repositories

New module beside `github-repo-check.ts`. Two routes, both guarded by
`principal.orgId !== null`, matching the existing check route.

`GET /connections/github/installations` — calls `GET /user/installations` with
the caller's grant. Returns the account login, account type, `id`, and
`repository_selection` for each. An empty list is the signal that no org has
installed the App, and the UI needs it to say so precisely.

`GET /connections/github/repositories` — for each installation, calls
`GET /user/installations/{id}/repositories?per_page=100`, follows the `Link`
header, and merges. Caps total pages and returns a `truncated` flag; a silent
cap would read as "this is all your repos".

Falls back to `GET /user/repos?affiliation=owner,collaborator,organization_member`
when the caller's credential is a pasted personal token, since the
installations endpoints reject it. One response shape covers both, with a field
naming which path answered.

Wire types go in `core/wire.ts` and `packages/schema`.

### 5. Make the reachability probe credential-aware

`core/connections/github-repo-check.ts` probes `git-upload-pack` anonymously
and reports `not-public` for anything private, so no private repo can be added
today.

When the caller holds a GitHub credential, send it on the probe. Use **Basic**
auth with username `x-access-token`; this was measured on 2026-08-27, and
`Authorization: Bearer` returns 401 on the git endpoint while the same token
returns 200 on the REST API. The doc example is
`git clone https://x-access-token:TOKEN@github.com/owner/repo.git`.

Widen the verdict from a boolean to `public` | `private-reachable` |
`not-found` | `unreachable`. Keep the anonymous probe for a caller with no
credential; its comment about matching the credential-free bootstrap clone is
still true for a public repo.

### 6. Record which repos are private

Add a `private` column to `workspace_template_repos`, migration `0036` (0033 is
already skipped in this tree).

The bootstrap clone loop gives up after 600 seconds into
`/var/lib/blitz/repo-clone.log`. A template with a private repo and a member
with no grant fails there, silently, ten minutes after create. Refuse the
create instead, and name the reason.

### 7. Template screen

`packages/webapp/src/files/CreateTemplateScreen.tsx` already renders
`TemplateConnectionsSection` and a `Repositories` section together, and its
comment already states the rule this plan depends on: "A template references
providers by name. It never carries a grant."

Add a `TemplateRepoPicker.tsx` beside `TemplateRepoUrls.tsx`, sharing the same
`value: string[]` / `onChange` contract. `TemplateRepoUrls.tsx:139` already
anticipates a second input against the same value.

Three states:

- **No grant.** "Connect GitHub" to
  `/connect/github/start?returnTo=template-new` (or `template-edit:<id>`). The
  member returns to this screen, not to settings; see §3b.
- **Grant, no installations.** Show the install link,
  `https://github.com/apps/blitzosauth/installations/new`, and say plainly that
  a GitHub org owner must complete it. Offer a Refresh button; there is no
  redirect back, so the screen must be able to re-check on demand.
- **Grant and installations.** Search, filter by account, private badge,
  checkboxes, cap 16 shared with the URL box.

Update the section copy. It reads "Public repos cloned into /workspace at
start", which stops being true.

Keep the URL textarea. It is the fallback for an org that will not install.

### 8. Create dialog

`CreateWorkspaceDialog.tsx` selects a template and nothing else today. When the
selected template carries a private repo and the member has no live GitHub
grant, show Connect before create, and block create until it resolves. This is
the check §6 makes possible.

Connect goes to `/connect/github/start?returnTo=workspace-new`, so the member
lands back on the create route with the dialog open. Never in settings.

**Draft state across the redirect.** Both surfaces send the browser to
github.com and back, so in-progress form state is lost unless something holds
it. The template screen is the one that hurts: a name, a machine type, attached
folders and files, and a repo list, all discarded because the member clicked
Connect. Persist the draft before the redirect — `sessionStorage` keyed by
route is enough, since the round trip is same-tab and short-lived — and restore
it when `connect=` is present on the return. The workspace dialog carries less,
but the selected template id must survive for the dialog to reopen correctly.

This is the one place where a redirect-based connect is worse than a popup. If
the draft restore turns out to be awkward, a popup window on `/start` with a
`postMessage` on return is the alternative, and it keeps the opener's state
intact. Decide before building §7.

## Order

2 → 3 → 4 → 7 gives the admin the picker end to end and is testable without
touching the clone path. 5 → 6 → 8 then makes a private repo actually reach a
box. 1 gates everything and costs nothing.

## What this does not solve

- **The identicon badge.** A user token marks API-created content with the
  App's identicon beside the member's avatar, and there is no setting to
  disable it. Commits and pushes are expected to be unmarked, because a commit
  is a git object rendered from the author email and carries no app field, but
  this was **not** verified against a live token. Settle it before build with
  one throwaway install: push a commit, open a PR, compare.
- **An org that refuses to install.** The paste path stays for them, with all
  of its per-member approval cost.
- **The intersection rule.** A member who cannot open a repo the install covers
  still cannot open it. This is correct behaviour, and it is the reason the
  abandoned plan's rewrite of the picker to list the caller's own repos was
  "a better answer as well as a necessary one". This plan keeps that property:
  every listing endpoint here is answered by the member's own token.
- **Commit signing.** No Verified badge, unchanged either way.
- **Reinstall and revoke.** An org that uninstalls silently empties the picker.
  `GET /user/installations` returning fewer accounts than the template's repos
  require is the detectable signal; nothing acts on it yet.

## The ruling this reverses

`GITHUB-ORG-PATH.md` §7 records the owner's reasoning: "an org-level GitHub
credential attributes every commit to itself, which is the opposite of what the
attribution work is for."

That is true, and this plan does not contradict it. It never creates an
org-level credential. What it reverses is the wider conclusion that the App
must go with it. The App has two halves, and only the installation-token half
carries the attribution problem the ruling names.

The second stated reason — "no App to register per deployment" — was about the
Setup URL, and it no longer applies once no install callback exists.

The cost that remains is real and should be weighed openly: one org owner must
install the App before any member of that org can pick a private repo. That is
one action per org against today's one approval per member.

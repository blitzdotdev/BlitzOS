# Org self-serve: create a second organization, leave the current one

Status: shipped. Amends `plans/IDENTITY.md` (see §7).

## 1. The gap, precisely

Two things a signed-in member cannot do today.

### 1.1 Create a second organization

`POST /orgs` refuses any caller who already belongs to an org.
`packages/control-plane/core/identity/routes.ts:161-171`:

```ts
router.post("/orgs", async (context) => {
  const principal = await requirePrincipal(context);
  if (principal.membershipId !== null) {
    throw new HttpError(409, "an active membership already exists");
  }
```

The guard repeats twice more inside the route: a second `SELECT ... FROM
memberships WHERE user_id = ?1 AND status = 'active'` check, and a
`WHERE NOT EXISTS (...)` clause on the `INSERT INTO orgs`. The session
rebind at the end only fires `WHERE ... membership_id IS NULL`.

Test `packages/control-plane/test/identity.test.ts:120-124` pins the 409.

`packages/webapp/src/components/CreateOrgPage.tsx` is a full-page form.
`CloudApp.tsx:1497-1508` renders it only when `identityOnly !== null`, that
is, only for a session with no membership at all. Nothing in the app reaches
`createOrg` after onboarding.

The organization menu in the rail
(`packages/webapp/src/files/DriveRail.tsx:144-160`) lists the current org
and one switch button per other membership. It has no create entry.

So a second org can only appear through an invite from an existing admin.
A user cannot start one.

### 1.2 Leave an organization

There is no route. The identity surface is `/me`, `POST /orgs`,
`GET /members`, `PATCH /members/:id`, `GET|POST|DELETE /invites`,
`DELETE /sessions`, `POST /sessions/switch-org`. None of them removes the
caller from an org.

`PATCH /members/:id` is admin-only (`requireOrgAdmin`,
`core/identity/members.ts:23-29`) and has no self check, so an **admin** can
already disable their own membership by passing their own id — an
undocumented and unlabelled back door. A plain **member** has nothing.

The webapp has no leave control anywhere. `SettingsPage.tsx` renders
Profile, Members, Invites, Connections, Requests, Usage.

### 1.3 What already works

Multi-org is not new plumbing. It is finished on both sides except for the
two entry points above:

- `GET /me` returns `organizations[]`, every active membership of the
  caller (`core/identity/routes.ts:100-131`).
- `POST /sessions/switch-org` rebinds the session row to another active
  membership (`core/sessions.ts:30-51`), tested at
  `test/identity-phase2.test.ts:427-470`.
- The rail menu renders the switch buttons and `CloudApp.tsx:1431-1433`
  calls `client.switchOrg(...)` then reloads.
- Invite redemption already creates a second membership for an existing
  user (`core/identity/invites.ts:110-125`, `ON CONFLICT(user_id, org_id)`).

This proposal adds the two missing doors, and nothing else.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Leave when you are the only active member | Refuse, 409. Delete-organization is separate later work. |
| Leave when you are the only active admin but others remain | Refuse, 409. Mirrors the existing last-admin rule. |
| Where the leave control lives | Settings → Members, danger row at the bottom. |
| What happens to the leaver's workspaces | Nothing. Same as an admin disable today. |
| Unlimited org creation | Capped. See §3.3. |

## 3. Server design

### 3.1 `DELETE /members/self`

New route in `core/identity/members.ts`. The `self` segment matches the
house pattern (`/orgs/self/usage-capture`, `/workspaces/self/connections`).

Behaviour, in order:

1. No active membership → `403 active membership required`.
2. Caller is the only active member of the org → `409 the last member
   cannot leave the organization`.
3. Caller is `admin` and the only active admin, other active members
   remain → `409 promote another admin before leaving`.
4. Otherwise, one transaction:
   - `UPDATE memberships SET status = 'disabled'
      WHERE id = ?membership AND status = 'active' RETURNING id`, with both
     guards repeated as subqueries so a concurrent request cannot slip past
     the checks above. This mirrors `PATCH /members/:id`.
   - `rebindSessionsOffMembership(...)` — see §3.6.
   - Every row must return exactly what is expected, else `409`, matching
     the `POST /orgs` and invite-redeem style already in the file.
5. Response `204`. The webapp reloads and asks `/me` where it now stands, so
   there is one source of truth for "which org am I in" rather than two.

**Why `status = 'disabled'`, not `DELETE`.** Ten tables hold
`NOT NULL REFERENCES memberships(id)`: `invites.created_by_membership_id`,
`workspace_grants.membership_id` and `.granted_by_membership_id`,
`folders.created_by_membership_id`, `folder_grants.membership_id` and
`.granted_by_membership_id`, `folder_attachments.attached_by_membership_id`,
`workspace_templates.created_by_membership_id`,
`recipes.created_by_membership_id`, `volume_ownership.created_by_membership_id`.
`PRAGMA foreign_keys = ON` is set in `migrations/0001_initial.sql`. A delete
either fails the constraint or needs a ten-table cascade that destroys other
people's audit trail. `disabled` is the state the codebase already means by
"this person is out": `findSessionPrincipal` rejects a session whose
membership is not `active` (`core/principals.ts:66`), `activeMembership`
skips it at login, `webAppWorkspaceForRequest` joins on `m.status = 'active'`.

**No new column for "left" versus "removed".** An earlier draft added
`memberships.left_at` so the member list could say "left" instead of
"disabled". It was cut: `status` already carries the only fact any code reads,
and a second column plus a wire field plus a schema-drift change bought one
label. `disabled` is not a lie about access, only less specific about cause.

**Rejoining needs no new code.** Invite redemption already does
`ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role,
status = 'active'`, so an admin re-inviting a leaver reactivates the same row.
Old workspace and folder grants come back with it — exactly what admin
disable-then-enable does today. Pinned by a test.

**Owned resources stay put.** Workspaces, templates, recipes and folders keep
pointing at the disabled membership. `canControlWorkspace` then matches only
on `principal.role === "admin"`, so the org admins inherit control and normal
members lose it. `migrations/0011` set `owner_membership_id = NULL` for a
comparable case; this proposal does not, because a disabled membership is
still a real row and the owner name still resolves for display.

### 3.2 `POST /orgs` for an existing member

- Drop all three "already a member" guards.
- Rebind the calling session unconditionally: `UPDATE sessions SET
  membership_id = ?new WHERE token_hash = ?1 AND principal_id = ?2`, so the
  caller lands inside the org they just made, like a switch.
- Response shape unchanged: `201 {org, membership}`.

### 3.3 Cap on self-created orgs

Every org carries `vm_limit` (default `DEFAULT_ORG_VM_LIMIT = 10`) and
workspace creation enforces it per org (`core/workspaces.ts:452`). Today's
409 accidentally caps a user at one org, so it also caps them at 10 VMs.
Removing the 409 without a replacement lets any signed-in account mint
unlimited VM quota by creating orgs in a loop. That is a hole this change
would open, so it is closed in the same change.

- `orgs.created_by_user_id TEXT REFERENCES users(id)` — nullable,
  `ALTER TABLE ADD COLUMN`, existing rows stay `NULL` and count against
  nobody.
- `MAX_SELF_CREATED_ORGS = 5` next to `DEFAULT_ORG_VM_LIMIT` in
  `core/identity/orgs.ts`.
- `POST /orgs` refuses with `409 organization limit reached` when
  `SELECT COUNT(*) FROM orgs WHERE created_by_user_id = ?1` is at the cap.
  The count is of orgs *created*, not orgs *joined*: invites stay unlimited,
  because an admin already vouched for that quota.

Five is a starting number, not a researched one. It is a single exported
constant, easy to raise. The count-then-insert is not atomic; two racing
requests can land a sixth org. That is a soft quota, not an access control,
so it does not get a lock.

### 3.4 Migration `0029_org_created_by.sql`

```sql
ALTER TABLE orgs ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
```

One additive column. No table rebuild, no backfill, no data loss on rollback.
No index: `POST /orgs` is a rare route and the count runs over a small table.

### 3.5 Wire

Unchanged. `DELETE /members/self` answers `204` and `POST /orgs` keeps its
existing `201 {org, membership}` body, so nothing crosses `packages/schema`
and `test/wire-drift.test.ts` has nothing new to check.

### 3.6 One rebind statement, shared by leaving and being removed

`PATCH /members/:id` with `{"status":"disabled"}` already removed a member
before this change, and Settings → Members already rendered it as a **Disable**
button. What it never did was touch the `sessions` table. Measured:

```
PATCH /members/<id> {"status":"disabled"}   →  200
that person's GET /me                       →  401 unauthorized
```

— a hard 401 even when they belonged to a second org, so being removed logged
them out of the whole product until they signed in again. `DELETE
/members/self` would have had the same bug, so both paths take one statement:

```sql
UPDATE sessions SET membership_id = (
  SELECT id FROM memberships
  WHERE user_id = sessions.principal_id AND status = 'active'
  ORDER BY rowid DESC LIMIT 1
)
WHERE membership_id = ?1
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE id = ?1 AND status = 'active')
```

`rebindIdentityOnlySessions` is the counterpart on **Enable**: without it a
re-enabled member sits on the create-org page holding a membership they cannot
see. It only touches sessions with no membership at all, so being re-enabled in
one org never drags you out of another.

**The `NOT EXISTS` is the statement's own precondition, not caution.** Both
helpers ship in the same batch as the status change, and that change carries
SQL guards a concurrent membership edit can still fail. A batch runs every
statement it was given, and the route's 409 is thrown afterwards in JS — so
without the clause, a *refused* leave would still bump the caller out of an org
they are, in fact, still in. Each statement therefore states its own
precondition and depends on no ordering.

Both helpers are module-private in `members.ts`, where all their callers are.

## 4. Webapp design

### 4.1 Create organization, in the rail menu

`DriveRail.tsx`, at the end of `.webapp-org-menu`, after the switch buttons:

```tsx
<button
  className="webapp-org-menu-create"
  type="button"
  role="menuitem"
  onClick={() => { setOrgMenuOpen(false); onCreateOrg(); }}
>+ Create organization</button>
```

`onCreateOrg` is a new `DriveRail` prop. `CloudApp` holds
`showCreateOrg` state and renders a `CreateOrgDialog` in `railOverlays`,
next to `createWorkspaceDialog`. On success it reloads, exactly as
`onSwitchOrg` does, because the session is now bound elsewhere.

The dialog uses `ModalOverlay` (Escape, backdrop dismiss and focus return
already live there) and shares its form with the onboarding page: extract
the name field plus submit into `components/OrgNameForm.tsx`, then
`CreateOrgPage` becomes that form inside `.login-screen` and
`CreateOrgDialog` becomes the same form inside `ModalOverlay`. One form,
one validation rule, two frames.

**CSS.** `.webapp-org-menu-switch` in `DriveRail.tsx:152` has **no rule** in
`webapp-shell.css` today — the switch buttons render on the browser default
button box inside a styled menu. That is a live bug this work sits on top of,
so `webapp-shell.css` gains `.webapp-org-menu-switch` and
`.webapp-org-menu-create` in the same change. The create row separates itself
with a `border-top`; a separate divider element would have been a second way to
draw one line.

### 4.2 Leave organization, in Settings → Members

At the bottom of `MembersPanel`, below the people list:

```tsx
<div className="settings-danger">
  <div>
    <strong>Leave {orgName}</strong>
    <span>You lose access to this organization's workspaces and files.</span>
  </div>
  <button className="webapp-action webapp-action--danger" type="button"
          disabled={soleMember} onClick={...}>Leave</button>
</div>
```

- The click opens the existing `ConfirmationDialog`, the same component the
  workspace delete uses. Title `Leave <org>?`, confirm `Yes, leave`.
- `soleMember` is derived from the loaded member list: exactly one member
  with `status === 'active'`. The button is disabled with the reason shown,
  so the person is told *before* clicking, not by a 409 afterwards.
- The server 409s are still rendered into the panel's existing `error` slot.
  The client-side disable is a courtesy; the server is the authority.
- `MembersPanel` takes two new props, `orgName` and `onLeft`, from
  `SettingsPage` → `CloudApp`.
- On success, `onLeft` reloads. The next `/me` returns either the next org,
  or `membership: null` which routes to the onboarding create-org page.

### 4.3 Members list wording

Unchanged. A member who left reads as `· disabled`, the same as one an admin
removed. See §3.1 for why that stayed as it is.

## 5. Evidence

Every test below was seen to fail with the source change reverted and the
test kept, then seen to pass with the change in place.

### Control plane, `test/identity-phase2.test.ts` (8 new)

| Test | What it pins |
|---|---|
| creates a second organization for an existing member and rebinds the session | 201, `/me` scoped to the new org, both orgs in `organizations[]` |
| caps the organizations one user creates, and never caps invited ones | five creates pass, the sixth is 409 `organization limit reached`, an invited org still switches |
| leaves an organization and lands every session of that user on the next one | 204, the row is `disabled`, both of that user's sessions follow to the other org, `GET /members` no longer serves the org that was left |
| leaves the only organization into an identity-only session, not a 401 | `/me` returns 200 with `membership: null`, and org routes answer 403 |
| refuses the last member and the last active admin leaving | both 409s by message, the row stays `active`, and the same request succeeds once a second admin exists |
| reactivates a left membership when an admin re-invites the person | the invite callback flips the same row back to `active` |
| moves a disabled member's sessions off the org, and hands them back on enable | after `PATCH {status:"disabled"}` that person's `/me` returns their other org rather than a 401; re-enabling does not drag them back out of it |
| leaves a disabled member with no other org on onboarding, and restores it on enable | `/me` returns 200 with `membership: null`, and the same session picks the org back up when an admin re-enables them |

### Control plane, `test/identity.test.ts` (1 rewritten)

`gates create-org to an identity-only session and rebinds that session`
became `creates an org from an identity-only session and rebinds that
session`. Its two 409-on-second-org assertions pinned the behaviour this
change removes; leaving the old name over new behaviour would be a name that
lies.

### Webapp, `test/shell-smoke.test.tsx` (3 new)

These drive the whole shell, not an isolated component: a real `CloudApp`
render, a real click on the rail's organization button, the real dialog, the
real settings route.

| Test | What it pins |
|---|---|
| creates a second organization from the rail organization menu | the menu entry exists, the dialog submits the typed name to `createOrg`, and the shell reloads once |
| leaves the organization from settings, once another member exists | Leave is enabled, the confirmation's `Yes, leave` calls `leaveOrg`, and the shell reloads once |
| disables Leave for the only active member of an organization | the button is disabled with the reason in the DOM, a click opens no dialog, and `leaveOrg` is never called — a `disabled` row does not count as company |

### Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | passes, all workspaces |
| control-plane `vitest` | 504 pass. One pre-existing failure: `files.test.ts > deletes grants, every paginated object page, and the folder row` times out at 5s. It fails identically on a clean `origin/main` checkout in the same sandbox. |
| webapp `vitest` | 291 pass |
| `test:scripts`, house-rule tests | 41 and 2 pass |
| `npm run build -w @blitzos/webapp` | passes |
| box-actor `vitest` | 136 passed earlier in the same session. Later re-runs are OOM-killed by the dev sandbox. This change touches no file under `packages/box`. |
| `npm run lint:gate` | could not run. `oxlint` aborts with `SIGABRT` inside this sandbox (`oxc_allocator/src/pool/fixed_size.rs:112`), on a clean `origin/main` checkout as well. CI runs it. |

### What was not verified

**The `NOT EXISTS` precondition in §3.6 has no test.** It only matters when a
concurrent membership edit makes a route's SQL guard fail after its JS check
passed, and both reads happen inside one request, so a single-threaded test
harness cannot open that window. The clause is one line, is correct when the
window never opens, and removes the dependency on batch ordering.

No browser click-through. The control plane runs on Cloudflare and the
sandbox has no local D1 or Google OAuth, and deliberately holds no canary or
production credentials. The automated tests cover the wiring; the new CSS
(`.settings-danger`, `.webapp-org-menu-create`, `.create-org-dialog`) was
checked by rendering the real component markup against the real built
stylesheet, not by a person looking at the running app. A reviewer should
look at the three surfaces before merge.

## 6. What this does not do

- No delete-organization. An org left with zero members cannot happen under
  §3.1 rule 2, so nothing is stranded, but a solo owner still cannot dispose
  of an org they no longer want. That needs a destroy cascade over
  workspaces, volumes, folders, templates, recipes and connections, and it
  is its own piece of work.
- No ownership transfer. A leaver's workspaces pass to the org admins by the
  existing `canControlWorkspace` rule, not by a rewrite of
  `owner_membership_id`.
- No org rename, no `vm_limit` editing, no billing.
- No change to invites, to `switch-org`, or to the login membership pick.

## 7. Amendment to `plans/IDENTITY.md`

`plans/IDENTITY.md` recorded the decision that `POST /orgs` is "gated to
users with no active membership". This change reverses that gate
deliberately, and edits the plan text in the same commit. The reason: the
gate was a signup-flow guard, and it was also — by accident — the only cap on
per-user VM quota. §3.3 replaces the second job explicitly so the first can
be dropped.

## 8. Change inventory

| File | Change |
|---|---|
| `control-plane/migrations/0029_org_created_by.sql` | new, one column |
| `control-plane/core/identity/orgs.ts` | `MAX_SELF_CREATED_ORGS` |
| `control-plane/core/identity/routes.ts` | `POST /orgs`: drop the membership guards, add the cap, always rebind |
| `control-plane/core/identity/members.ts` | `DELETE /members/self`, the two rebind statements, `PATCH` now transactional |
| `webapp/src/api.ts` | `leaveOrg()` |
| `webapp/src/components/OrgNameForm.tsx` | new, the one org-name form |
| `webapp/src/components/CreateOrgPage.tsx` | reduced to a frame around it |
| `webapp/src/components/CreateOrgDialog.tsx` | new, the other frame |
| `webapp/src/files/DriveRail.tsx` | create entry + `onCreateOrg` prop |
| `webapp/src/CloudApp.tsx` | dialog state, `onCreateOrg`, `onLeftOrg` |
| `webapp/src/SettingsPage.tsx` | pass `orgName` and `onLeft` |
| `webapp/src/settings/MembersPanel.tsx` | danger row + confirmation |
| `webapp/src/webapp-shell.css` | org menu switch and create rows |
| `webapp/src/webapp-base.css` | create-org dialog and form actions |
| `webapp/src/settings.css` | danger row |
| `plans/IDENTITY.md` | amend the create-org gate decision |

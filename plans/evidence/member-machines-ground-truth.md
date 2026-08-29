# MEMBER-MACHINES — ground truth survey

Recorded 2026-08-28 against `main` @ cbf9a1fb, by five parallel read-only
sweeps (compute, identity, box/sessions, webapp, credentials). Facts below are
file:line grounded; each section ends with the gaps that build must close.

## Build 1 — member machines (compute + identity)

**The workspace row is the VM record.** `vm_id`, `volume_id`, `ssh_*`,
`phone_home_*`, `tunnel_id`, `compute_credential_source`, `machine_type_id`
are single-valued columns on `workspaces` (migrations 0001, 0004, 0006, 0032,
0038). `boxes.workspace_id` is `UNIQUE` (0001:47) — a hard one-box cap.
`phase` is a workspace-level state machine.

**One create path.** `performWorkspaceCreate`
(`core/workspaces.ts:460-827`): placement (`compute/workspace-placement.ts`),
the `vm_limit` gate inside the INSERT (`workspaces.ts:605-608`), volume
provision (`workspace-volumes.ts:74-124`), `createVm`
(`compute/hetzner.ts:454-478`, server name `blitz-<workspaceId[0:12]>`),
phone-home completes it (`workspaces.ts:1210-1298`). Destroy:
`workspaces.ts:1123-1208`. Janitors: `core/janitors.ts` (orphan sweep
:41-121, tunnel :174-199, volume retention :136-172) — all iterate
`workspaces` rows.

**No resize exists.** `VmProvider` (`compute/types.ts:59-92`) has only
create/shutdown/destroy/inspect. Recreate refuses a machine-type change
(`workspaces.ts:919-923`). D2's auto-upgrade needs a new provider capability.

**No lifecycle hooks.** Invite redemption (`identity/invites.ts:142-216`)
returns a membershipId that nothing observes. `POST /invites`
(`invites.ts:260`) has no membership row to key a machine to —
provision-at-invite needs a machine keyed by `invite_id`, re-keyed at
redemption. Leave/disable (`identity/members.ts:158-262`) flips status only;
the leaver's workspaces stay (comment :145-157). `expireInvites`
(`invites.ts:89`) has no side effects and is not in the lazy sweep.
`memberships.status='invited'` is a dead enum value (written nowhere).

**Invites are org-scoped, not workspace-scoped** (0009_identity.sql:30). The
Discord model ("invited to a workspace") has no carrier. There is no
workspace membership at all: `workspace_grants` is a sharing ACL
(editor|viewer), `org_share_role` is a workspace-wide default, org admins
reach everything (`workspace-access.ts:30-45`). The machine row can *become*
workspace membership.

**Accounting.** `vm_limit` is enforced only in the workspace-create INSERT;
`vmsUsed` counts workspaces (`entitlements.ts:334-336`). Both under-report
under machine-per-member. The wire contract is pinned by
`packages/schema/fixtures/entitlements/` shared with the private billing
service — changes ripple there. Seat gate: `seatAvailable` fragment injected
into identity SQL (`entitlements.ts:112`), independent of the VM gate today.

**Branch state.** PR #104 (trials, operator console, migration 0040,
`core/admin.ts`, `/admin` page) is NOT on main. Migration numbering: next
free is 0040 and #104 claims it; 0008 and 0036 are already duplicated.
No invite mailer exists (link is pasted from `InvitesPanel.tsx:83`).

## Build 2 — sessions as objects (box)

**A session today is a tmux session with no record anywhere.**
`blitz-term <type> <key> [ro]` (`box/rootfs/usr/local/libexec/blitz-term`)
creates `claude-<key>` etc. with `tmux new-session -A`; the key is the
browser-invented integer tab id from the shared `webapp_state.doc` blob
(`core/webapp-state.ts:34-46`; monotonic-id safety note :456-463; "shared
state, all accounts see one tab set" :352-356). Any editor can attach to any
key. No listing endpoint, no liveness, no owner, no transcript persistence
(harness-native transcripts live on the state volume, unindexed).

**The ACP actor is a near-complete session object, flagged off.**
`box/actor/src/{actor,chat-session}.ts`: SQLite journal
(`/var/lib/blitz/chat-session.db`), id, provider, cwd, `created_by`,
resume_id, replay, N-subscriber fan-out with per-frame `{userId, name}`
attribution, viewer write-gate (`actor.ts:419`). Webapp flag
`NATIVE_CHAT_ENABLED = false` (`src/product-features.ts:7`).
`plans/COCKPIT-UI-RESTORATION.md` records the deliberate retreat and the
decision list required to reverse it. `plans/ENTRYPOINTS.md` already argues
"one session, many subscribers".

**The identity spine exists.** WebApp ticket claims
`{workspaceId, userId, membershipId, role, exp}` (`core/webapp-tickets.ts`),
verified in the Worker, the Go gateway (`gateway/main.go:938-951`), and the
actor (`actor/src/auth.ts`), pinned by fixtures. Read-only attach is real and
defended at four layers (`blitz-term:56-65` refuses create; viewer gates in
CP/gateway/actor). `/admin/drain` targets a membership on both box services.

Gaps: a control-plane `agent_sessions` table (`sessions` is taken by auth
cookies), server-issued unguessable session keys, a liveness channel,
per-session authorization, terminal transcripts, and replacing the
last-write-wins blob (not polled; teammates never see each other's tabs).

## Build 3 — sharing (credentials attribution)

**Mints resolve against the workspace owner, by design.** `mint.ts:243`
(`grantFor(db, workspace.owner_id, name)`; rationale comment :111-113);
`boxes.principal_id` = owner at phone-home (`workspaces.ts:1252-1256`);
lease comment `leases.ts:32-35`. Two editors produce byte-identical audit
rows. The disclosure banner CONNECTIONS_UX §1 promised was never built.
Under machine-per-member this inverts naturally: each box's principal becomes
the member; the mint's grant-resolution must follow the machine's member,
not the workspace owner.

## Build 4 — surfaces (key manager, rules, drive)

**No workspace-scoped sealed secret store exists.** `connections` is
org-scoped (0010:39); `workspaces.environment` is per-workspace but
plaintext (0017; `core/environment.ts`) and lands in `creds/env.d/*.sh`
visible to every shell. The org-static path is being *removed*:
`validateServedConnection` (`registry.ts:314-317`) refuses `adminForm: null`
providers; migration 0028 deleted the `generic` catalog entry with the
ruling "ad-hoc secrets are a workspace file or `.env`". **The key manager
reverses that shipped ruling — name it in the plan.**

**Injection-at-use has a seam.** `ClaudeAdapter.canUseTool`
(`adapters/claude.ts:121-140`) already receives tool name/input and returns
`updatedInput` (currently a pass-through). The git credential helper
(`internal/workspace/cp.go:84-108`) is the working point-of-use precedent.
Today's `blitz-cred get/env` print values to stdout and the baked agent
rules teach that idiom (`skel/agent-rules.md:67,75`).

**No use audit.** `credential_events` records mint/revoke/deny/approve only;
the proxy (`connections/proxy.ts`) writes zero rows. No session dimension
exists anywhere in the credential plane.

**Agent rules layering mostly exists.** Baked skel file overwritten each
boot (`blitz-init-state:63-67`), `blitz-rules sync` against
`GET /workspaces/self/agent-rules`, org-authored `agent_rules` (0018)
selected per workspace/template. Missing: per-role layering and the D4
ruling text.

**Roaming.** Harness logins already roam per member via the broker
(`broker_members`, 0020; `member_cap` 25, 0019). Grant refresh races are
known-unfixed (`catalog/github.ts:18-21`) and get worse with N machines per
member. GitHub is `custody: "cp"` — the real token reaches the box.

## Webapp overhaul

Shell is already three columns (`drive-shell.css:270-278`): DriveRail |
work | icon strip. `DriveRail` (`files/DriveRail.tsx`, 399 lines) conflates
org header, global nav, workspace list, and the active workspace's sessions
— the overhaul splits it into strip + session rail. Survives unchanged: pane
algebra (`workspace-panes.ts`), tab model (`storage.ts`), content surfaces
(terminal, editor, files, previews, connections), data layer. Net-new: the
launcher (no palette exists). Dormant asset: `src/chat/*` (~2,000 lines,
tested) behind the flag.

Risks, ranked: `CloudApp.tsx` is 2,265 lines and on the max-lines debt list
— split before visual work ("split on touch, never big-bang"); `railFor` is
threaded through 8 route branches; `feat/operator-console` touches the same
three files (land or rebase it first); mobile is a parallel implementation,
not responsive CSS; ~20 test assertions target class selectors (migrate to
role/label queries first); 17 global stylesheets with cross-file overrides.

## Stale plan docs (cheap fixes while here)

`CREDENTIALS.md` ("no code exists yet" — false, and its delivery model was
rewritten), `CREDENTIAL-ROAMING.md` ("plan" — shipped in #4),
`GITHUB-APP-USER-TOKEN.md` ("plan" — shipped in #90), `CONNECTIONS_UX.md`
(§0 audit table stale). `CONNECTIONS-FLOW.md` is cited by migration 0028 but
does not exist.

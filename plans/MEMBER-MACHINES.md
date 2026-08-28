# MEMBER MACHINES — the workspace is a server, and every member gets a machine

Written 2026-08-28, grounded against `main` @ cbf9a1fb. Supersedes
`plans/MULTI-MEMBER-BOX.md` (PR #91): that plan solved multi-member identity by
splitting one shared box into Linux users. This plan removes the shared box
instead. UI mockup: `plans/mockups/session-rail.html`, live at
https://blitzos-session-rail.app.blitz.dev/.

```
org
 └─ workspace "engineering"          admin creates it; picks the machine type
     ├─ SHARED, owned by the workspace
     │    drive · key manager · agent rules · repo list · session rail
     │
     ├─ member M ── machine (8 GB, always on) ── M's sessions
     ├─ member A ── machine (8 GB, always on) ── A's sessions
     └─ member R ── machine (8 GB, always on) ── R's sessions
```

## 0. The idea

A workspace works like a Discord server. An admin creates it. Members are
invited to it. A member joins, opens the rail, and starts a session. The
session inherits the workspace's agent rules, reads its shared drive, and can
use its static service keys. Nobody thinks about machines.

Behind the curtain, every member of a workspace owns one always-on VM, sized
by the workspace's machine type, provisioned when the invite is sent, and
destroyed when the member leaves. The machine never appears in the product.
There is no create screen, no wake button, no cold start, and no sleep state.

This dissolves nearly every problem the shared-box plan had to manage:

| MULTI-MEMBER-BOX problem | Fate here |
| --- | --- |
| Members act as the workspace owner (silent misattribution) | Gone. One member per machine; the machine is the identity. |
| Per-member Linux users, user-aware `blitz-cred` (Build 2) | Not needed. The kernel isolates nothing because it holds one member. |
| Per-member git clones seeded on join (Build 3) | Each machine clones the workspace repo list on provision. |
| One member's build starves another's session | Gone. Resource pressure is per member by construction. |
| A viewer reads another member's tokens in session output | Static keys are injected at use and never enter transcripts (§4). Personal tokens exist only on the owner's machine. |
| Attribution for shared files | Every drive write is a session event with an owner (§4). |
| One box is one blast radius | A host failure blips one member, not the org. |

What survives from the old plan: the role names (admin, editor, viewer), the
capability framing ("you propose changes with a pull request", never "you
cannot write here"), and the trust ruling that the control plane believes the
machine about which member a session belongs to — now trivially true, because
each machine holds exactly one member.

## 1. Ground truth

| Fact | Where | Consequence |
| --- | --- | --- |
| A workspace today is one VM plus one volume, created from a golden image on platform credentials or stock Ubuntu on BYOK | #88, #93, `plans/SUBSCRIPTION-COMPUTE.md` | The unit changes from machine-per-workspace to machine-per-member. Provision, destroy, and the janitors all keep working per row; there are just more rows. |
| Orgs, invites, and seats exist; seat refusal has a way out | #56, #84, #86 | The invite is already the join primitive. This plan attaches a provision to it. |
| The entitlements seam writes integers only: `seat_limit`, `vm_limit`, `platform_compute`, `trial_expires_at` | #62, #93, #104 | No new seam is needed. `vm_limit` changes meaning (§2 D6). |
| Sponsored trial orgs exist: platform compute, a trial clock, seat and VM caps, janitor downgrade | #104 | The trial is the only non-BYOK free path. This plan inherits it unchanged. |
| A workspace owns its repo list, App-only; private repos clone through a GitHub App user token | #92, #90 | Repo read at join and per-member authorship are already split the way §3 needs. |
| The control plane has no session object; a session is a process on the box that the webapp attaches to | verify in `packages/box`, `packages/webapp` | Build 2 creates the session as a first-class row. This is the largest new surface. |

## 2. Load-bearing decisions

**D1 — One machine per (workspace, member), provisioned on invite.** The
invite provisions the machine, so the member's first click lands on a running
box. An unredeemed invite is reclaimed by a janitor after 14 days (a CX32 held
14 days costs ~$4 — acceptable, and the trial VM cap bounds it). Leaving or
removal destroys the machine after a grace snapshot. This closes the
orphaned-member limit of the old plan: offboarding is machine destruction.

**D2 — The workspace machine type is the only sizing input.** The admin picks
it at workspace creation: 8 GB (engineering class) or 4 GB (light). Every
member machine inherits it. Sustained memory pressure upgrades that member one
tier automatically — a 30–40 s resize the member sees as "your machine is
growing" — and the admin can pin sizes. Nobody else ever sees a gigabyte. The
4 GB / 8 GB split is worth ≈$4/month across a 10-person org, so it is a
right-sizing gesture, not a cost control; collapsing to one size later is fine.

**D3 — Always on.** Machines run 24/7 with provider backups. No sleep state,
no wake flow, no warm pool, no herd math. The mockup's "asleep workspace" pane
is deleted, not built. Cost analysis (§6) shows the whole 10-person org lands
under $90/month infrastructure — noise at the intended price point.

**D4 — Attribution follows the credential.** Two credential planes:

- *Workspace keys* (the key manager): static service keys — Stripe test keys,
  Sentry DSNs, staging API keys. Any member's session can use them per role.
  The audit line names the session and its owner. The broker injects them at
  the point of use; they never appear in a transcript, so a watchable session
  is not a leak. This retires the old plan's open question 1 by construction.
- *Personal OAuth* (GitHub, model keys): acts as the member, exists only on
  that member's machine, is never inherited and never stored in the workspace.

One ruling on top: workspace-supplied context — agent rules, drive content —
never *authorizes* a personal-credential action. An action that spends a
member's own token takes its authority from that member's own turns. This is
the guardrail against cross-member prompt injection through shared content,
and it must be stated in the agent rules the box ships with.

**D5 — Sessions default to workspace-visible.** Joining the server means
seeing the work. Private is the deliberate exception, not the default — the
inversion of the old plan, made safe by D4. Visibility levels: private,
workspace-read, workspace-read-and-send.

**D6 — `vm_limit` counts member machines, so it converges on seats.** Under
machine-per-member, VMs ≈ seats × workspaces-per-member. The billing service
keeps writing the same two integers; the operator console's trial defaults
change from "5 seats, 2 VMs" to VM caps sized for seats × expected
workspaces. No schema change; a semantics note in the console.

**D7 — Free plan is BYOK twice.** A free org brings its own compute
credential (existing `byok-required` path) and each member brings their own
model key (a connection, like GitHub today). The platform pays for neither.
The single exception is the sponsored trial org from #104: platform compute,
capped seats and VMs, a trial clock, janitor downgrade. Paid orgs run on
platform compute (#93) with machines included in the seat price.

**D8 — A "send" turn runs on the owner's machine, as the owner.** Guest turns
execute with the session owner's identity; the transcript attributes the turn
to the sender; a commit born from a guest turn carries a `Co-authored-by`
trailer. The escape valve for a member who wants their own identity is Fork:
copy the transcript to your own machine and continue as yourself. Fork copies
the transcript plus a fresh clone at the session's base commit — never the
owner's uncommitted tree.

## 3. When a member joins

1. An admin invites them. The machine provisions in the background.
2. The member opens the workspace and sees the session rail — teammates'
   sessions are already visible (D5), so the first screen is the team working.
3. Their machine already holds the golden image, the workspace repo list
   (cloned via the workspace's App installation, #92), the drive mount, and
   the agent rules. They start a session and work.
4. Personal connections (GitHub authorship, model key on free plans) are asked
   for at the moment of first need, not as a join gate. A member who never
   pushes never connects GitHub.

Step 4 is the day-one fix: the workspace grants *read* of the code through its
own App installation, so a new member is productive before any OAuth dance.
Only authorship waits for their own connection.

## 4. The rail UI

The mockup (`plans/mockups/session-rail.html`) is the spec for the overhaul.
Three columns:

**Column 1 — the strip.** Org mark, then workspace tiles (the "servers"), a
live-dot on tiles with running sessions, then surfaces: Drive, Ports,
Connections, and (admin only) Keys and Members. The member's avatar at the
bottom. Workspace tiles never show RAM, state, or any machine word.

**Column 2 — the rail.** The active workspace's sessions. Row = gutter ·
title · time, never more. The time is the status: green means live. The
gutter is empty for your own sessions and a face for a teammate's. "New
session" is a pinned action above the list, not a row in it.

**Column 3 — the work.** Tabs across the top (sessions and terminals mix; a
teammate's tab carries their face). The session head shows title, owner,
working directory, and visibility; actions are Fork (on others' sessions),
Diff, Share, and overflow. The Share popover offers the three visibility
levels and lists members with what each can do. The composer shows agent
picker, effort, and — when you cannot send — "Ask to send" and "Fork to my
own". The launcher ("What should we build?") offers recipes and a pick-up
list of recent sessions.

Changes to the mockup, forced by the decisions above:

- The **asleep pane and wake button are deleted** (D3). A workspace is always
  ready or it is broken.
- The rail header **drops the RAM label** (D2). It keeps the name and Share.
- **Default visibility flips to workspace-read** (D5). The launcher's status
  line becomes "Runs in engineering · visible to the workspace" and offers
  "make it private".
- The head's run-as line simplifies: sessions always run on the owner's
  machine, so `owner · cwd · visibility` says everything (D8).
- The mockup's `/workspace/site` vs `/home/ana/site` inconsistency resolves:
  every path is on the owner's machine; the drive mounts at one well-known
  path on every machine.

What this removes from today's webapp: the workspace create flow as a member
concern (creation and machine type become admin actions), every machine-type
picker outside admin surfaces, and workspace state chrome (creating,
stuck, wake). The Connections page stays as the personal-OAuth surface. The
Keys panel is new: workspace-scoped static keys, role-gated, with a use-audit
listing sessions, never values.

The drive needs one property the old plan lacked: **history**. Every write
through a session is a named event (who, which session, when), and a file can
be restored to a prior version. This is the answer to "who changed the shared
file" — the session is the attribution unit — and it protects the
least-git-fluent users, who work in the least protected store today.

## 5. Builds

**Build 1 — member machines.** Schema: a machines table keyed by (workspace,
member); workspace `machine_type`; provision on invite, destroy on
leave/removal, janitor for unredeemed invites; auto-upgrade on pressure.
`vm_limit` counts member machines (D6). Done when: an invited member's first
open lands on a running machine, and a removed member's machine is destroyed
with a grace snapshot.

**Build 2 — sessions as objects.** Control-plane session rows: id, workspace,
owner, title (from the first sentence), kind (chat/terminal), live state,
visibility, timestamps. The webapp overhaul to the three-column rail ships
here, reading real rows. Done when: the rail lists real sessions across
members, and resume works from the pick-up list.

**Build 3 — sharing.** Visibility enforcement (D5), live watch, "send" turns
with attribution and the Co-authored-by trailer (D8), Fork. Done when: a
read-and-send session shows the sender on every guest turn, and Fork lands a
copy on the forker's machine.

**Build 4 — workspace surfaces.** The drive with journaled writes and
restore; the key manager with injection-at-use and per-session audit; agent
rules as a workspace object layered under each member's own rules, including
the D4 ruling. Done when: a static key is used in a watched session and never
appears in its transcript, and a drive file shows its change history.

**Build 5 — pricing alignment.** The billing worker translates the paid plan
into the same integers it writes today, with machine-per-seat semantics; the
free-plan model-key connection flow; trial defaults update in the operator
console. Done when: a paid org's invite provisions on platform compute with
no BYOK step, and a free org's member is asked for a model key at first
session start.

Build 1 and Build 2 are independent and can land in either order. Build 3
needs both. Build 4 and 5 are parallel after that.

## 6. Economics

Reference numbers for a 10-person org (5 engineers on 8 GB, 5 light members
on 4 GB), Hetzner Falkenstein CX line, USD at 1.10/EUR:

| Line | $/mo |
| --- | --- |
| 5 × CX32 (engineers), incl. 20% backups | 44.90 |
| 5 × CX22 (light), incl. 20% backups | 25.00 |
| Drive, snapshots, one shared service | ~8.00 |
| **Org total** | **~$78–90** |

Per-seat infrastructure cost: $5–9. Against $100/seat pricing, infrastructure
is 8–9% of revenue. The dominant COGS at that price is model inference, not
machines — which is why D7 makes tokens BYOK on the free plan and why a paid
plan needs either a token allowance with metering or pass-through billing
before any "unlimited" wording ships. A runaway machine is capped by the
provider's monthly price ceiling ($7.50–18/seat); a runaway token bill has no
provider ceiling. Price tokens before polishing machine costs.

Trial exposure (D7): a default trial at 5 seats for 14 days holds at most
~$20 of compute. The operator console's caps are the spend control.

## 7. Open questions

1. **The multi-workspace member.** A person in three workspaces holds three
   machines. Accepted for isolation and simplicity (cost is noise), but the
   personal-connection story must roam: connecting GitHub once must serve all
   their machines. Credential roaming exists as a plan
   (`plans/CREDENTIAL-ROAMING.md`) — reconcile with it.
2. **Send-turn transport.** How a guest turn reaches the owner's machine —
   through the control plane as a relayed instruction, or a direct broker
   channel. Decides latency and the audit shape.
3. **Drive mechanics.** Journaled writes need a mediation layer (drive
   service or synced store). The concept requires history and attribution;
   the mechanism is unchosen.
4. **Migration.** Existing single-box workspaces map to "workspace with one
   member machine" almost for free, but the box's dual role (workspace state
   + member state) must split. Needs its own small plan.
5. **Idle machines on the free BYOK plan.** Always-on machines on a
   customer's own Hetzner key bill the customer 24/7. Do free orgs get a
   dormancy policy (stop after N idle days, 40 s resume), or is always-on a
   paid-plan property? Leaning: dormancy on free, always-on as part of what
   the seat price buys.

## Appendix — decisions from the design review, recorded

- **Per-member always-on was chosen over cheaper designs** (shared
  workspace host; prewarm-by-schedule; split conversation/execution planes;
  microVM substrate) for one reason: nothing to operate and nothing to
  predict, paid for with margin the price point demonstrably has. The
  split-plane design remains the fallback if free-tier scale ever makes
  always-on machines unaffordable; the microVM substrate (`plans/MICROVM.md`)
  remains the endgame that would make per-session isolation cheaper than
  per-member machines.
- **The "machine never goes away" promise moves up a level.** The durable
  thing is the workspace: rail, drive, keys, rules, repo list. Machines are
  cattle behind a curtain — even though each member's machine is, in
  practice, a small well-backed-up pet.
- **The shared box's one advantage was cost, and at these prices the
  advantage does not exist.** The whole per-member fleet costs about the same
  as one always-on shared box sized for the same org.

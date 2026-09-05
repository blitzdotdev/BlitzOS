# WORKSPACE CLONE — making "New workspace from this one" real

Written 2026-09-05, grounded against `main` @ 9d697a3f and the branch that
comments the button out (PR #231). Goal: the footer verb comes back only when
a person who presses it gets the workspace they were shown, and a test says so.

## 0. Where it actually stands

The server side is real and covered. `performWorkspaceCreate`
(`packages/control-plane/core/workspaces.ts:441`) resolves a source with
`cloneSource` (`:418`) and inherits four things from it:

| Inherited | Where |
|---|---|
| default machine type | `workspaces.ts:456` — `input.defaultMachineTypeId ?? source.default_machine_type_id` |
| agent rule | `workspaces.ts:461` — absent field means inherit, explicit `null` means clear |
| repository list | `workspaces.ts:467` — the source's rows, re-probed against the caller's own GitHub credential |
| connection ceiling | `workspaces.ts:509` — the source's stipulated provider names |

Members, credential values and credential grants deliberately do not travel
(`workspaces.ts:412`): a clone is a template, not a copy of somebody else's
team or secrets. `packages/control-plane/test/workspace-clones.test.ts` pins
the create, the repo rules, the `repos` + `cloneFromWorkspaceId` refusal and
the private-repo 409; `test/agent-rules-library.test.ts:258-271` pins the
agent-rule inherit-vs-clear rule.

What is unfinished is the browser flow around it. Six defects, each verified
against the tree, each with the fix it wants.

## 1. Defects

### 1. A finished clone leaves the source armed for the next create

`cloneFromWorkspaceId` is set in exactly one place and cleared in exactly one
other: `CloudApp.tsx:1750` arms it, `CloudApp.tsx:1739` clears it on **cancel**
only. The success tail, `adoptCreatedWorkspace`, closes the dialog at
`CloudApp.tsx:796` and leaves it set. Every later opener —
`CloudApp.tsx:647` (the first-workspace prompt), `:849` (retry a failed
create), `:1235`, `:1450`, `:1677` (the "+" in the rail) — flips
`showCreateWorkspace` alone, so the next plain create opens titled *New
workspace from "the old one"* and silently sends `cloneFromWorkspaceId`.

**Fix.** Make the source part of the open, not a sibling boolean: replace
`showCreateWorkspace: boolean` + `cloneFromWorkspaceId: string | null` with
one `createWorkspace: { cloneFrom: string | null } | null`. Then opening a
plain create cannot inherit yesterday's source, and no future call site can
forget to clear it. This is worth landing on its own, before any of the rest.

### 2. The source's default machine type never inherits

The dialog always sends a machine type (`CreateWorkspaceDialog.tsx:154`), and
its selection defaults to whatever the provider listed first
(`:101-104`). So the `?? source.default_machine_type_id` branch at
`workspaces.ts:456` is unreachable from this UI: cloning a workspace whose
default is a large machine quietly produces a small one, with nothing in the
dialog admitting the substitution.

**Fix.** In clone mode preselect the source's `defaultMachineTypeId` —
`WorkspaceView` already carries it (`packages/schema/src/workspace.ts:139`),
so `ShellDialogs` can pass it beside `cloneFromWorkspaceName` with no new
route. Fall back to the first listed type only when the source's type is not
in the provider list, and say so where the person can see it.

### 3. The inherited agent rule is invisible, and cannot be cleared

`agentRuleId` starts `null` (`CreateWorkspaceDialog.tsx:84`) and is sent only
when non-null (`:156`), so the server inherits the source's rule. Meanwhile
the Advanced picker renders "no rule" — the dialog shows one thing and the
server does another. There is also no way to express the server's documented
"clear it", an explicit `null`, from clone mode.

**Fix.** Seed the picker from the source's `agentRuleId` (also already on
`WorkspaceView`, `workspace.ts:123`) and, in clone mode, always send the field
so the picker's state is the whole truth.

### 4. Nothing tells the person what carries over

The repo section is hidden under a clone (`CreateWorkspaceDialog.tsx:293`)
and nothing replaces it. Repos, connections, machine default and agent rule
inherit silently; members, credential values and credential grants silently do
not. The person presses a button labelled "New workspace from this one" and is
shown a form that discloses none of it.

**Fix.** A read-only *Carried over from "X"* section listing the four
inherited things, and one line naming what is not. No new wire: `WorkspaceView`
carries the machine default, the agent rule and the connection manifest, and
`client.listWorkspaceRepos(workspaceId)` (`api.ts:199`) reads the repo list the
details dialog already reads.

### 5. The private-repo 409 is a dead end

An inherited private repo the cloner's own GitHub connection cannot reach is
refused with a 409 (`workspaces.ts:487-500`, tested at
`workspace-clones.test.ts:312`). The one recovery is to connect GitHub — and
in clone mode the repo picker that carries the connect link is hidden, so the
dialog states a problem it gives no way to solve. Worse, the connect draft
carries `{ templateId, agentRuleId, repos }` and no clone source
(`connect-drafts.ts:20-24`), so leaving to connect and coming back lands in a
plain create, with the source silently dropped.

**Fix.** Add `cloneFromWorkspaceId` to `WorkspaceConnectDraft`, restore it on
the connect return alongside the rest, and render a Connect GitHub action in
the clone-mode error area. Both halves are needed: either alone still loses
the intent.

### 6. The verb is offered to people who cannot use it

`ShellDialogs.tsx:136` passes `onClone` unconditionally, while `onDelete` two
lines below is gated on `canManageDetails`. Creating a workspace is org-admin
only (`workspaces.ts:453`), so a workspace admin who is not an org admin is
shown the verb, gets the create dialog with its "not an admin" notice, fills
it in, and collects a 403.

**Fix.** Gate the footer button the same way delete is gated, on the viewer's
org role.

## 2. Order of work

1. **Defects 1 and 6** — pure bug fixes with no design in them. They can land
   while the button stays commented out, because defect 1 misfires from every
   *other* create entry point too.
2. **Defects 2, 3 and 4** — one change: the clone dialog is seeded from the
   source and shows what it inherited. These three are the same idea seen from
   three angles, and splitting them means writing the seeding twice.
3. **Defect 5** — the connect round-trip.
4. **Uncomment**, reverting PR #231's two hunks, with the tests below green.

## 3. Tests that must exist before the button comes back

Webapp (`packages/webapp/test/`):

- create → succeed → open the rail "+": the second dialog is titled plain and
  submits no `cloneFromWorkspaceId` (defect 1).
- clone mode preselects the source's machine type, and names the substitution
  when that type is gone (defect 2).
- clone mode preselects the source's agent rule, and clearing it sends an
  explicit `null` (defect 3).
- the carried-over summary names the source's repos and connections, and says
  members and credentials do not travel (defect 4).
- a connect round-trip out of clone mode returns to clone mode (defect 5).
- the footer offers clone to an org admin and withholds it otherwise
  (defect 6) — in `WorkspaceDetailsDialog.test.tsx`, replacing the
  disabled-state assertion PR #231 put there.

One end-to-end that does not exist in any form today: footer → create dialog
carrying the source → the exact body the client sends. Everything between
`WorkspaceDetailsDialog`'s button and `api.createWorkspace` is currently
untested, which is how defect 1 survived.

Control plane: already covered (§0). Nothing new is needed there unless a
decision below changes the inherit set.

## 4. Decisions to confirm before step 2

- **Members and credentials stay out of a clone.** That is the server's
  current stated position (`workspaces.ts:412`). If cloning is meant to onboard
  a team, someone will ask for members; answering "no" in the summary text is
  cheap, changing it later is not.
- **A clone is a one-shot copy, not a link.** Nothing tracks the source
  afterwards. Confirm before anyone builds UI implying otherwise.
- **The details footer is the entry point.** A tile menu item may fit the
  gesture better ("start something like this"); the footer was chosen because
  the dialog is where the config lives. Worth one decision rather than two
  entry points arriving separately.

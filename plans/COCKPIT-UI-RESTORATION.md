# Cockpit UI restoration — current direction

> **Retired 2026-08-29 (branch `lody-sessions`).** The deferred native-chat
> phases below are not resumed; they are deleted. The browser ACP client, the
> box actor on port 7444, its SQLite session journal, the `chat` tab type and
> the recipe `chat` harness are removed from the tree, and `plans/LODY-SESSIONS.md`
> replaces them with a vendored Lody session plane. Read every Chat, ACP and
> actor statement below as product history. Everything about tabs, terminals,
> files, previews and the rail still stands.

Status: **implementation complete; final PR walkthrough pending** (2026-08-26).
This update supersedes the historical plan below without deleting it. The
earlier work remains useful product and implementation history, but native Chat
and Blitz-owned session archive/removal are no longer part of the current UI
branch.

## Product direction update

The cockpit is a tabbed workspace/window manager. Claude, Codex, terminals,
files, previews, and utility panels appear as tabs, but Blitz does not own the
provider-native conversation journal or its archive/delete/resume lifecycle.
Claude and Codex remain responsible for resuming their own conversations.

The resulting interaction contract is:

- the X closes and removes a tab from the cockpit layout;
- closing a Claude, Codex, or terminal tab makes no claim about deleting its
  process, JSONL, transcript, or other provider-native runtime data;
- the workspace rail lists only agent-like tabs that are currently in the
  cockpit layout, not files, previews, utility panels, or hidden resumable
  records;
- right-clicking a managed-session tab opens its menu without selecting it;
- Rename is the only managed-session context action;
- Blitz does not expose archive, restore, or permanent session removal;
- native Chat is intentionally unavailable for now; and
- Finder file/folder actions and Workspace Details remain in scope.

Native Chat may return later as a separately owned product surface. Preserve
its implementation through Git history and a narrow documented availability
boundary, not large commented-out code blocks. Reintroduction requires an
explicit decision about native session ownership, authentication, provider
selection, lifecycle, queueing, recovery, and mobile behavior.

## Active implementation phases

### Phase A — restore standard tab lifecycle

Status: **complete**.

1. Make the X use the normal tab-close operation for Claude, Codex, terminal,
   file, preview, and panel tabs.
2. Remove the retained-window model (`windowOpen`), hidden resumable rail rows,
   and the Resume-session empty state.
3. Remove archive, restore, Archived sessions, and Remove permanently controls,
   state transitions, confirmation UI, icons, and dedicated styling.
4. Keep persisted custom titles and Rename as the only managed-session context
   action. Right-click must not select the target tab.
5. Preserve normal pane invariants: closing the active tab selects an adjacent
   tab, and closing the last side-pane tab collapses the split.
6. Do not adapt documents written by the earlier branch. `windowOpen` and
   `archivedTabs` are unknown keys the parsers ignore on both runtimes: a
   retained-window tab loads as an ordinary tab and archived records drop.
   Only one self-hosted deployment ever wrote them. Persisted native-Chat
   records are dropped on read because every `main` deployment wrote them.

Done when closed tabs disappear from both the tab strip and workspace rail,
Rename remains available without activating a right-clicked tab, no session
archive/removal control is rendered, and a document carrying the retired keys
loads without being rejected.

### Phase B — disable native Chat

Status: **complete**.

1. Add one centralized, documented native-Chat availability boundary.
2. Remove Chat from New Session and every other creation entry point while the
   boundary is disabled.
3. Do not render native Chat tabs or issue Chat authentication/status requests.
   Reconcile existing Chat layout records without deleting provider-native ACP
   journals or transcripts.
4. Remove the branch-only native Chat lifecycle, queued-message, persistent
   config, provider-authentication, and rail-status integrations from the
   active product surface.
5. Remove Chat-only actor authentication-status protocol work from this UI
   branch; it can return with the deferred native Chat work.
6. Keep Claude, Codex, and Terminal launch paths unchanged.

Done when no native Chat entry point or persisted Chat surface is visible,
Claude/Codex/Terminal tabs still launch normally, and the code contains one
clear comment explaining why Chat is disabled and what decision is required
before it returns.

### Phase C — Finder rename and delete

Status: **complete**.

Keep the implemented Finder file/folder rename and delete workflow, including
dirty-editor protection, WebDAV error handling, open-tab/path reconciliation,
and the existing Drive actions. These operations manage workspace files, not
provider-native session records.

### Phase D — Workspace Details

Status: **complete**.

Keep the implemented three-dot Workspace Details action, human-readable
compute/storage/configuration metadata, access list, separate Share action, and
workspace deletion inside Details. Workspace deletion is distinct from session
archive/removal and remains in scope.

### Phase E — mobile responsiveness

Status: **complete**.

Audit global navigation, workspace creation, Templates, Recipes, Drive,
Settings, the workspace rail, standard tab closing/renaming, Finder, Share, and
Workspace Details at the supported breakpoints. Remove the historical mobile
requirements for native Chat, Chat configuration/queues/approvals, and
archive/restore controls. Preserve the single-pane mobile model, touch access,
viewport-safe menus/dialogs, focus return, keyboard behavior, and safe areas.

### Phase F — final refinement and polish

Status: **implementation complete; final manual walkthrough pending**.

Walk fresh and persisted workspaces across desktop and mobile. Verify standard
close behavior, Rename-only session menus, rail counts/selections, split-pane
collapse, reload/reconnect, file actions, Share, and Workspace Details. Confirm
that no native Chat or session archive/removal entry point remains, run the
required repository gates and self-host walkthrough, and record intentional
limitations before the PR.

## Completion record — 2026-08-26

The current implementation satisfies the active cockpit scope:

- standard tab closing and Rename-only managed-session menus are restored;
- native Chat, session archive/restore, and permanent session removal are not
  exposed;
- retired `windowOpen`/`archivedTabs` keys are ignored at the parsers rather
  than adapted, and persisted Chat layout records are dropped on read;
- Finder rename/delete, dirty-editor protection, path reconciliation, and Drive
  actions are present;
- Workspace Details includes compute, storage, configuration, access, Share,
  and workspace deletion flows; and
- the mobile pass covers cockpit navigation and density, terminal controls and
  keyboard viewport behavior, Settings, Finder menus, creation-form actions,
  safe areas, and opening Workspace Details from the mobile rail.

Validation completed on Node 22:

- WebApp tests: 273 passed;
- control-plane tests and wire-drift checks: passed;
- repository typecheck: passed;
- lint gate: passed;
- WebApp production build: passed; and
- `git diff --check`: passed.

Two `box-actor` terminal-environment tests remain failing around `LANG`
propagation. This branch does not modify `packages/box/actor`, so these are
recorded as unrelated environment/runtime failures rather than cockpit UI
regressions.

Before merge, perform one final self-host walkthrough covering a fresh and a
persisted workspace, reload/reconnect, and a mobile landscape sanity check.
Record any deployment-specific observations in the PR rather than expanding
the cockpit scope unless the walkthrough exposes a reproducible regression.

Intentional limitations:

- native Chat remains deferred behind the centralized availability boundary;
- Claude and Codex own their provider-native conversation history and resume
  lifecycle; and
- closing a cockpit tab removes the window from the Blitz layout but does not
  claim to delete provider-native processes, transcripts, or journals.

## Deferred native Chat work

The historical Phases 2, 3A, and 3B below are deferred rather than discarded.
They cover native Chat identity/recovery, ACP lifecycle states, workspace-file
links, queued prompts, persistent selections, provider authentication, and
provider locking. They are not current acceptance criteria and should return
only in a dedicated plan/branch after the product ownership boundary is agreed.

## Current recommended PR sequence

1. Standard tab lifecycle and compatibility normalization.
2. Native Chat availability boundary and active-surface removal.
3. Finder actions.
4. Workspace Details.
5. Mobile responsiveness.
6. Final refinement, staging walkthrough, and release notes.

Each PR keeps tests and documentation aligned with its actual shipped surface.
Do not ship retired archive/window fields or Chat-only runtime contracts merely
because they remain described in the historical record below.

---

## Historical plan — superseded on 2026-08-25

The following plan is intentionally preserved unchanged as implementation and
decision history. Its earlier completion labels do not override the active
direction above.

# Cockpit UI restoration on the ACP runtime

Status: **plan** (2026-08-24). Scope approved: restore the P0 and P1
capabilities identified by comparing a previous merged PR from an older repo
with the current BlitzOS webapp, then complete a dedicated mobile pass and a
final refinement/bug-polish pass.

Progress: **Phases 1–5 implemented locally** on `feat-ui-changes` (2026-08-25).
The work also separates closing a session window from archiving the session,
adds the Start/Resume empty states, and completes the Finder rename/delete
workflow with dirty-editor protection. Phases 6–7 have not started.

This is not a port of the old bridge. The current control-plane → webapp → box
actor/ACP architecture stays authoritative. We restore the user-visible
behavior over those contracts and leave the retired bridge, completion store,
and provider handoff protocol behind.

## Outcome

When this plan is complete:

- every new native Chat tab owns a distinct ACP session;
- an existing Chat tab reliably reloads its own session and transcript;
- managed sessions can be renamed, archived, restored, and permanently
  removed from the cockpit layout;
- the workspace rail reports native-chat `generating`, `needs input`, `done`,
  and `error` states, without pretending terminal tabs expose structured
  lifecycle state;
- workspace-file links in agent Markdown open the corresponding file tab;
- a user can queue prompts while a turn runs and remove them before dispatch;
- model, effort, permission, and thinking-view choices survive a reload per
  Chat tab;
- Finder rows support rename and delete without losing the newer Drive
  actions or leaving stale open-file tabs behind; and
- workspace details are available separately from Share, using real current
  control-plane data and not exposing secrets or provider identifiers;
- restored workflows remain usable at the supported mobile breakpoints without
  hidden, clipped, or unreachable controls; and
- a final cross-feature pass resolves remaining visual inconsistencies,
  interaction regressions, and release-blocking bugs.

## Current ground truth

| Capability | Current state | Implementation consequence |
|---|---|---|
| Chat session journal/list/load | Shipped in the box actor | Reuse ACP `session/new`, `session/list`, and `session/load`; do not recreate bridge history routes. |
| New Chat tab binding | Incorrectly adopts the first listed session when no ID is stored | New and recovery intent must be distinguished explicitly. |
| Tab persistence | Shipped as the shared workspace webapp-state document | Extend the existing document additively for titles, archive state, and chat preferences. |
| Header rename UI | Present but disconnected | Wire it to persisted tab state rather than rebuilding the control. |
| Archive UI/state | Absent; the close tooltip says Archive but close only removes the tab | Add archive state and make the labels match the operation. |
| Actor prompt queue | Shipped and bounded | Keep removable browser messages locally until dispatch; actor serialization remains the race/multi-client backstop. |
| Chat lifecycle data | Present in the ACP reducer (`running`, permission requests, turn results) | Derive rail state from real reducer events. |
| Workspace file-link parser | Present in `chat-render.tsx` | Thread `onOpenFile` through the currently missing component props. |
| Finder create and Drive actions | Shipped | Add rename/delete to the same context menu; do not replace the newer Finder design. |
| Workspace metadata | Machine, volume, environment, lifecycle, and timestamps exist in control-plane rows, but the webapp wire/model drops part of them | Extend the workspace view and adapter before rendering Details. |
| Park/resume | Deliberately removed from the current control-plane product | Do not restore the old stopped-workspace Resume screen. |

## Decisions

### 1. The control-plane webapp-state document remains the layout authority

Use an additive extension to the existing version-1 document instead of a new
database table or a parallel local-storage model:

```ts
type WorkspaceTabs = {
  version: 1;
  tabs: WorkspaceTab[];
  archivedTabs?: WorkspaceTab[];
  activeId: number | null;
  sideActiveId?: number;
  nextId: number;
};

type ManagedTabFields = {
  title?: string;
  windowOpen?: false;
};

type ChatTabFields = ManagedTabFields & {
  chatSessionId?: string;
  chatProvider?: "claude" | "codex";
  chatConfig?: {
    model?: string;
    effort?: string;
    permission?: string;
  };
};
```

- Missing `archivedTabs` reads as `[]`, so existing documents need no data
  migration.
- IDs must be unique across active and archived tabs.
- `activeId` and `sideActiveId` may only identify active tabs.
- `nextId` must be greater than every active or archived ID so a restore can
  never collide with a newly created tab.
- Titles remain bounded by the existing 64-character UI limit and a matching
  server-side limit.
- File, preview, and panel tabs continue to close rather than archive.
- A managed tab with missing `windowOpen` is open. `windowOpen: false` keeps the
  session in the workspace rail while removing its window from the tab strips.
- The server parser must preserve every accepted optional field instead of
  silently stripping it during a round trip.

Do not put model/effort UI preferences in `chat_session.db`. That database is
scope-fenced to session list, replay, and resume. The preferences belong to
the shared cockpit document and are reapplied through ACP when the tab loads.

### 2. Closing a window and archiving a session are distinct layout operations

The X button closes only the managed session's window. The session remains in
the workspace rail and selecting it reopens the same tab/session. When no
managed sessions exist, the main surface explains how to create one. When
sessions exist but every session window is closed, it directs the user to
resume one from the workspace rail. These empty states have no action button.

Archive removes a managed tab from the active strips while preserving all tab
metadata, including its ACP session ID. Restore puts the same tab back with
the same ID and selects it.

Permanent removal deletes the cockpit record. It does **not** claim to erase
Claude/Codex native transcripts or every underlying runtime artifact. The UI
must use “Remove permanently” language rather than implying provider-data
erasure. A true ACP/provider transcript deletion API is a separate future
capability.

### 3. New Chat and recovered Chat are different operations

The current fallback (`session.list` → first session) is useful for adopting a
legacy/orphaned session but wrong for a user pressing New Chat.

- A newly spawned Chat tab uses explicit `create` intent and calls
  `session/new`, even when other sessions already exist.
- A tab with `chatSessionId` uses `session/load` for exactly that ID.
- A legacy persisted Chat tab without an ID uses one-time `recover` intent:
  list sessions, exclude IDs already bound to other tabs, adopt the newest
  remaining session, and persist the ID. If none remains, create one.
- Failure to load a stored ID becomes a visible recover/create choice. It must
  not silently switch the tab to somebody else's conversation.
- Session IDs are persisted immediately after creation/recovery through the
  existing workspace-state writer.

### 4. Chat lifecycle state is ephemeral UI state

Rail state is not added to the control-plane document or actor database. It is
derived while the webapp is connected:

| ACP/UI event | Rail state |
|---|---|
| Prompt accepted, streaming, tool work, or queued work draining | `generating` |
| Unanswered tool permission | `needs-attention` (“needs input” in the rail) |
| Successful completed turn | `done` |
| Refusal, fatal connection/provider failure, or failed turn | `error` |
| User cancellation/interruption | `idle` |

Only native Chat tabs receive these states. Ttyd/tmux terminals remain
unmarked. Inactive `done` and `error` states are unread; selecting the tab
acknowledges and clears them. If completion/error arrives while the tab is
already active, the transcript keeps the result but the rail does not show a
stale unread state.

### 5. Queued messages are removable until sent

The webapp owns the visible queue:

- Enter/Send during a running turn appends a bounded local queue item.
- Queue rows display the message and a Remove action.
- After a turn settles, the panel shifts exactly one item and sends it through
  the normal ACP prompt path.
- Stop cancels only the active turn; queued items remain visible and removable.
- A disconnected/reloaded page does not automatically resend unsent browser
  queue items. Losing an unsent queue on reload is safer than duplicating a
  prompt.
- The actor's existing queue remains authoritative for concurrent clients and
  races that reach it at the same time.

## Implementation phases

### Phase 1 — session identity, titles, archive, and restore

1. Extend `WorkspaceTab`, `WorkspaceTabs`, the webapp parser/serializer, and
   `core/webapp-state.ts` with the additive fields above.
2. Update normalization helpers so moving, closing, archiving, restoring, and
   removing tabs preserve pane invariants and never reuse IDs.
3. Add explicit Chat `create | load | recover` behavior. Remove the generic
   “no ID means first listed session” path.
4. Populate `customTitle`/`renameable` in `CloudApp`, pass `onRename` to
   `WebAppHeader`, and persist trimmed titles. Empty input resets to the
   generated label.
5. Restore the managed-session context menu: Rename, Archive, and Remove
   permanently. The active-tab X closes the window only; Archive remains an
   explicit context-menu action.
6. Restore the Archived sessions menu with bounded height, long-name
   truncation, Restore, and Remove permanently.
7. Make archive/restore work from either pane. Restoring selects the tab in
   its recorded region; if that region is unavailable on mobile, normal tab
   normalization places it in main.

Done when two newly created Chat tabs have different ACP IDs and independent
histories; titles survive reload; archive/reload/restore returns the same
session; and removing an archived entry does not corrupt `activeId`,
`sideActiveId`, or `nextId`.

### Phase 2 — native-chat rail states and workspace-file links

Implemented locally on `feat-ui-changes` (2026-08-24).

1. Add a `ChatSessionStatus` callback to `ChatPanel` and derive it only from
   reducer/ACP state.
2. Store statuses in `CloudApp` by workspace ID and cockpit tab ID. Clear the
   map when the active workspace changes.
3. Extend the rail session model/rendering for spinner, needs-input, done,
   error, and unread styling. Reuse the dormant current status classes where
   valid; remove dead CSS rather than duplicating selectors.
4. Apply the acknowledgement rules in Decision 4.
5. Add `onOpenFile` to `ChatPanel`, `ChatTurnView`, `TurnWork`, and
   `ChatItemView`, then pass it into `AssistantBlocks`.
6. Wire `CloudApp.openFile` into Chat so safe relative paths and absolute
   `/workspace/...` links open or focus the corresponding file tab. External
   URLs and paths outside `/workspace` keep their existing behavior.

Done when a background Chat tab visibly transitions through generating →
needs input/done/error, opening it clears only the unread rail marker, terminal
tabs never gain synthetic state, and a Markdown link to a workspace file opens
that file without duplicating an already-open tab.

### Phase 3A — queued prompts and persistent chat selections

Implemented locally on `feat-ui-changes` (2026-08-25).

1. Refactor the current `send` function into one dispatch path accepting an
   explicit message string.
2. Add the bounded local queue and drain rules from Decision 5.
3. Render queued rows beneath the transcript/composer with Remove actions and
   clear state labels.
4. Add an `onConfigChange` callback to `ChatPanel`.
5. Persist model, effort, and permission on the Chat tab in workspace state.
6. After `session/new` or `session/load`, compare saved values with the ACP
   options currently advertised. Reapply only values that still exist; drop
   or replace stale values with the actor's current default.
7. Keep `showThinking` hard-coded on. Do not add a visibility toggle.
8. Ensure config updates from one shared webapp state do not interrupt an
   already running turn; they apply to the next turn.

Done when two messages entered during a running turn appear in order, either
can be removed before dispatch, the remaining message runs exactly once, and
chat selections survive a browser reload and actor reconnect.

### Phase 3B — provider authentication and available Chat options

Implemented locally on `feat-ui-changes` (2026-08-25). Standalone status
checks are implemented; the optional broker status contract remains deferred
to a broker-specific plan/PR.

1. Add an actor-owned, secret-free authentication-status response for Claude
   and Codex. A failed status check must remain distinct from signed out.
   Standalone boxes use the pinned vendor CLIs; broker-enrolled boxes report
   `unknown` until the broker status contract is designed and tested in its own
   package/PR.
2. Gate a new Chat before its first prompt when neither provider is signed in.
   Show one notice with a `Check again` action after the user signs in from the
   provider's terminal; do not duplicate provider-specific sign-in notices.
3. Show only authenticated providers in Chat's provider/model controls. When
   both are authenticated, expose both; after one provider is authenticated,
   remove the gate and expose only that provider.
4. Create each Chat session with the selected provider and preserve that
   provider when the tab/session is restored. A brand-new Chat can select its
   provider before the first turn; loaded, recovered, running, or already-used
   conversations keep that provider locked.
5. Re-check status after a sign-in flow without requiring a workspace reload,
   while retaining the existing live `blitz/auth_required` response for
   credentials that expire later.

Done when a new signed-out workspace cannot accidentally submit a Chat prompt,
signing into either provider in its terminal and selecting `Check again`
unlocks Chat, and the provider/model choices always match the providers
currently authenticated on that workspace.

### Phase 4 — Finder rename and delete

Implemented locally on `feat-ui-changes` (2026-08-25), including file/folder
targets, WebDAV move/delete, path reconciliation for expanded/selected tree
state and open descendant file tabs, dirty-editor confirmation, recoverable
DAV error states, preservation of the existing Drive actions, and
control-plane normalization of proxied WebDAV `Destination` headers.

1. Extend `FilesContextMenuState` with the clicked file/directory target and a
   `rename | delete` action state.
2. Keep New file, New folder, Open in Drive, and Share to Drive. Add Rename and
   Delete for actual tree rows.
3. Implement rename with WebDAV `moveFile` and delete with `deleteFile`, using
   the current error-envelope/401 handling and collision messages.
4. On rename, update every affected open file tab, expanded directory path,
   selected path, and breadcrumb whose path equals or descends from the moved
   path.
5. On delete, close affected open file tabs, remove affected expanded/selected
   paths, and reload the parent directory.
6. If a target or descendant has an unsaved editor tab, require confirmation
   before rename/delete. Never silently discard a dirty editor.
7. Keep the current Finder alphabetical interleaving. Folder-first sorting was
   intentionally replaced and is not part of this restoration.

Done when files and folders can be renamed/deleted, open tabs follow a rename,
deleted tabs disappear, dirty content is protected, and all existing Drive
context actions continue to work.

### Phase 5 — workspace details separate from Share

Implemented locally on `feat-ui-changes` (2026-08-25). The workspace rail now
uses a three-dot Details action instead of a permanent Delete control, Share
remains separate, Details resolves compute/storage metadata from the catalogs,
shows owner, organization-wide access, individual grants and their roles, and
moves destructive deletion behind the dialog and its confirmation.

1. Add `createdAt` and `updatedAt` to the shared `WorkspaceView` wire type and
   populate them from the existing workspace row. Stop treating revision as a
   timestamp in the webapp adapter.
2. Preserve the current wire/model fields needed for details: machine type,
   volume presence, environment presence, lifecycle, owner/role, and
   timestamps.
3. Resolve display metadata through the existing machine and volume catalogs:
   provider label, location, CPU, memory, disk, volume size, and volume
   location. Do not expose raw provider resource IDs.
4. Add a `WorkspaceDetailsDialog` using the current modal/focus primitives.
   Sections:
   - Compute: machine label, provider, location, CPU, memory, disk.
   - Storage: persistent volume attached/not attached, size, location.
   - Workspace: lifecycle, owner, access role, created, updated.
   - Configuration: environment/startup configured as yes/no only.
5. Never render environment values, startup-script contents, SSH details,
   credential data, or raw volume/VM IDs.
6. Keep Share as its own action. Rename the misleading
   `onOpenWorkspaceDetails` share callback and introduce a real details
   callback/state. Details remains limited to controllable workspaces.

Done when Details and Share open different dialogs, the values come from the
current workspace/catalog records, ordinary ungranted users cannot request
details, and no secret-bearing field reaches rendered markup.

### Phase 6 — mobile responsiveness

1. Audit every primary webapp workflow at the existing mobile breakpoints:
   global navigation, workspace creation, Templates, Recipes, Drive, Settings,
   workspace rail, tab strips, session menus, Chat, Finder, archive/restore,
   Share, and Workspace Details.
2. Keep the single-pane mobile model authoritative. Tabs restored from a side
   region must remain reachable and usable when only the main surface is shown.
3. Ensure menus, dialogs, confirmations, provider/config controls, queued
   prompts, permission requests, and empty states fit the viewport without
   horizontal scrolling or clipped actions.
4. Position file/session context menus within the visible viewport and provide
   touch-accessible alternatives for actions that otherwise depend on
   right-click or hover.
5. Verify the rail/drawer opens and closes predictably, preserves the active
   workspace/session, and does not leave background content interactive while
   an overlay is open.
6. Check touch target sizes, mobile keyboard behavior, focus return, long-name
   truncation, safe-area spacing, and portrait/landscape transitions.
7. Add breakpoint-focused interaction tests for the highest-risk flows instead
   of relying only on desktop DOM coverage.

Done when every primary webapp workflow can be completed on a phone-sized
viewport, no primary control is hidden or clipped, overlay/focus behavior is
predictable, and desktop behavior remains unchanged.

### Phase 7 — final refinement, polish, and bug sweep

1. Walk the complete plan end to end on a fresh workspace and on a workspace
   with persisted sessions, files, archived tabs, and provider authentication.
2. Resolve remaining copy, spacing, alignment, loading, empty, error, disabled,
   hover, focus, and unread-state inconsistencies across desktop and mobile.
3. Exercise cross-feature transitions that commonly expose regressions:
   reload/reconnect, workspace switching, split-pane changes, close/reopen,
   archive/restore, rename/delete, sign-in changes, and background completion.
4. Review browser console/network failures and remove stale UI paths, dead CSS,
   and obsolete compatibility code only when coverage proves they are unused.
5. Run the full required gates and self-host staging walkthrough, then document
   any intentional limitations or deferred work before opening the final PR.

Done when no known release-blocking bugs remain, the desktop and mobile
surfaces feel visually consistent, all required gates pass or have a documented
unrelated infrastructure exception, and the plan accurately describes the
shipped behavior and remaining limitations.

## Recommended PR sequence

Keep these reviewable rather than recreating PR #252 as one large change:

1. **Session contract and lifecycle:** distinct Chat sessions, titles,
   archive/restore/remove, persistence contracts.
2. **Chat visibility:** rail lifecycle statuses and workspace-file links.
3. **Chat interaction:** removable queue and persistent config/thinking.
4. **Finder actions:** rename/delete plus open-tab/path reconciliation.
5. **Workspace details:** wire timestamps/metadata, dialog, and separate rail
   actions.
6. **Mobile responsiveness:** breakpoint, drawer, overlay, touch, and
   mobile-workflow coverage.
7. **Final refinement:** cross-feature bug sweep, visual polish, staging
   walkthrough, and release notes.

Each PR must update tests and documentation for its own contract. Do not land
UI that writes fields the deployed control-plane parser strips; session-state
webapp and control-plane changes ship together.

## Test plan

### Session and persistence tests

- `session/new` is called for each explicitly new Chat tab even when
  `session/list` is non-empty.
- A stored session ID loads exactly that session.
- Legacy no-ID recovery excludes IDs already bound to other tabs.
- Missing stored session surfaces recovery instead of silently adopting the
  first result.
- Titles and archived tabs survive webapp-state PUT/GET and browser reload.
- Server and browser parsers enforce the same bounds and active/archived ID
  invariants.
- Archive/restore works in main and side panes; permanent removal preserves
  active IDs and monotonically increasing `nextId`.

### Chat tests

- generating, permission attention, success, cancellation, refusal, and fatal
  paths emit the expected status.
- done/error acknowledgement is symmetric and terminal tabs remain excluded.
- background/inactive completion is unread; active completion is already seen.
- safe workspace Markdown links call `onOpenFile`; external/traversal links do
  not.
- queued messages drain in order, can be removed, do not duplicate after a
  connection failure, and Stop only cancels the active turn.
- valid persisted config is reapplied; stale config falls back safely; thinking
  visibility round-trips.

### Files tests

- Context menus retain create and Drive actions while adding target actions.
- File and directory rename call the correct DAV path and rewrite descendants.
- Delete closes affected tabs and clears expanded/selected descendants.
- Dirty files require confirmation.
- 401, 403, collision, and general DAV failures remain visible and recoverable.

### Workspace-details tests

- Workspace wire timestamps round-trip and wire-drift tests stay exact.
- Owner/admin gating is enforced in both UI entry points and API data access.
- Machine/volume catalog joins render human labels, never raw IDs.
- Environment values, startup script content, SSH data, and credentials are
  absent from rendered output.
- Share and Details remain separate actions.

### Mobile tests

- Primary webapp workflows remain reachable in the single-pane mobile layout.
- Rail/drawer, menus, dialogs, and confirmations stay inside the viewport and
  return focus to the invoking control.
- Touch-accessible actions cover file/session operations that use context menus
  on desktop.
- Chat provider/config controls, queue rows, approvals, and empty states remain
  usable with the on-screen keyboard open.
- Long labels and portrait/landscape changes do not hide primary actions.

### Final refinement tests

- Fresh and persisted workspaces pass the same end-to-end workflow.
- Reload, reconnect, workspace switching, split changes, close/reopen, and
  archive/restore preserve the correct visible and selected state.
- Expected loading, empty, error, disabled, active, focus, and unread states are
  covered without stale duplicate UI.
- Browser console/network inspection shows no unexplained failures during the
  staging walkthrough.

### Required gates

Run under the repository-supported Node 22 runtime:

```sh
npm run test -w @blitzos/webapp
npm run test -w @blitzos/box-actor
npm run test -w @blitzos/control-plane
npm run typecheck
npm run lint:gate
npm run build -w @blitzos/webapp
git diff --check
```

The box actor is expected to need no source change for this plan: session
creation/list/load, config options, prompt cancellation, and queue
serialization already exist. Run its tests because the webapp relies on those
contracts. A box image rebuild should not be required. The workspace-state and
details phases do require the webapp and control plane to be deployed together
to staging.

### Self-host staging walkthrough

1. Create two Chat tabs and verify different ACP session IDs and independent
   histories.
2. Rename both, archive one, reload, restore it, and confirm its transcript.
3. Start a turn in a background tab and observe generating, needs-input, done,
   and error acknowledgement behavior.
4. Open a file path from an agent response and confirm the correct editor tab
   focuses.
5. Queue two prompts, remove one, and confirm the other runs exactly once.
6. Change model/effort/permission/thinking, reload, and confirm the choices.
7. Rename and delete a file and folder; verify editor tabs and breadcrumbs
   reconcile and dirty-file confirmation blocks data loss.
8. Open Workspace Details and Share separately; verify metadata and inspect the
   DOM/network payload for forbidden secret fields.
9. Repeat the complete workflow at the supported phone-width breakpoint in
   portrait and landscape, including touch-accessible session/file actions.
10. Perform the final desktop/mobile bug sweep, inspect console/network errors,
    and record intentional limitations before release.

## Explicit non-goals

- Restoring park/resume or the stopped-workspace screen.
- Reintroducing bridge history/auth/completion-store routes.
- Provider handoff or switching the actor provider inside one Chat session.
- A provider-discovered slash-command protocol. Current ACP config controls
  remain the supported model/effort/permission surface.
- Token/cost analytics in `chat_session.db`.
- OpenCode, Pi, Kimi, or Prime runtime installation/spawn support.
- Folder-first Finder ordering.
- Native transcript/provider-data deletion.
- Attachments or unified terminal/chat session views that existed only as plan
  documents in the older PR.

## Primary files and contracts

- `packages/webapp/src/CloudApp.tsx`: coordination, tab/status state, file and
  details actions.
- `packages/webapp/src/WebAppHeader.tsx`: rename/context/archive UI.
- `packages/webapp/src/files/DriveRail.tsx`: session states and separate
  Share/Details entry points.
- `packages/webapp/src/chat/ChatPanel.tsx` and `chat-turn-views.tsx`: session
  intent, lifecycle, queue, config, and file-link propagation.
- `packages/webapp/src/storage.ts` and `workspace-panes.ts`: active/archived
  tab model and invariants.
- `packages/control-plane/core/webapp-state.ts`: server mirror of the shared
  cockpit document.
- `packages/webapp/src/FilesSidebar.tsx`, `FilesContextMenu.tsx`, and
  `FilesTreeRow.tsx`: target actions and path reconciliation.
- `packages/schema/src/workspace.ts`, `packages/control-plane/core/wire.ts`,
  `workspace-records.ts`, and `packages/webapp/src/api-adapter.ts`: workspace
  details data contract.

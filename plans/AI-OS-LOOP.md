# AI OS loop — save a good workspace as a template

Audit date: 2026-08-26. Source: `origin/main` at `e5f70e1`.
Every line number in this document refers to that commit. `main` moves often.

A template stores a reusable workspace setup. A workspace starts from a template or starts blank.
A recipe combines a template, harness, model, optional effort, and prompt. The root `README.md:28` starts an agent from a company template.
`README.md:30` then asks one developer to publish the improved setup.

## Part one — findings

### Gap 1 — no workspace-to-template path

The create parser accepts `templateId` at `packages/control-plane/core/workspaces.ts:105`. The workspace insert omits it at `packages/control-plane/core/workspaces.ts:490`.
That insert also omits requested repositories. `WorkspaceView` exposes neither value at `packages/schema/src/workspace.ts:27`.
The template menu offers Edit and Delete at `packages/webapp/src/files/TemplatesHome.tsx:100`. The card offers New workspace separately at `packages/webapp/src/files/TemplatesHome.tsx:151`.
Users must rebuild a successful setup from memory.

### Gap 2 — ready does not mean setup complete

Phone home marks the workspace ready at `packages/control-plane/core/workspaces.ts:922`. The control plane schedules folder sync later at `packages/control-plane/core/workspaces.ts:936`.
Bootstrap starts repository cloning before phone home at `packages/control-plane/core/bootstrap.ts:765`. Cloning can finish before or after ready.
Users can start work before folders, repositories, environment, or startup work finishes.

### Gap 3 — setup failures stay hidden

Broker registration returns `no_broker_capacity` at `packages/control-plane/core/registry.ts:279`. The guest exits successfully at `packages/box/rootfs/usr/local/libexec/blitz-register:47`.
The watcher waits for `broker.json` at `packages/box/rootfs/etc/s6-overlay/s6-rc.d/watch/run:15`.
The create dialog hides a failed template load at `packages/webapp/src/CreateWorkspaceDialog.tsx:99`. The rules picker still shows fallbacks at `packages/webapp/src/AgentRulesPicker.tsx:147`.
Backend failures can look like valid empty states.

### Gap 4 — viewer sharing breaks its promise

The dialog promises chat replay at `packages/webapp/src/ShareWorkspaceDialog.tsx:177`. The control plane blocks viewer port `7444` at `packages/control-plane/core/workspaces.ts:736`.
The browser also shows one fixed hold message at `packages/webapp/src/CloudApp.tsx:1742`.
Viewers cannot review the agent chat.
The read-only terminal gate uses `created_at` as a proxy for box capability.
Box update landed in `e5f70e1`. A cloud-VM host can now swap the image of a running workspace.
So `created_at` no longer identifies the running image. A future fix must read reported box state.

### Gap 5 — workspaces never stop

The server defines five phases at `packages/schema/src/workspace.ts:3`. It defines no stopped or resumed phase.
The browser carries unused stop states at `packages/webapp/src/protocol.ts:3`. The quota counts `VM_SLOT_PHASES` at `packages/control-plane/core/workspaces.ts:496`.
Those phases are `creating`, `ready`, `destroying`, and `error`. Only `destroyed` frees a slot.
The cap has one stored source, `orgs.vm_limit`. Entitlements can write that column, but `org_entitlements` holds seat limits only.
Users must destroy workspaces to stop cost and release quota.

### Gap 6 — new organizations start empty

Organization creation writes only the organization, membership, and session at `packages/control-plane/core/identity/routes.ts:185`.
The create dialog shows both cards at `packages/webapp/src/CreateWorkspaceDialog.tsx:202` and `packages/webapp/src/CreateWorkspaceDialog.tsx:237`.
The recipe screen stops without templates at `packages/webapp/src/files/CreateRecipeScreen.tsx:203`.
New users must design a template before they see one work.

### Gap 7 — agent rules have no history

Any active member can write shared rules at `packages/control-plane/core/agent-rules.ts:165`. The PUT overwrites content at `packages/control-plane/core/agent-rules.ts:215`.
The box receives the selected content instead of the platform manual at `packages/control-plane/core/agent-rules.ts:155`.
One edit changes running workspaces and can fork the platform instructions.

### Gap 8 — recipe triggers have no run end

`plans/RECIPES.md:149` proposes triggers as future callers. Current `RecipeView` stores configuration only at `packages/schema/src/recipe.ts:11`.
No `plans/RECIPE-TRIGGERS.md` exists in the tree or reachable history. No current design defines run completion, stopping, or retention.
A noisy trigger could consume the organization quota.

### Gap 9 — template editing leaks or loses changes

The UI changes folder access before save at `packages/webapp/src/files/CreateTemplateScreen.tsx:243`. A failed save can leave private folders shared.
The PUT applies `agentRuleId` at `packages/control-plane/core/workspace-templates.ts:517`. The edit UI omits it at `packages/webapp/src/files/CreateTemplateScreen.tsx:270`.
Create and delete use separate mutations at `packages/control-plane/core/workspace-templates.ts:423` and `packages/control-plane/core/workspace-templates.ts:609`.
A failure can leave partial template state.

## Part two — committed workspace-to-template loop

This plan commits only to the browser loop.
It does not add agent credentials, readiness, lifecycle, rules, or recipe systems.

### Stored data

| Area | Committed change |
|---|---|
| Workspaces | Add `creation_source`, `source_template_id`, and nullable `requested_template_repos_json`. |
| Templates | Add `description`, `visibility`, `deleted_at`, `org_share_role`, and publication approval data. |
| Template folders | Add `guest_path`. |
| Template connections | Add explicit `scopes_json`. |
| Publication audit | Add append-only publish, unpublish, and delete records. |

Future creates write all source fields with the workspace row. Blank creates record `'blank'` and an empty repository list.
Template creates record `'template'`, the selected template, and requested repositories. Those repositories describe requests, not clone results.
The migration leaves existing source fields null. Existing rows never stored these values, so no backfill can recover them.
The migration marks existing templates private and clears their default status. Shared recipe launches wait for publication.
This choice prevents silent publication of old secrets and scripts.
The Worker adds every new field to `BLITZDEV_CONFIG` at `packages/control-plane/scripts/lib/worker-source.mjs:103`.
Each new core file must enter `CORE_MANIFEST` in the same file.

### Routes and flow

The server keys each `reviewDigest` to exact template content.

| Method and path | Authorization | Action |
|---|---|---|
| `GET /workspaces/:id/template-draft` | Workspace owner or organization administrator | Return a redacted draft. |
| `POST /workspace-templates` | Active member session | Create a private template. |
| `PUT /workspace-templates/:id` | Private creator, or administrator | Replace a template and remove publication approval. |
| `GET /workspace-templates` | Active member session | List permitted private templates and published templates. |
| `GET /workspace-templates/:id/publish-review` | Organization administrator | Return exact protected content and a review digest. |
| `POST /workspace-templates/:id/publish` | Organization administrator | Publish reviewed content and record the audit event. |
| `GET /workspace-templates/:id/launch-review` | Allowed template user | Return exact executable content without environment values. |
| `DELETE /workspace-templates/:id` | Private creator, or administrator | Soft-delete the template. |

The browser requests a draft and shows every derived field. The user edits the draft and creates a private template.
An administrator uses a separate publication review. Workspace creation continues through the existing create route.

### Authorization and secret data

The draft route calls `canControlWorkspace`. That helper permits only owners and administrators at `packages/control-plane/core/workspace-access.ts:17`.
Viewer and editor access never permits draft creation.
Current workspace views return raw environment data to any opener at `packages/control-plane/core/workspace-records.ts:99`.
The implementation returns raw environment data only to workspace controllers.
The draft returns environment key names but no values. It copies no value into `draft.environment.env`.
The user enters each wanted value again. The browser shows the exact startup script as executable content.
The organization catalogue returns no environment names, values, or startup script. It returns counts and presence flags only.
The launch review returns the startup script and selected rule content. It never returns environment values.
The publish review shows environment values only to an administrator. The administrator confirms every literal value.
The review digest binds that confirmation to exact content.

### Executable template governance

Every new template starts private. Only its creator and administrators can use it.
Only an administrator can publish it to the organization.
The publish screen shows the exact startup script, selected rule, and changes since approval.
The server records the actor, review digest, action, and time.
Any template update removes approval. Any selected rule change makes the stored review digest fail.
The workspace create route then blocks the template. An administrator must review and publish it again.
Only the publish route sets `orgShareRole` or the organization default.
This rule limits automatic sharing to administrators. Template save never changes folder access.
The publish screen requires accessible organization folders or removes them.

### Connection scope ceiling

The current code cannot enforce a saved scope ceiling end to end.
Parsing overwrites scoped GitHub at `packages/control-plane/core/workspace-templates.ts:123`. Creation keeps provider names at `packages/control-plane/core/workspaces.ts:436`.
Token pulls request provider defaults at `packages/control-plane/core/connections/mint.ts:541`.
The loop must change the complete path before it exposes scoped template saving.

1. The parser keeps an existing GitHub entry.
2. The parser expands absent legacy scopes to current provider defaults.
3. New canonical inputs always carry `scopes`.
4. An empty list permits only requests with no named scope.
5. Workspace creation intersects template and caller ceilings.
6. The workspace manifest stores the effective scopes.
7. Box token pulls request those stored scopes.
8. `manifestAllows` remains the final subset check.

A caller can narrow a template ceiling. A caller cannot widen it. Caller absence keeps the template ceiling.
Repository requests add GitHub defaults only without a GitHub entry. The publish review shows that addition.

### Folder paths and compatibility

The server first accepts `folders` with current `folderIds`. It rejects requests that contain both fields.
It keeps `folderIds` until telemetry shows no legacy clients. It converts both forms into one internal shape.
The parser reuses the safety rule at `packages/control-plane/core/files/attachments.ts:43`.
It also rejects duplicate and overlapping paths.
It rejects `shared/agent-usage`, `CLAUDE.md`, and every requested repository target.
Template creation writes `guestPath` instead of current `NULL` at `packages/control-plane/core/workspace-templates.ts:309`.

### Transactions, deletion, and limits

One transaction covers create, replacement, default, and audit mutations. The implementation uses `packages/control-plane/core/db.ts:35`.
Delete sets `deleted_at` and clears publication in one transaction. Delete keeps template relations and publication history.
Existing workspaces keep `sourceTemplateId`. The catalogue hides deleted templates, and new workspaces cannot use them.
The draft uses stored configuration only. It does not inspect the workspace disk.
It cannot capture manual packages, files, repositories, project rules, Docker state, Git state, or home dotfiles.
Volumes, SSH keys, box host keys, recipes, and runtime state never enter a template.
Box update state never enters a template either. That covers `box_update_requested`, `box_image_reported`, and the running image.

### Type sketches

These types show the full committed wire shapes.
Markers compare each existing type with `packages/schema/src`.

```ts
// UNCHANGED against packages/schema/src/environment.ts.
export interface WorkspaceEnvironment { env: Record<string, string>; startupScript: string | null }
// NEW.
export interface TemplateFolderInput { id: string; guestPath: string | null }
// NEW. Write shape.
export interface TemplateConnectionInput { provider: string; scopes: string[] }
// CHANGED. Add `scopes`.
export interface TemplateConnectionView { provider: string; scopes: string[] }
// CHANGED. Canonical create shape.
export interface CreateWorkspaceTemplateRequest {
  name: string;
  description: string;
  machineTypeId: string;
  folders: TemplateFolderInput[];
  connections: TemplateConnectionInput[];
  environment?: WorkspaceEnvironment;
  agentRuleId: string | null;
  repos: string[];
}
// NEW. Replacement makes environment handling explicit.
export type TemplateEnvironmentReplacement =
  | { action: "keep" }
  | { action: "replace"; value: WorkspaceEnvironment | null };
// NEW. PUT does not reuse the create name.
export interface ReplaceWorkspaceTemplateRequest {
  name: string;
  description: string;
  machineTypeId: string;
  folders: TemplateFolderInput[];
  connections: TemplateConnectionInput[];
  environment: TemplateEnvironmentReplacement;
  agentRuleId: string | null;
  repos: string[];
}
// NEW.
export interface PublishWorkspaceTemplateRequest {
  reviewDigest: string;
  orgShareRole: "editor" | "viewer" | null;
  isOrgDefault: boolean;
}
// NEW. The catalogue never returns environment contents.
export interface TemplateEnvironmentSummary { variableCount: number; hasStartupScript: boolean }
// NEW.
export interface WorkspaceTemplatePermissions { update: boolean; delete: boolean; publish: boolean }
// CHANGED. Redacted catalogue view.
export interface WorkspaceTemplateView {
  id: string;
  name: string;
  description: string;
  machineTypeId: string;
  createdAt: number;
  createdBy: { name: string; avatarUrl: string | null };
  environment: TemplateEnvironmentSummary | null;
  agentRuleId: string | null;
  isOrgDefault: boolean;
  visibility: "private" | "organization";
  orgShareRole: "editor" | "viewer" | null;
  folders: {
    id: string;
    name: string;
    guestPath: string | null;
    role: "owner" | "admin" | "editor" | "viewer" | null;
  }[];
  connections: TemplateConnectionView[];
  repos: string[];
  permissions: WorkspaceTemplatePermissions;
}
// UNCHANGED envelope with a changed nested view.
export interface ListWorkspaceTemplatesResponse { templates: WorkspaceTemplateView[] }
// UNCHANGED envelope with a changed nested view.
export interface CreateWorkspaceTemplateResponse { template: WorkspaceTemplateView }
// NEW. This array starts with one static item.
export interface TemplateCaptureLimitation { code: "stored-configuration-only"; detail: string }
// NEW.
export interface TemplateDraftResponse {
  draft: CreateWorkspaceTemplateRequest;
  redactedEnvironmentKeys: string[];
  omittedFolderCount: number;
  source: {
    creationSource: "blank" | "template" | null;
    sourceTemplateId: string | null;
    requestedTemplateRepos: string[] | null;
  };
  captureLimitations: TemplateCaptureLimitation[];
}
// NEW. Only administrators receive this response.
export interface PublishWorkspaceTemplateReviewResponse { template: CreateWorkspaceTemplateRequest; agentRule: WorkspaceTemplateLaunchReview["agentRule"]; changesSinceLastPublication: string[]; reviewDigest: string }
// NEW. This response contains no environment values.
export interface WorkspaceTemplateLaunchReview {
  templateId: string;
  startupScript: string | null;
  agentRule: {
    id: string | null;
    name: string;
    content: string;
    updatedAt: number | null;
    builtIn: boolean;
  };
  publishedBy: { name: string; avatarUrl: string | null };
  publishedAt: number;
}
// CHANGED. Add three source fields.
export interface WorkspaceView {
  id: string;
  name: string;
  machineTypeId: string;
  phase: Phase;
  retryAction: RetryAction;
  canObserve: boolean;
  launchable: boolean;
  revision: number;
  ssh: {
    host: string;
    port: number;
    user: string;
    hostPublicKey: string | null;
  } | null;
  volumeId: string | null;
  error: string | null;
  role: WorkspaceRole | null;
  orgShareRole: "editor" | "viewer" | null;
  owner: { name: string; avatarUrl: string | null };
  environment: WorkspaceEnvironment | null;
  agentRuleId: string | null;
  connections: string[];
  recipeId?: string;
  creationSource: "blank" | "template" | null;
  sourceTemplateId: string | null;
  requestedTemplateRepos: string[] | null;
}
```

### Proof obligations

Each test must record a failing result before its implementation change.
Each test must pass after the change and fail again after a local revert.

| Change | Required test | Required failure before change |
|---|---|---|
| Source storage and migration | `packages/control-plane/test/template-provenance-migration.test.ts` and `packages/control-plane/test/blitzdev-schema.test.ts` | Columns remain absent, and future creates lose source data. |
| Browser and Worker contract | Fixture corpus and two parsers | The draft route returns 404. |
| Fidelity round trip | `packages/control-plane/test/workspace-template-roundtrip.test.ts` | The loop loses guest paths, requested repositories, scopes, or sharing intent. |
| Scope ceiling | `packages/control-plane/test/workspace-template-scope-ceiling.test.ts` | Parsing overwrites GitHub, creation drops it, or mint rejects it. |
| Authorization and publication | `packages/control-plane/test/workspace-template-permissions.test.ts` | A viewer reads a draft, or a member publishes executable content. |
| Atomic save and soft delete | `packages/control-plane/test/workspace-template-atomicity.test.ts` | Fault injection leaves partial rows or removes referenced provenance. |
| Browser loop | `packages/webapp/test/save-workspace-as-template.test.tsx` | No workspace action opens an editable, redacted draft. |
| Permission controls | `packages/webapp/test/template-management-permissions.test.tsx` | Unauthorized users see update, delete, or publish controls. |
| Managed build | `packages/control-plane/test/core-manifest.test.ts` and `packages/control-plane/test/blitzdev-emitter.test.ts` | Managed output omits a new core file or schema field. |

Add `packages/schema/fixtures/template-draft/`.
Add `packages/control-plane/test/template-draft-conformance.test.ts`.
Add `packages/webapp/test/template-draft-conformance.test.ts`.

The fixture corpus must cover valid, legacy, secret, cross-organization, and invalid path cases.
It must cover `folderIds`, `folders`, both fields, absent scopes, and empty scopes.
Control-plane and webapp conformance tests must parse the same fixture bytes.
`packages/control-plane/test/wire-drift.test.ts` must cover every changed shared field.

Record one browser run across owner, viewer, member, and administrator accounts.
The run must show redaction, denial, private save, publication, launch review, and round-trip creation.

Run all three repository gates:

```sh
npm run typecheck
npm run lint:gate
npm test
```

### Build steps

1. Add the failing fixtures and tests from the proof table.
2. Add migrations, future-create writers, `BLITZDEV_CONFIG`, and source view fields.
3. Add atomic template routes, publication controls, path handling, and scope enforcement.
4. Add the browser draft, review, publish, and permission flows.
5. Record the browser run and pass every proof obligation.

### Named future changes

- Readiness and setup reporting need a race-safe state machine and an execution barrier.
- Stop and resume need provider contracts, quota rules, and non-destructive microVM behavior.
- Viewer sharing needs chat policy and provider capability handling.
- Organization bootstrap needs a chosen seed or example and its ownership policy.
- Agent-rule revisions need immutable history, approval, pinning, composition, and the current `256 KiB` limit.
- Member API keys need scopes, expiry, revocation, fresh membership checks, and credential precedence.
- Recipe triggers and runs need identity, bounds, deduplication, terminal conditions, stopping, and retention.

### Decisions open to veto

- Derivation uses a read route. Template creation uses a separate write route.
- The first loop supports browser sessions only.
- Every template starts private. Only administrators publish organization templates.
- Drafts omit environment values. Users enter wanted values again.
- Publication uses exact review and a server-keyed digest.
- Scope ceilings must work through parsing, storage, creation, and minting.
- Existing template migrations default to private visibility.
- Template deletion uses soft deletion and keeps provenance.
- Workspace rows call repository values `requestedTemplateRepos`.
- Folder compatibility ends only after telemetry shows no legacy use.
- Template save never changes folder access.
- Volumes and runtime state never enter templates.

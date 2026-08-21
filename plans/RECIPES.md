# Recipes and automatic evals

Status: plan (2026-08-21, rev 3 — thin cut). Supersedes rev 1 (template
extension) and rev 2 (recipe-owned folders). Decision history at the bottom.

A recipe is one row: a template reference plus an invocation — harness, model,
effort, prompt. Nothing else. It is the "routine"/"automation" concept from
cloud-agent products, with one difference that is our differentiation: a recipe
run is not an opaque job, it is a normal BlitzOS workspace — joinable,
multiplayer, watchable, take-over-able.

An eval is not a subsystem. It is one blitz-authored recipe (shipped as a docs
page) whose prompt tells the agent to aggregate the org's real usage and write
evals from it.

## What already exists (verified against main, 2026-08-21)

| Seam | State | Where |
|---|---|---|
| Templates: machine + ≤16 folders + environment + agent rule | Shipped | `core/workspace-templates.ts` |
| Template env + startup script → workspace at create | Shipped (PR #5), three-runtime fixtures | `core/environment.ts`, `schema/fixtures/workspace-environment/` |
| Agent rules → `~/.claude/CLAUDE.md` + `~/.codex/AGENTS.md` at boot | Shipped (PR #3) | `core/agent-rules.ts` |
| Chat prompt path (ACP frames, ticket/token auth, not browser-bound) | Shipped | `box/actor/src/server.ts` |
| Model + effort per ACP session | Shipped | `box/actor/src/agent-config.ts` |
| Harness selection | Image env `BLITZ_AGENT`, read by the actor at start | `box/actor/src/main.ts` |
| Terminal launch | Closed 2–3 arg contract, no prompt channel | `box/rootfs/usr/local/libexec/blitz-term` |
| Native transcripts (tokens, model, full history; chat AND TUI) | Written by the harnesses into agent HOME on the state volume | `/var/lib/blitz/home/.claude/projects/…`, `…/.codex/sessions/…` |
| Transcript export | **None** — HOME sits outside `/workspace`, unreachable by Drive sync | `core/files/sync.ts` |

Two facts set the phase boundary:

1. The bootstrap `docker run` block is control-plane-emitted shell, so a new
   `-e` flag and a `docker exec` reach existing box images.
2. Anything the guest must read or run — the TUI prompt file, the
   `chat_session` rename — ships in one image generation, gated on workspace
   `created_at` (the `BOX_IMAGE_VIEWER_GUARDS_SINCE_MS` pattern).

## The object

One table. No template changes. No recipe-side folders. No launch_role.

```sql
CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES workspace_templates(id),
  harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'chat')),
  model TEXT,
  effort TEXT,
  prompt TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX recipes_org ON recipes(org_id, created_at);
CREATE INDEX recipes_template ON recipes(template_id);

-- provenance: which routine produced this workspace (accepted 2026-08-21)
ALTER TABLE workspaces ADD COLUMN recipe_id TEXT REFERENCES recipes(id);
```

- `chat` is a harness value, not a target flag. Delivery dispatches on this
  one field. For `chat`, the model also selects the adapter provider (the
  catalog maps model → provider).
- Write-time check: a `claude` recipe pins a claude model, `codex` a codex
  model, `chat` any catalog model.
- Gating without `launch_role`: launch re-checks the launcher's access to the
  template's folders (existing skip-unreadable pattern). Data-sensitive
  recipes — the eval recipe included — are gated by their folders' grants: a
  member who launches one gets a workspace without the admin-only folder, not
  a leak.

## Launch mechanics

`POST /recipes/:id/launch` creates a workspace from the template — env,
startup script, agent rule, and folders all ride the existing shipped flows;
nothing new is built for them. The launch stamps `workspaces.recipe_id` for
provenance. The launch adds exactly two things to the
bootstrap payload:

1. `-e BLITZ_AGENT=…` on the `docker run` line (for `chat`, derived from the
   pinned model's provider). Emitted bytes are a pinned contract — update the
   fixtures and both conformance suites in the same change.
2. The prompt file, plus (for `chat`) an inline sender the bootstrap
   `docker exec`s: it waits for the actor with a deadline, connects to
   `127.0.0.1:7444` with the box's own token (localhost origin is allowed),
   sends `initialize` → `session/new` → `session/set_config_option` (model,
   effort, permission mode = bypass) → `session/prompt`, and exits. Best effort, generous deadline,
   failure lands in the workspace error path. No Worker ACP client, no cron
   retry, no state columns.

TUI harnesses (`claude`, `codex`) deliver in Phase 2: `blitz-term` reads the
prompt file and appends it to the harness argv, with model/effort flags where
the harness supports them. No new positional arg — the gateway's read-only
coercion hard-asserts the arg count, and a file keeps that contract intact.
Read-only attach ignores the file.

Webapp: a Run button. An open workspace adopts the live session through the
existing `session/list` + replay path.

## Evals

- Capture (org opt-in): `orgs.usage_capture` + `orgs.usage_folder_id`. The
  bootstrap bind-mounts the two transcript HOME dirs read-only into
  `/workspace/shared/agent-usage/`; a push-only leg of the existing file-sync
  cron copies that subtree guest → R2 into the org usage folder under
  `<workspace-id>/`, with a small `meta.json` sidecar (workspaceId, recipeId,
  owner) so the eval agent groups runs by recipe without a D1 join — AI-read,
  pinned with the directory layout. The folder is lazy-created, admin-only,
  and never attached to member workspaces — a normal two-way attachment would
  broadcast transcripts down into member boxes.
- Corpus: native harness transcripts, opaque vendor blobs. Tokens and model
  are already in them. Attribution is per workspace, from the owner row.
- The eval recipe: a docs page ships the canonical prompt; an admin pastes it
  into a recipe whose template attaches the usage folder plus an output
  folder. The agent aggregates usage and writes evals as files. Running evals
  later is just another recipe. With yolo default (decision 10), the run
  completes unattended; the admin can still open the workspace and watch.

## Phases

**Phase 1 — control plane only, works on existing boxes.** Migration
(`recipes`, `workspaces.recipe_id`, the two `orgs` columns), `core/recipes.ts` + routes + wire types
(wire-drift keeps parity), the `BLITZ_AGENT` flag, prompt file + sender,
usage mounts + push-only sync leg, Run button, eval docs page. Recipes and
evals both work end to end for `chat`.

**Phase 2 — one image generation.** `blitz-term` prompt file (TUI delivery),
and the `chat_session` rename: the journal becomes `chat-session.ts` /
`chat-session.db`, keeps `sessions` + `events` only (they carry list, replay,
resume; both journaled frame shapes live in `events`, so replay keeps
permission history), drops `turns`/`permissions`/`participants`, renames
`journal.db` on first open of a reused volume, and ships a defensive scope
note in the module header and the box README: chat list/replay/resume ONLY,
never an analytics or usage store, do not extend beyond chat.

## How recipes get more powerful (directions, not commitments)

The thin core is a function: environment × invocation → running workspace.
Each power below is an orthogonal addition on an existing seam — none changes
the object.

1. **Provenance first.** *(Accepted 2026-08-21 — in Phase 1.)* One nullable
   `workspaces.recipe_id` column. It turns
   usage capture into per-recipe data: which routines run, succeed, and what
   they cost. Evals grade *recipes*, not just workspaces. This is the cheapest
   enabler on the list and the bridge to the cost/perf pillar.
2. **Triggers.** A trigger is just another caller of `POST /recipes/:id/launch`:
   cron rows on the existing scheduler rail, a webhook route (GitHub event,
   inbound email), or a Drive folder change the sync already notices. Recipe ×
   trigger = the full "routines" feature of cloud-agent products.
3. **Parameters.** `{{variables}}` in the prompt, filled at launch from a form
   or a trigger payload. A recipe becomes a callable function; the pioneer
   writes it once, everyone invokes it with their own input. String
   substitution — no infra.
4. **Outputs as contract.** A recipe's template attaches an output folder;
   results land there as files. Then recipes compose: recipe B's template
   attaches recipe A's output folder. Drive becomes the pipeline bus — no
   orchestrator subsystem.
5. **Recipes as the Workspace API capability model.** The README promises
   agents that provision subagents. Raw {machine, data, creds} delegation is
   dangerous. A recipe catalog is the safe form: give a workspace a scoped
   token that can only launch recipes its launcher could launch, quota-bounded.
   Agents get recursion; the org keeps pre-approved bundles as the boundary.
6. **Batch.** Launch a recipe once per item over a folder of inputs, bounded
   by the existing org VM quota, surfacing the 409 honestly. With outputs (4)
   this is map-reduce over Drive.
7. **Attended automations — the differentiator.** Every run is a multiplayer
   workspace. A human can open a routine mid-run, watch the terminal, answer a
   permission prompt, or take over. Cloud-agent products cannot offer this;
   lean into it in the product language.
8. **Workspace snapshots.** *(Direction accepted 2026-08-21 — see the section
   below.)* Frozen `/workspace` trees in R2 make re-execution evals possible:
   put a new agent into a predecessor's starting state and grade the diff.

## Workspace snapshots (accepted direction, 2026-08-21)

Why: capture saves the trajectory, not the world. A transcript shows what
agent A did. It does not preserve the state A started from. So today an eval
can only judge A's transcript after the fact. It cannot re-run agent B on the
same task from the same starting conditions. Snapshots close that gap.

Mechanism — every step is an existing primitive:

- A snapshot is the `/workspace` tree copied to an R2 prefix,
  `snapshots/<workspace-id>/<label>/`. The walk is the same budgeted WebDAV
  read `usage-push` uses, pointed at `/workspace`.
- Restore is the existing R2 → guest materialization path Drive sync already
  runs (`MKCOL` + `PUT`) into a fresh workspace.
- Two labels per recipe run: `initial`, taken after the setup script and
  before prompt delivery (the bootstrap already has that exact hook point),
  and `final`, taken at turn end.
- The re-execution eval loop: launch from the same template → materialize
  `initial` → send the same prompt → grade the resulting tree against `final`
  or a task grader.

Accepted limits (the thin version):

- `/workspace` only. The agent HOME is deliberately excluded — a fresh agent
  brain is the point of the eval.
- OS state outside `/workspace` (mid-task apt installs, Docker images) is not
  captured. This is a feature: it forces environments to be declared in the
  template's startup script, which is what makes them reproducible at all.
- Needs an ignore list (`node_modules`, build dirs); the sync budgets already
  exist, the excludes are new.
- v0 shortcut for coding tasks: pin a git SHA as the initial state and grade
  the diff — cheaper than tree copies, covers repo work only.

Not chosen: block-level snapshots (Hetzner volume snapshots, Firecracker
snapshot/restore). Full fidelity, but provider-specific, costly, and microVM
has no volume support — the opposite of thin.

## Decisions

1. Separate `recipes` table; template/recipe boundary hard (2026-08-20).
2. Guest-exec delivery via bootstrap; no Worker client, no cron, no browser
   (2026-08-20).
3. TUI prompt via file read by `blitz-term`; never a new argv slot
   (2026-08-20).
4. Usage capture opt-in per org; admin-only folder; push-only sync
   (2026-08-20).
5. Eval recipe ships as a docs page, nothing seeded (2026-08-20).
6. Per-workspace granularity; journal out of the eval path; native transcripts
   are the corpus (2026-08-20).
7. Journal shrinks + renames to `chat_session`, scope-fenced (2026-08-20).
8. Thin cut (2026-08-21): recipe = template + harness + model + effort +
   prompt. Cut from earlier revs: recipe folders, launch_role, template
   manifest/env/rules columns (env + rules had shipped upstream in PRs #5/#3 —
   never duplicate those paths). Credential ceilings stay a workspace-create
   concern for now.
9. Provenance accepted (2026-08-21): nullable `workspaces.recipe_id`, stamped
   at launch; usage export carries a `meta.json` sidecar so evals group by
   recipe.
10. Yolo mode is the default (2026-08-21): recipe runs get permission bypass,
    same as every `blitz-term` session today. Runs complete unattended; the
    sandbox + credential scoping are the boundary. Phase 2 TUI needs no flag
    changes.

## Contracts (per CLAUDE.md)

- The `BLITZ_AGENT` flag and the sender change bootstrap's emitted bytes —
  pinned contract; update fixtures + both conformance suites together.
- The prompt file (control-plane writer ↔ sender/`blitz-term` readers) gets a
  fixture corpus before Phase 2.
- The usage export is deliberately not a parsed contract: vendor-owned opaque
  blobs; only the directory layout is pinned, in the box README.
- ACP replay suites must pass through the `chat_session` rename
  (`fixtures/acp/replay.jsonl`).

## Unattended permission mode (resolved 2026-08-21)

Yolo is the default: recipe runs get permission bypass, matching how
`blitz-term` already launches both harnesses inside the sandboxed VM. The
`chat` sender pins bypass via session config; Phase 2 TUI sessions keep the
existing flags unchanged (zero delta there). The VM sandbox plus the
credential scoping on the workspace remain the security boundary. Joining a
run to watch or take over stays possible — attended is optional, never
required.

Caveat: line citations in this doc predate the 2026-08-21 merges in places —
re-verify against main while implementing.

## Out of scope

- Block-level VM snapshots / commit-image (tree snapshots are the planned
  substitute — see "Workspace snapshots" above).
- Raising `orgs.vm_limit`; batch surfaces the 409.
- An eval runner or scoring UI — evals are files in Drive; running them is
  another recipe.

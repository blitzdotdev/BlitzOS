# TEMPLATES V2 — default template, repos, file attachments

Written 2026-08-21, grounded against main @ 5eac0ec. One PR, one migration
(`0026_templates_v2.sql`). Goal: a template is enough to onboard a new team
member — "log in and all the repos and tools are already there."

## A. Org-default template (checkbox on create/edit)

**Schema** (in `0026_templates_v2.sql`):
```sql
ALTER TABLE orgs ADD COLUMN default_template_id TEXT;
```
No FK — mirrors the `orgs.usage_folder_id` precedent (FK dropped by ruling in
PR #8). Dangling is prevented by the delete handler below, not by the schema.

**API — zero new routes.** Template POST/PUT (`core/workspace-templates.ts`)
accept `isOrgDefault?: boolean`:
- `true` → requires org admin (403 `organization admin required`, house
  pattern from `core/recipes.ts:316`) → `UPDATE orgs SET default_template_id
  = :id` in the same transaction. Setting a new default implicitly clears the
  old one (single pointer, no sweep needed).
- `false` → clears the pointer iff it currently points at this template.
- Omitted → no change (PUT stays a full-replace API for template fields only;
  the org pointer is org state, so absence must not clear it — same reasoning
  as the `agentRuleId` presence rule at `workspace-templates.ts:304`).
- Template DELETE clears the pointer in the same transaction (auto-clear, not
  409 — deleting the template plainly means "no longer the default"; the 409
  precedent stays reserved for dependent entities like recipes).

**Wire.** `WorkspaceTemplateView` gains `isOrgDefault: boolean` (computed via
join against `orgs.default_template_id`); `CreateWorkspaceTemplateRequest`
gains `isOrgDefault?: boolean`. Both change in `core/wire.ts` AND
`packages/schema/src/workspace.ts` — `test/wire-drift.test.ts` pins the copies.

**Webapp.**
- `CreateTemplateScreen.tsx`: checkbox "Default template for {org}" beside the
  org-share checkbox. Rendered only for admins (same viewer-role gate the
  settings tabs use). Checked state loads from the view on edit.
- `CreateWorkspaceDialog.tsx`: new `initialTemplateId?: string | null` prop
  seeding `selectedTemplateId` (`:58`); both mount sites (`CloudApp.tsx:1447`,
  `:2135`) pass the org default (derivable client-side: the template list is
  already loaded; pick the one with `isOrgDefault`). The auto-open
  first-workspace flow (`CloudApp.tsx:646-657`) therefore lands a new member
  in the dialog with the default template already selected — one click to a
  fully provisioned workspace.
- `TemplatesHome.tsx`: "Org default" badge on the card.

## B. Repo field on templates (GitHub App)

Precondition (exists today): the org admin has configured the `github`
connection — app-jwt custody, `app_id` + `installation_id` + PKCS#8 key
(`core/connections/registry.ts:66`, `catalog/github.ts`). The repo picker is
disabled with a "Configure the GitHub connection first" hint until then.

**Schema** (same migration):
```sql
CREATE TABLE workspace_template_repos (
  template_id TEXT NOT NULL REFERENCES workspace_templates(id),
  repo TEXT NOT NULL,            -- "owner/name"
  PRIMARY KEY (template_id, repo)
);
```
Cap `MAX_TEMPLATE_REPOS = 16` beside the folder/connection caps
(`workspace-templates.ts:65`). Validation: `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`,
dedupe, and a 400 when two repos share a directory basename (clone targets
collide). Selecting ≥1 repo auto-attaches the `github` connection row
(server-side, idempotent). Post-#16 the row is a plain (template_id,
provider) stipulation: creation never blocks on it — the workspace
connections panel surfaces github to members instead.

**Repo listing route** — the one new route: `GET
/connections/github/repositories` (under the existing `/connections*`
worker-first prefix, so `route-prefixes.test.ts` is satisfied). Active-member
auth. Implementation: mint an installation token via the existing app-jwt
minter (export the module-private `appJwt()` from
`minters/app-jwt/github-app.ts:60` rather than duplicating), then page GitHub
`GET /installation/repositories` through `fetchBoundedJson` with a small
`per_page` (the 64 KiB `JSON_RESPONSE_MAX_BYTES` cap truncates big pages —
this is why pagination is mandatory), aggregate to `[{fullName, private}]`,
hard cap 200 entries. 409 `connect github` when no admin root is configured.

**Clone mechanics.** A new optional bootstrap segment `repoCloner` following
the `promptSender` pattern (`core/bootstrap.ts:374-389`, emitted at `:664`):
empty string when the template has no repos, so ordinary creates stay
byte-identical and every existing bootstrap pin holds. With repos, it emits
one `nohup docker exec … sh -c '…'` retry loop:
- per repo: `[ -d /workspace/<name>/.git ] || git clone
  https://github.com/<owner>/<name> /workspace/<name>` — idempotent;
- retries every 5s until success or a 10-minute deadline (same shape as the
  recipe sender), because the box can only mint once registration completes;
- auth comes from the baked `/etc/gitconfig` → `blitz-cred git-helper`, which
  mints **CP-direct** (`broker/cmd/blitz-cred/main.go:98`,
  `workspace/cp.go:145`) — no broker box required;
- `|| true` overall: clone failure must never brick a create. Failures land in
  the loop's log file under `/var/lib/blitz/`.

`BootstrapOptions` gains `repos?: string[]`, threaded from
`performWorkspaceCreate` (template repos load beside folders/connections).

**New pins:** bootstrap tests assert the cloner line for a with-repos create,
its absence otherwise, and that the container-spec byte-equality test
(`bootstrap.test.ts:143`) still passes — the segment lives outside the
`docker run` block.

## C. Attachments: folders AND files (uploads)

**Model decision: no new attachment kind.** Loose files wrap into a real
drive folder auto-created per template. Everything downstream — grants,
org-share, `folder_attachments`, guest materialization, `files_ready`
counting (`readiness.ts`), WebDAV sync — works unchanged. The alternatives
(nullable `object_key` on `folder_attachments`, a files table) touch the
monotonic `files_ready` denominator that gates guest startup; a bug there is
unrecoverable per workspace. Not worth it.

**Mechanics.**
- First loose file dropped/picked in the template screen → CP folder create
  named `<template name> files` (fallback `New template files`), attach it
  like any browsed folder; subsequent loose files upload into it via the
  existing `uploadFolderObject` single-PUT/multipart path.
- The folder is a normal visible Drive folder: renameable, shareable via the
  existing org-share checkbox, contents manageable in Drive.
- UI: `CreateTemplateScreen.tsx` drop handler accepts files (delete the
  `'Drop folders, not loose files'` rejection at `:175`), plus an "Upload
  files" button next to the folder browser; the attached sidebar shows the
  files folder with a per-file count. Copy changes from "shared folders" to
  "attachments" so it is clear anything can be attached.

**Size limits** (client-enforced; server already bounds each request):
- per file: 256 MiB (multipart handles >32 MiB transparently);
- per drop: existing `MAX_DROP_FILES = 500` / `MAX_DROP_BYTES = 1 GiB`
  (`drop-upload.ts:20`) now also cover file drops.
No server-side org quota in this cut — no size accounting exists anywhere
today (sizes live only in R2 metadata); a quota is its own future change.

## Tests (all in the PR)

- CP: default-template swap/clear/403/delete-clears; repo validation
  (regex, cap, basename collision, github auto-attach); repo listing
  (minter mocked, pagination, 409 unconfigured); bootstrap `repoCloner`
  emission + byte-identical-without-repos; template view/round-trip with the
  new fields. Wire-drift covers the mirrored types by construction.
- Webapp: admin-only checkbox render + submit; dialog preselect from
  `initialTemplateId` (both mounts); repo picker states (unconfigured /
  loading / select / cap); loose-file drop → folder create + upload calls +
  sidebar rows; copy assertions.
- Gates: typecheck, lint ratchet (counts only fall; warn list must not grow —
  `workspace-templates.ts` and `CreateTemplateScreen.tsx` are near no limits,
  but `bootstrap.ts` is on the warn list already: keep additions lean),
  `BLITZDEV_MANAGED=1 npm test`.

## Rollout

- Worker deploy + migration `0026` (pure additive — safe on canary, client,
  and fresh installs; canary's separate `d1_migrations` reconciliation for
  0022–0025 is unrelated and still required first).
- Repo cloning needs a box image carrying `blitz-cred` + `/etc/gitconfig`
  (v0.1.0 GHCR images have both) and the github connection configured. No
  broker box needed.
- Branch ordering: PR #12 (claude-rc) edits the same bootstrap region and pin
  tests — land #12 first; this branch rebases trivially over it.

## Decisions taken (veto any)

1. Default-template writes ride the template POST/PUT (`isOrgDefault`), no
   new org route; delete auto-clears the pointer.
2. `orgs.default_template_id` carries no FK (house precedent).
3. Repos persist in a join table capped at 16; selecting repos force-attaches
   the `github` connection (a plain stipulation since #16 — no required flag).
4. Clones run as a bootstrap-emitted retry loop (10-min deadline) targeting
   `/workspace/<repo-basename>`; duplicate basenames are a 400 at save time.
5. Repo list endpoint pages with small pages under the 64 KiB response cap
   and returns at most 200 repos.
6. Loose files wrap into an auto-created, visible drive folder — no new
   attachment kind, no `files_ready` changes.
7. Per-file cap 256 MiB, client-enforced; no org storage quota in this cut.

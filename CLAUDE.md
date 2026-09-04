# CLAUDE.md — blitz-core

Rules for agents working in this repo. Optimized for drift sweeps: every
convention here is machine-checkable, and the commands to check it are listed.

## Gates (run all three before claiming success)

```sh
npm run typecheck     # all workspaces, incl. the wire-drift and type-tests
                      # tsconfigs (test/*.type.test.ts holds compile-time
                      # gates, so a @ts-expect-error there is a real gate)
npm run lint:gate     # per-rule ratchet vs lint-baseline.json (see below)
npm test              # control-plane, box guest tests, ui, guest node:test,
                      # house-rule tests, and Python fixture conformance
```

## Lint policy (two plugins + a ratchet)

- `tools/oxlint/anti-slop/` — vendored generic rules (15, all `error`;
  `no-runtime-typeof` runs with `allowInTypeGuards: true`). Never edit it
  locally; a drift sweep should verify `git diff -- tools/oxlint/anti-slop`
  is empty. Re-vendor from upstream instead of patching.
- `tools/oxlint/blitz-house/` — repo-specific rules:
  - `no-raw-fetch`: control-plane core code must call HTTP through
    `core/compute/json-fetch.ts` (75s timeout, 64 KiB cap). Grandfathered
    direct callers carry `TODO(house-canon):` markers.
  - `no-console-in-core`: exact allowlist in `.oxlintrc.json`.
  - `max-lines` warns at 700 lines for package source.
- Ratchet: `lint-baseline.json` + `scripts/lint-gate.mjs`. Counts may only
  fall. When you remove findings, lower the baseline in the same change.
  Never raise the baseline to make a change pass.

## Known debt (as of 2026-08-18)

- 66 anti-slop findings remain, all Tier C: external-boundary code that
  needs real parsers (23 no-unknown-parameters, 27 no-runtime-typeof in
  plain JS, 12 no-unsafe-dictionary-type, 4 no-unknown-returns). The counts
  fell from 74 (31/27/12/4) on 2026-09-02 when the box credential wire and
  the workspace credential store were deleted (plans/ORG-CREDENTIALS.md),
  and before that from 102 (47/27/22/6) on 2026-08-29 when the native-chat
  surface and the box actor were deleted; the baseline moved with them. Fixing one
  requires characterization tests FIRST — these fixes can change accepted
  inputs. Plan and history: GitHub issue #1.
- 6 `TODO(deslop-tier-c):` markers flag type assertions whose invariant is
  not actually enforced today (latent-bug candidates). Grep for the marker.
- `TODO(house-canon):` markers flag direct fetch/console sites awaiting
  migration to the canon helpers.
- 8 files exceed the 700-line warn: `core/bootstrap.ts`, `core/compute/aws.ts`,
  `core/machines.ts`, `core/workspaces.ts`,
  `control-plane/scripts/lib/worker-source.mjs`, `webapp/src/CloudApp.tsx`,
  `webapp/src/api.ts`, `webapp/src/terminal-touch-controller.ts`. Split on
  touch, never big-bang. (`core/files/sync.ts` left the list 2026-08-21 when
  its transfer plumbing split into `core/files/dav.ts`. `core/bootstrap.ts`
  and `webapp/src/api.ts` were already over the line when this list said four;
  `core/machines.ts` was over it when the list said seven. The count is
  corrected here, not grown — `lint:gate` on an untouched `main` prints all
  eight.)

## Cross-runtime contracts (fixtures are the source of truth)

Any payload that crosses a runtime boundary (TS ↔ Go ↔ bash ↔ Python ↔
browser) MUST have a fixture corpus under `packages/schema/fixtures/` and
conformance tests on BOTH sides. Never hand-edit one side of a contract.

| Contract | Sides | Fixtures | Conformance tests |
|---|---|---|---|
| box-image manifest | `scripts/lib/worker-source.mjs` producer ↔ Python inside `core/bootstrap.ts` | `fixtures/box-image-manifest/` | `test/box-image-files.test.ts`, `test/bootstrap-python.test.mjs` (runs real `python3`) |
| version report | `core/version.ts` producer ↔ `scripts/check-box-image.mjs` (reads `commit`) and the verify step of `.github/workflows/canary.yml` (reads `commit` and `boxImageTag` with jq) | `fixtures/version/` | `test/version.test.ts` + `test/deploy-tooling.test.mjs` |
| phone-home v1 | bash in `core/bootstrap.ts` + `microvm-host/guest/blitz-microvm-enroll.js` ↔ `core/workspaces.ts` | `fixtures/phone-home/` | `test/phone-home-conformance.test.ts`, `guest/blitz-microvm-enroll.test.js` |
| MICROVM_HOSTS | runtime + deploy share ONE parser | n/a (shared code) | `core/compute/microvm-hosts.js` imported by both |
| dufs WebDAV listing | `core/files/sync.ts` parser ↔ dufs in the box image | `fixtures/dav-listing/` | `test/dav-listing-fixtures.test.ts` (TS side; guest side revalidates at box-image rebuild) |
| public preview links | box CLI state ↔ Go gateway ↔ browser | `fixtures/previews/` | `gateway/main_test.go`, `webapp/test/preview-v2.test.ts` |
| preview-focus | `blitz browser open <port\|file\|https-url>` CLI (`blitz teenyapp open` and `blitz preview open` stay aliases for the port form; version-2 marker with a `kind`, version 1 still read) ↔ Go gateway (`/preview-focus`) ↔ browser (`webapp/src/preview.ts` consumer; `CloudApp` opens the browser panel, `webapp/src/browser/`, or a preview tab) | `fixtures/preview-focus/` | `box/guest-tests/test/preview-focus-conformance.test.ts` (producer), `gateway/main_test.go` (reader), `webapp/test/preview-focus.test.ts` (browser consumer) |
| connections-focus | `blitz connections open <provider>` CLI ↔ Go gateway (`/connections-focus`) ↔ browser (`webapp/src/connections-focus.ts` consumer via `use-workspace-connections-focus.ts`, opens the workspace connections panel with the provider selected) | `fixtures/connections-focus/` | `box/guest-tests/test/connections-focus-conformance.test.ts` (producer), `gateway/main_test.go` (reader), `webapp/test/connections-focus.test.ts` (browser consumer) |
| webApp ticket v1 | `core/webapp-tickets.ts` mint/verify ↔ `box/gateway/main.go` | `fixtures/webapp-ticket/` | `test/webapp-ticket-conformance.test.ts`, `gateway/main_test.go` (ticket_conformance_test.go) |
| schema ↔ wire copy | `packages/schema/src` ↔ `control-plane/core/wire.ts` | n/a | `test/wire-drift.test.ts` (full field coverage) |
| microVM agent protocol | `microvm-host/types.go` ↔ `core/compute/microvm-agent.ts` | none yet — add fixtures before changing either side | — |
| webApp box surface | `core/webapp-surface.ts` ↔ `schema/src/webapp-surface.ts` (webApp resolver) | n/a | `test/webapp-surface-drift.test.ts`, `webapp/test/webapp-surface.test.ts` |
| agent rules | CP `core/agent-rules.ts` producer (`GET /workspaces/self/agent-rules`) ↔ box `blitz-rules sync` consumer (`box/rootfs/usr/local/bin/blitz-rules`); `AGENT_RULES_DOC` mirrors the canonical `box/rootfs/opt/blitz/skel/agent-rules.md` | `fixtures/agent-rules/` | `test/agent-rules-conformance.test.ts` + `test/agent-rules-drift.test.ts` (CP), `box/guest-tests/test/agent-rules-conformance.test.ts` (box) |
| entitlements | CP `core/entitlements.ts` (`PUT /orgs/:id/entitlements` writer, `GET /orgs/:id/usage`, the 402 seat-limit refusal and its HS256 handoff token) ↔ the PRIVATE billing service, which owns plans, writes the integers, and verifies the token — core never learns a plan name | `fixtures/entitlements/` | `test/entitlements-fixtures.test.ts` (CP); the billing service copies the corpus and pins it on its side |
| recipe invocation files | `core/bootstrap.ts` writer (recipe launches emit `/var/lib/blitz/recipe/prompt.txt` + `invocation.env`) ↔ the guest reader `blitz-term`, through the shared parser `box/rootfs/usr/local/libexec/blitz-recipe-invocation` | `fixtures/recipe-invocation/` | `test/recipe-invocation-fixtures.test.ts` (CP), `box/guest-tests/test/recipe-invocation-guest.test.ts` (guest: shared parser vs corpus + blitz-term delivery semantics) |
| machine-stats | guest producer `box/rootfs/usr/local/bin/blitz-machine-stats` (s6 longrun `machine-stats`, one report every 10 min) ↔ CP consumer `core/machine-stats.ts` (`POST /workspaces/self/machine-stats`), which fills `machines.disk_used_percent` and surfaces as `MachineView.volumeUsedPercent` | `fixtures/machine-stats/` | `test/machine-stats-conformance.test.ts` (CP), `box/guest-tests/test/machine-stats-conformance.test.ts` (guest: the real script against a local origin) |
| lody data-plane v7 | browser `webapp/src/lody/data-plane-connection.ts` ↔ node `box/rootfs/usr/local/libexec/blitz-lody-bridge` ↔ the `lody` daemon (not in this tree). The SCHEMA stays Lody's (`vendor/lody/packages/shared/src/local-loro-data-plane.ts`, `protocolVersion` is a `z.literal(7)`); what became ours in phase 2 is the FRAMING — one WebSocket text message is one JSON frame, newline-delimited on the daemon's side | `fixtures/lody-data-plane/` (server frames captured from a real `lody@0.88.1`) | `webapp/test/lody-data-plane-frames.test.ts` (browser producer/parser), `box/guest-tests/test/lody-bridge-frames.test.ts` (runs the real bridge script against a stand-in daemon socket) |
| lody local-project registration | box node `box/rootfs/usr/local/libexec/blitz-lody-projects` (registers each `/workspace/<repo>` clone) ↔ browser `webapp/src/lody/local-bridge.ts` + `rpc-client.ts` + `local-projects.ts` (`registerWorkspaceRepositories`, the same sweep driven from the tab) ↔ the `lody` daemon's `/project-control` (not in this tree). The SCHEMA stays Lody's (`vendor/lody/packages/shared/src/message-schemas.ts`, `LocalProjectControlRequest`/`Response`); what is ours is that two BlitzOS producers keep agreeing with it | `fixtures/lody-project-registration/` (responses captured from a real `lody@0.88.1`) | `box/guest-tests/test/lody-projects-registration.test.ts` (runs the real registrar against a stand-in daemon socket), `webapp/test/lody-project-control-frames.test.ts` (browser producer/parser) |
| lody session-control stream | browser `webapp/src/lody/rpc-client.ts` (`sendSessionControl`) ↔ node `box/rootfs/usr/local/libexec/blitz-lody-bridge` ↔ the `lody` daemon's `/session-control` (not in this tree). The daemon picks NDJSON-per-response or one buffered envelope from the request's `Accept`; ours is the browser that negotiates and reads it frame by frame, and the bridge decision that carries the negotiation upstream. The FRAME UNION stays Lody's (`vendor/lody/packages/shared/src/node/local-ipc.ts:80`, `{kind:'response'\|'complete'\|'error'}`) — it is not exported and its module is node-only, so `rpc-client.ts` re-states it and the corpus keeps the copy honest | `fixtures/lody-session-control-stream/` (bodies captured from a real `lody@0.88.1` through the real bridge) | `webapp/test/lody-session-control-stream.test.ts` (browser consumer: frames emitted before the promise settles, at adversarial chunk boundaries), `box/guest-tests/test/lody-bridge-control-stream.test.ts` (runs the real bridge against a stand-in daemon that holds its stream open), `webapp/test/lody-acp-authentication.test.ts` (whole chain against a real daemon; skips without the bundle) |
| lody share claim | Go gateway `box/gateway/main.go` (verifies the webApp ticket's `share` claim and forwards it on `X-Blitz-Lody-Share`, stripping any inbound copy) ↔ node `box/rootfs/usr/local/libexec/blitz-lody-bridge` (room ACL on `/sync`, session scoping on `/rpc` and `/project`, `/control` refused, `/platform` narrowed). The claim's OWN wire format is pinned by the webApp-ticket corpus on three runtimes; what this pins is the hand-off and the decisions the bridge makes from it | `fixtures/lody-share-claim/` | `gateway/main_test.go` (producer: the header bytes + the path allowlist), `box/guest-tests/test/lody-bridge-share.test.ts` (consumer: runs the real bridge against a stand-in daemon over the whole decision table) |
| box config v1 | CP `core/box-config.ts` producer (`GET /workspaces/self/box-config`) and consumer (`POST /workspaces/self/box-update-result`) ↔ host updater bash/python emitted by `core/bootstrap.ts` (`blitz-box-update`; cloud-VM path only — the microVM provider has its own guest lifecycle and no update path yet) | `fixtures/box-config/` | `test/box-config-conformance.test.ts` (CP), `test/box-update-conformance.test.mjs` (runs real `python3` over the emitted parser/producer, `bash -n` over the emitted scripts), `test/box-update-host.test.mjs` (runs the emitted updater in real bash against a live CP over real curl) |
| agent API doc | schema types (`packages/schema/src`) + route manifest `core/agent-api-manifest.ts` → generator `control-plane/scripts/generate-agent-api.mjs` (`npm run openapi:generate`; ts-json-schema-generator, no hand-written JSON Schema) → the generated OpenAPI 3.1 document, served verbatim by `core/agent-api.ts` (`GET /agent/api`, box-authed) ↔ agents reading it from a box | `packages/schema/openapi/agent-api.json` (the checked-in artifact IS the fixture) | `test/agent-api-coverage.test.ts` (router ↔ manifest ↔ document, both directions), `test/agent-api-conformance.test.ts` (every `/agent/*` happy-path body against the document's schemas; the served bytes equal the artifact), `test/agent-api-generate.test.mjs` (regenerates in plain Node and demands identical bytes) |

Retired 2026-09-02: the `connection pull v1`, `credential import v1` and
`credential list v1` contracts — box credential wire deleted with the
workspace credential store (plans/ORG-CREDENTIALS.md). Corpora
(`fixtures/connection-pull/`, `fixtures/credential-import/`,
`fixtures/credential-list/`), both sides' conformance tests, and the five
`/workspaces/self/*` credential routes are gone with no shim; the agent plane
is plain HTTP under `/agent/*` (`core/agent-routes.ts`, session twin
`core/org-credentials.ts`).

Retired 2026-08-29: the `ACP` contract (box actor ↔ ui chat reducer,
`fixtures/acp/`). The native-chat surface, the box actor on port 7444, its
SQLite session journal and the recipe `chat` harness are deleted — see
`plans/LODY-SESSIONS.md`. Port 7444 stays in every reserved-port list and in
`fixtures/preview-ports/` because boxes already in the field still run the old
actor. Guest-side conformance tests moved from `box/actor/test/` to
`packages/box/guest-tests/test/`.

Retired: the `workspace environment` contract (`GET /workspaces/self/environment`
→ `creds/env.d/00-workspace.sh`). Workspace credentials serve through
`blitz-cred` alone — see `plans/MEMBER-MACHINES.md` §1. The route stays only for
box images already in the field, which tolerate an empty answer.

Legacy phone-home shapes are accepted ONLY inside
`adaptLegacyPhoneHomeRequestForInFlightImages` in `core/workspaces.ts`.
Do not add aliases anywhere else.

## Vendored Lody: rules and upstream merges

`vendor/lody` is a squashed git subtree of https://github.com/LodyAI/Lody
(Apache-2.0). The box does NOT build it — it installs the prebuilt npm `lody`
daemon (`packages/box/Dockerfile`). The subtree commit and the npm version are
one verified pair, both pinned in `vendor/lody/UPSTREAM.md`: bump them together.

- Integration code never goes inside `vendor/lody`; it lives in
  `packages/webapp/src/lody/`.
- The ONLY allowed in-vendor edits are the seam patches declared in
  `vendor/lody/BLITZ-PATCHES.md`, each with an upstream-PR sketch. Declare a new
  vendor edit there first, or do not make it.
- The daemon patches in `packages/box/patches/` (`lody-local-platform.mjs`,
  cloud→local platform; `lody-acp-auth-queue.mjs`, the ACP-auth queue chain;
  `lody-code-collab-worktree-root.mjs`, Code Collab's worktree root;
  `lody-builtin-mcp-off.mjs`, no per-session `lody-mcp-server` child;
  `lody-session-sandbox.mjs`, per-session cgroup leaves beside `lody.scope`
  with no capacity split) are
  guarded against the published bundle (sha256; version + anchor count) and must
  be re-verified on every daemon bump.
- Upstream merges follow the runbook `docs/LODY-MERGE.md`. Where Lody upstream
  and BlitzOS disagree, copy Lody's behavior rather than reconcile the two
  (`plans/LODY-SESSIONS.md` §0 bias rule).

## Member machines: what a workspace is now

`plans/MEMBER-MACHINES.md` landed in migrations 0041-0044. Two invariants an
agent must not undo:

- **A workspace is configuration; a `machines` row is the VM.** The workspace
  has no phase, no `vm_id`, and no environment. `WorkspaceView.phase` and
  `.ssh` survive as a projection of the REQUESTING member's machine, so old
  pollers keep converging — do not start storing them again.
- **The acting principal is resolved at call time** from
  `machines.membership_id` (`core/oauth.ts`, `core/connections/mint.ts`).
  Nothing about who a guest acts as is stored beside its credential. The row
  that used to hold it pinned the workspace owner, and that is the bug the
  structure now prevents.

Three compatibility surfaces are load-bearing and have no expiry date yet:
`GET /boxes/:id/feed` (served from `machines`),
`GET /workspaces/:id/environment` (a constant `{env:{}, startupScript:null,
filesReady:true}`, because deployed brokers poll it every second at boot and
wait for exactly those three fields), and the token families migration 0041
copied hash-for-hash so no deployed guest had to re-enrol.

The `workspace environment` cross-runtime contract is retired with its fixtures
and both conformance tests: no runtime reads the route any more, so what remains
is that constant three-field shim, pinned alone by
`control-plane/test/workspace-environment.test.ts`.

Every field of `WorkspaceView` is required, including `members`,
`credentials`, `myRole`, `defaultMachineTypeId` and `autoProvision`. The only
client is `packages/webapp`, built from `packages/schema` in this tree, so a
server that drops a field fails `test/wire-drift.test.ts` rather than the
browser. Do not make one optional to spare a fixture.

Templates and Recipes are disabled product-wide (2026-08-29), on both sides:

- Control plane: the two registrations are commented out in `core/app.ts`.
- Webapp: the `/templates*` and `/recipes*` branches are commented out in
  `sessions-page-state.ts`, so those addresses fall through to Drive, and
  `shell/SecondaryRoutes.tsx` no longer renders them.

The page components (`TemplatesHome`, `RecipesHome`, `CreateTemplateScreen`,
`CreateRecipeScreen`), the client methods and the recipe rows are untouched
and unreachable. Restoring a surface means restoring both branches.

## Settings surface style (webapp)

`packages/webapp/src/settings-surface.css` is canon for every
settings-shaped screen: the workspace-details dialog and its three tabs,
"My machine", the account settings page and its panels, and the section
headings of the create-workspace dialog. One class prefix, `cfg-`; the rules
and the whole vocabulary are documented at the top of that file. Read it
before restyling a settings surface, and extend it rather than starting a
seventh heading treatment somewhere else.

The four rules a change must not break:

- The tabbed dialog has ONE fixed height. `.workspace-details-dialog` sets
  `height`, not `max-height`; the body scrolls; switching tabs never moves
  the frame.
- Section titles are sentence case, never all-caps, always `--cfg-title-*`
  (the ink white and size the "Agent rules" heading had). Descriptions are
  `--cfg-desc-*`. Field micro-labels are sentence case too.
- Exactly one thin divider between two adjacent sections, drawn by
  `.cfg-section ~ .cfg-section` and by nothing else. Card outlines and
  list-row separators are structure, not dividers.
- No new colours: everything resolves to a token in `tokens.css`.

## VM provider architecture (do not regress)

- The plugin contract is `VmProvider` in `core/compute/types.ts`:
  `id`, `ownsMachineType`, `ownsVmId`, capabilities, lifecycle, optional
  `proxyWebApp`. New backends implement it and register in
  `VmProviderRegistry` (`core/compute/registry.ts`). That is all.
- Routing rules: resolve by registry lookup, never by string prefix.
  Exactly-one-claimant or fail loudly (400 unknown/ambiguous type, 409
  unowned VM id). Janitors log and skip unowned rows. No fallback provider.
- Capabilities are per-provider. Ask the resolved provider, never a global.
- `core/bootstrap.ts` generates bash+Python inline because Workers cannot
  read files at runtime. Its emitted bytes are a contract pinned by tests.
  Do not edit the emitted script casually. Extraction to build-time text
  imports is an approved future direction (see issue #1 discussion).

## Box image: canary from R2, client prod from GHCR

- Canary serves the box image as an R2 archive (mode B) from its own account.
  Client prod serves it from GHCR (mode A), pushed by `.github/workflows/release.yml`
  on a `v*` tag.
- `write:packages` lives only inside that workflow, so no workspace or agent
  credential can push to GHCR. Never cut a tag to refresh an image: the same tag
  ships client prod.
- Every push to `main` makes the `image` job in `.github/workflows/canary.yml`
  derive a release from the Dockerfile inputs, reuse its valid versioned R2
  archive or build it with Lody on and publish it, then pass the exact pin to
  the deploy job. A human does not rebake or edit canary pins.

## Hetzner: one project behind both deployments

Canary and client prod share ONE Hetzner project. Verified 2026-08-28: of the
8 servers labelled `blitz-purpose=workspace` in it, canary's database claims 1.
The rest are prod's.

Consequences an agent must not learn the hard way:

- **A golden snapshot id is valid for both.** `HETZNER_SERVER_IMAGES` is pinned
  to the same `*=<id>` in `canary.yml` and `release.yml`. That is correct
  here, and correct only because of the shared project — a snapshot cannot
  cross Hetzner projects.
- **`*` is every location, and that is deliberate.** A Hetzner snapshot carries
  an architecture and no location at all, so one x86 image boots every x86 type
  in the project. Measured 2026-08-28: `cx23@hel1` reaches its relocated sshd in
  41.3 s, `cpx21@hil` in 40.1 s, from the same image. Per-location entries exist
  in the parser for the day an arm image is baked, not because x86 needs them.
- **Deleting a snapshot breaks both deployments at once.** Neither breaks
  loudly: `HetznerProvider` warns `hetzner_server_image_rejected` and falls
  back to stock Ubuntu, so the only symptom is every create paying the full
  bootstrap again. Rebake with `npm run golden:bake -- --location hel1` and
  update BOTH workflows.
- **A server or volume you did not create probably belongs to the other
  deployment.** Match by the `blitz-workspace` label against the right D1
  before touching anything. Never sweep the project by hand.
- **A BYOK organization is a different project**, so the golden image never
  reaches it, and its stock-Ubuntu creates are correct rather than broken.

The image only reaches an org with `org_entitlements.platform_compute = 1`,
because both deployments run `byok-required` and the image is wired to the
deployment credential alone (`plans/SUBSCRIPTION-COMPUTE.md`).

## Drift sweep runbook (for scheduled agent sweeps)

1. Run the three gates. Any failure is a finding.
2. `node scripts/lint-gate.mjs` — compare per-rule counts to
   `lint-baseline.json`. Counts above baseline: regression. Counts below:
   report that the baseline should be lowered.
3. `git diff --stat -- tools/oxlint/anti-slop` — must be empty (no local
   edits to the vendored plugin).
4. `grep -rn 'TODO(deslop-tier-c)\|TODO(house-canon)' packages --include='*.ts' --include='*.tsx'`
   — report the counts; falling is progress, rising needs justification.
5. Contract check: every row in the table above still has its fixture dir
   and both conformance tests present and passing. A new cross-runtime
   payload without fixtures is a finding.
6. Max-lines: the warn list printed by `lint:gate` should not grow.
6a. `/agent/api` coverage + conformance tests green (`test/agent-api-coverage.test.ts`,
   `test/agent-api-conformance.test.ts`, `npm run test:openapi -w @blitzos/control-plane`);
   `npm run openapi:generate` must leave `packages/schema/openapi/agent-api.json` unchanged.
7. Reference counts for comparison (2026-09-02): anti-slop 66
   (23/27/12/4), blitz-house 0, max-lines warnings 8. These are the numbers
   a sweep compares against, so lower them in the same change that removes
   findings — a stale reference hides the next regression.

## When adding code

- External data (HTTP, WebSocket, subprocess, storage, env) gets parsed at
  the boundary into a named type. No `unknown` in exported signatures.
- Type assertions need a `// SAFETY:` comment stating the checked invariant.
  If you cannot state it truthfully, the assertion is a bug — parse instead.
- HTTP from control-plane core goes through `json-fetch.ts`. Errors in core
  go through the structured logging chokepoints, not bare `console.*`.
- Prefer editing the four split seams (`scripts/lib/`, ui hooks,
  `terminal-touch-*`, `microvm-*`) over regrowing the monoliths.

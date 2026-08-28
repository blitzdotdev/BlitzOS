# CLAUDE.md — blitz-core

Rules for agents working in this repo. Optimized for drift sweeps: every
convention here is machine-checkable, and the commands to check it are listed.

## Gates (run all three before claiming success)

```sh
npm run typecheck     # all workspaces, incl. the wire-drift and type-tests
                      # tsconfigs (test/*.type.test.ts holds compile-time
                      # gates, so a @ts-expect-error there is a real gate)
npm run lint:gate     # per-rule ratchet vs lint-baseline.json (see below)
npm test              # control-plane, box actor, ui, guest node:test,
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

- 102 anti-slop findings remain, all Tier C: external-boundary code that
  needs real parsers (47 no-unknown-parameters, 27 no-runtime-typeof in
  plain JS, 22 no-unsafe-dictionary-type, 6 no-unknown-returns). Fixing one
  requires characterization tests FIRST — these fixes can change accepted
  inputs. Plan and history: GitHub issue #1.
- 16 `TODO(deslop-tier-c):` markers flag type assertions whose invariant is
  not actually enforced today (latent-bug candidates). Grep for the marker.
- `TODO(house-canon):` markers flag direct fetch/console sites awaiting
  migration to the canon helpers.
- 7 files exceed the 700-line warn: `core/bootstrap.ts`, `core/compute/aws.ts`,
  `core/workspaces.ts`,
  `control-plane/scripts/lib/worker-source.mjs`, `webapp/src/CloudApp.tsx`,
  `webapp/src/api.ts`, `webapp/src/terminal-touch-controller.ts`. Split on
  touch, never big-bang. (`core/files/sync.ts` left the list 2026-08-21 when
  its transfer plumbing split into `core/files/dav.ts`. `core/bootstrap.ts`
  and `webapp/src/api.ts` were already over the line when this list said four;
  the count is corrected here, not grown.)

## Cross-runtime contracts (fixtures are the source of truth)

Any payload that crosses a runtime boundary (TS ↔ Go ↔ bash ↔ Python ↔
browser) MUST have a fixture corpus under `packages/schema/fixtures/` and
conformance tests on BOTH sides. Never hand-edit one side of a contract.

| Contract | Sides | Fixtures | Conformance tests |
|---|---|---|---|
| box-image manifest | `scripts/lib/worker-source.mjs` producer ↔ Python inside `core/bootstrap.ts` | `fixtures/box-image-manifest/` | `test/box-image-files.test.ts`, `test/bootstrap-python.test.mjs` (runs real `python3`) |
| phone-home v1 | bash in `core/bootstrap.ts` + `microvm-host/guest/blitz-microvm-enroll.js` ↔ `core/workspaces.ts` | `fixtures/phone-home/` | `test/phone-home-conformance.test.ts`, `guest/blitz-microvm-enroll.test.js` |
| ACP | box actor ↔ ui chat reducer | `fixtures/acp/` | existing suites both sides |
| MICROVM_HOSTS | runtime + deploy share ONE parser | n/a (shared code) | `core/compute/microvm-hosts.js` imported by both |
| dufs WebDAV listing | `core/files/sync.ts` parser ↔ dufs in the box image | `fixtures/dav-listing/` | `test/dav-listing-fixtures.test.ts` (TS side; guest side revalidates at box-image rebuild) |
| public preview links | box CLI state ↔ Go gateway ↔ browser | `fixtures/previews/` | `gateway/main_test.go`, `webapp/test/preview-v2.test.ts` |
| workspace environment | `core/environment.ts` route ↔ `broker/internal/workspace/environment.go` ↔ `box/actor/src/credentials.ts` (`env` only) | `fixtures/workspace-environment/` | `test/workspace-environment-conformance.test.ts`, `broker` `environment_test.go`, `actor/test/workspace-environment.test.ts` |
| preview-focus | `blitz teenyapp open` CLI (`blitz preview` stays a silent alias; wire unchanged) ↔ Go gateway (`/preview-focus`) ↔ browser (`webapp/src/preview.ts` consumer, auto-opens the focus) | `fixtures/preview-focus/` | `box/actor/test/preview-focus-conformance.test.ts` (producer), `gateway/main_test.go` (reader), `webapp/test/preview-focus.test.ts` (browser consumer) |
| connections-focus | `blitz connections open <provider>` CLI ↔ Go gateway (`/connections-focus`) ↔ browser (`webapp/src/connections-focus.ts` consumer via `use-workspace-connections-focus.ts`, opens the workspace connections panel with the provider selected) | `fixtures/connections-focus/` | `box/actor/test/connections-focus-conformance.test.ts` (producer), `gateway/main_test.go` (reader), `webapp/test/connections-focus.test.ts` (browser consumer) |
| webApp ticket v1 | `core/webapp-tickets.ts` mint/verify ↔ `box/gateway/main.go` ↔ `box/actor/src/auth.ts` | `fixtures/webapp-ticket/` | `test/webapp-ticket-conformance.test.ts`, `gateway/main_test.go` (ticket_conformance_test.go), `actor/test/auth-conformance.test.ts` |
| schema ↔ wire copy | `packages/schema/src` ↔ `control-plane/core/wire.ts` | n/a | `test/wire-drift.test.ts` (full field coverage) |
| microVM agent protocol | `microvm-host/types.go` ↔ `core/compute/microvm-agent.ts` | none yet — add fixtures before changing either side | — |
| webApp box surface | `core/webapp-surface.ts` ↔ `schema/src/webapp-surface.ts` (webApp resolver) | n/a | `test/webapp-surface-drift.test.ts`, `webapp/test/webapp-surface.test.ts` |
| agent rules | CP `core/agent-rules.ts` producer (`GET /workspaces/self/agent-rules`) ↔ box `blitz-rules sync` consumer (`box/rootfs/usr/local/bin/blitz-rules`); `AGENT_RULES_DOC` mirrors the canonical `box/rootfs/opt/blitz/skel/agent-rules.md` | `fixtures/agent-rules/` | `test/agent-rules-conformance.test.ts` + `test/agent-rules-drift.test.ts` (CP), `box/actor/test/agent-rules-conformance.test.ts` (box) |
| connection pull v1 | CP producer `core/connections/pull-wire.ts` (`GET /workspaces/self/connections`, `POST /workspaces/self/connections/:name/token`) ↔ Go consumer `broker/internal/workspace/connections.go`, printed by `blitz-cred list\|get\|env` | `fixtures/connection-pull/` | `test/connection-pull-conformance.test.ts` + `test/pull-credentials.test.ts` (CP), `broker/internal/workspace/connections_test.go` + `broker/cmd/blitz-cred/main_test.go` (box) |
| entitlements | CP `core/entitlements.ts` (`PUT /orgs/:id/entitlements` writer, `GET /orgs/:id/usage`, the 402 seat-limit refusal and its HS256 handoff token) ↔ the PRIVATE billing service, which owns plans, writes the integers, and verifies the token — core never learns a plan name | `fixtures/entitlements/` | `test/entitlements-fixtures.test.ts` (CP); the billing service copies the corpus and pins it on its side |
| recipe invocation files | `core/bootstrap.ts` writer (recipe launches emit `/var/lib/blitz/recipe/prompt.txt` + `invocation.env`) ↔ guest readers: `blitz-term` through the shared parser `box/rootfs/usr/local/libexec/blitz-recipe-invocation`, plus the bootstrap-emitted chat sender's raw `prompt.txt` read (the sender never parses `invocation.env` — model/effort/permission are interpolated into its source at render time) | `fixtures/recipe-invocation/` | `test/recipe-invocation-fixtures.test.ts` (CP), `box/actor/test/recipe-invocation-guest.test.ts` (guest: shared parser vs corpus + blitz-term delivery semantics) |
| box config v1 | CP `core/box-config.ts` producer (`GET /workspaces/self/box-config`) and consumer (`POST /workspaces/self/box-update-result`) ↔ host updater bash/python emitted by `core/bootstrap.ts` (`blitz-box-update`; cloud-VM path only — the microVM provider has its own guest lifecycle and no update path yet) | `fixtures/box-config/` | `test/box-config-conformance.test.ts` (CP), `test/box-update-conformance.test.mjs` (runs real `python3` over the emitted parser/producer, `bash -n` over the emitted scripts), `test/box-update-host.test.mjs` (runs the emitted updater in real bash against a live CP over real curl) |

Legacy phone-home shapes are accepted ONLY inside
`adaptLegacyPhoneHomeRequestForInFlightImages` in `core/workspaces.ts`.
Do not add aliases anywhere else.

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
7. Reference counts for comparison (2026-08-26): anti-slop 102
   (47/27/22/6), blitz-house 0, max-lines warnings 7. These are the numbers
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

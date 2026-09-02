# Credential broker retirement

Status: **design draft, 2026-09-02.** The product decision is to remove the
credential broker completely. It is not a supported or intended authentication
mode, yet hosted boxes still enroll into it automatically and it can override a
working native Claude or Codex login.

This plan removes that override, deletes the broker daemon and control-plane
registry, and keeps only the unrelated machine-authentication primitives that
currently happen to live in `packages/broker`.

## 0. Incident and proof

The canary `blitzos-feats` workspace reproduced two different outcomes with the
same user, machine, Codex installation, and `~/.codex/auth.json`:

- the configured `blitz` model provider could not obtain a broker credential
  and timed out; existing processes using a cached credential returned HTTP 401
  from `https://chatgpt.com/backend-api/codex/responses`;
- overriding only `model_provider` to the native `openai` provider completed a
  real Codex request successfully (`NATIVE_OK`, exit 0).

`codex login status` reported `Logged in using ChatGPT`, and the local access
token had not expired. The failure was therefore not a user logout. The box had
silently replaced native authentication with this block, written by
`blitz-cred register`:

```toml
model_provider = "blitz"

[model_providers.blitz]
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"

[model_providers.blitz.auth]
command = "/usr/local/bin/blitz-cred-codex"
refresh_interval_ms = 300000
```

The broker watcher was not running and a fresh token request did not complete.
All Lody Codex sessions shared the same home and provider configuration, which
made the failure workspace-wide.

## 1. Locked decisions

1. **Delete the broker feature, not merely disable it.** There will be no
   broker daemon, broker OCI image, SSH mint/deposit protocol, placement,
   registry API, watcher, or broker-backed Claude/Codex path left in active
   source.
2. **Claude and Codex use their native per-user authentication stores.** A
   hosted box does not rewrite either CLI's provider or move its refresh token
   elsewhere.
3. **Do not delete machine authentication.** `packages/broker` also contains
   the schema-free `blitz-cred api-token` helper, device enrollment, token
   refresh, cross-process locking, and atomic credential storage. Those are not
   broker features. Move them under `packages/box` before deleting the package.
4. **Keep the executable name `blitz-cred`.** Agent rules and the Git credential
   helper already invoke `blitz-cred api-token`. Renaming it would add an
   unrelated box-image compatibility break.
5. **No migration of vendor credentials out of broker storage.** Exporting
   refresh tokens would recreate the custody path being deleted. If an audit
   finds a broker-only credential, the member signs in natively again.
6. **Existing boxes must be actively unwired.** `/var/lib/blitz/home` survives
   image replacement, so deleting writers from the next image is insufficient.
7. **Roll out in two releases.** The first release stops new assignments and
   cleans boxes while retaining compatibility routes for old images. The second
   removes the control-plane schema and broker infrastructure after fleet
   convergence.
8. **Lody's auth-error classification is separate.** Removing the broker fixes
   this incident, but a future genuine native 401 can still be mislabeled
   `acp_internal_error`. That UI defect is fixed independently rather than
   keeping a broker as an authentication-status oracle.

## 2. What is deleted and what moves

### Delete

- Broker image and daemon:
  - `packages/broker/Dockerfile`, `entrypoint.sh`, `sshd_config`;
  - `cmd/blitz-broker`;
  - `internal/broker`, `internal/feed`, and `internal/vendor`;
  - broker provisioning and verification scripts.
- Workspace-side broker behavior:
  - `blitz-cred register`, `token claude|codex`, and `watch`;
  - SSH key generation, pinning, mint, and deposit;
  - Codex's managed `blitz` provider block;
  - `/usr/local/bin/blitz-cred-claude` and
    `/usr/local/bin/blitz-cred-codex`;
  - the `register` and `watch` s6 services;
  - bootstrap and microVM post-enrollment `blitz-cred register` pokes.
- Control-plane broker behavior:
  - `core/registry.ts` and its four routes;
  - broker placement, membership, feed generation, and key cleanup;
  - `broker_boxes`, `broker_members`, and `broker_keys`;
  - `boxes.is_broker`, `boxes.broker_box_id`, and
    `machines.broker_box_id`;
  - broker wire types and conformance coverage.
- Release and repository plumbing:
  - the broker CI job and OCI publish step;
  - broker digests in release notes;
  - the root test invocation of broker provisioning tests;
  - `BLITZ_BROKER_STATE_DIR`;
  - broker package links and active setup documentation.

### Move under `packages/box`

- the `blitz-cred` entry point, reduced to:
  - `api-token`;
  - `enroll --origin URL`;
  - help.
- origin validation and device-code enrollment;
- `box-credential.json` load/save and atomic replacement;
- access-token validation, refresh, refresh grace handling, and the
  cross-process refresh lock;
- the focused tests for those behaviors.

The new module should be named for box authentication, not for a broker. A
suggested location is `packages/box/credential-helper`, built as a separate Go
module by `packages/box/Dockerfile`. Do not put it in the gateway package: the
gateway is a server and the helper is a local credential client with a distinct
privilege boundary.

### Keep

- `origin`, `box-credential.json`, and machine token families;
- machine/device OAuth issuance and refresh routes;
- `blitz-cred api-token` as the one local primitive used to call `/agent/*`;
- native Claude and Codex login files under the member's home;
- the terminal Codex device-code offer for a genuinely signed-out box;
- agent provider/model catalogs. Move their `claude`/`codex` constant out of
  broker wire modules rather than deleting the catalog with the broker.

The legacy `boxes` and `box_token_families` tables cannot be deleted as part of
this work: device-code enrollments still use them. Only their broker-specific
columns and branches leave.

## 3. Release A: retire and drain

Release A prevents new broker use, cleans persistent boxes, and leaves enough
of the old control-plane contract for old images to fail cleanly during the
rollout window.

### 3.1 Control plane: stop assignments without breaking old boxes

Keep `POST /boxes/:id/keys` temporarily, but make it return the existing
machine-readable `409 { error: "no_broker_capacity" }` result for every
request. The old `blitz-cred register` already interprets that exact response
as a request to remove its broker files and marked Codex configuration.

During this release:

- refuse new broker enrollment;
- retain the existing feed for already-enrolled brokers until the credential
  custody audit in section 5 completes;
- log old-image key registration attempts without request bodies or keys, so
  fleet convergence has an observable signal;
- do not drop broker tables or clear existing keys yet. Doing so before boxes
  are updated would turn the drain into an avoidable outage for any member
  whose only credential is on the broker.

### 3.2 Box: move the machine-auth helper

Create the box-owned Go module and copy only the generic code named in section
2. Preserve these properties with characterization tests before moving it:

- an access token is returned only after an authenticated probe, unless the
  control plane is unreachable;
- exactly HTTP 401 triggers refresh;
- refresh is serialized across processes with a lock whose inode is not the
  credential file;
- the credential is re-read while holding the lock;
- a rotated credential is atomically written only after the server accepts the
  single-use refresh token;
- response bodies remain capped and decoded strictly;
- origins require HTTPS except for localhost;
- stdout from `api-token` contains only the token and one newline.

Update `packages/box/Dockerfile` to build `/usr/local/bin/blitz-cred` from the
new module. Update CI and the PR checklist so the new module's Go tests are a
required gate.

### 3.3 Box: remove broker services and launch behavior

- Delete the `register` and `watch` service definitions and remove them from
  the user bundle.
- Services that currently depend on `register` should depend on `enroll`
  instead. This retains the current `init-state -> enroll -> services` ordering
  without the broker barrier.
- Delete `blitz-register` and both token helpers.
- Remove the best-effort registration poke from cloud bootstrap and
  `blitz-microvm-enroll`.
- Simplify the Claude shim to exec the native CLI without attempting a broker
  mint. Leave an explicitly supplied `CLAUDE_CODE_OAUTH_TOKEN` to Claude itself.
- Keep the Codex PATH shim, but remove every broker-specific comment and probe
  from `blitz-codex-session`.
- Update Lody agent-config comments and harness fixtures that currently claim
  the Claude shim mints through the broker.

### 3.4 Box: clean persisted broker state

Add an idempotent boot migration, run from `blitz-init-state` before Lody or a
terminal can launch an agent. It must:

1. remove every complete region delimited by:
   - `# BEGIN blitz-broker (top-level keys)` / matching end marker;
   - `# BEGIN blitz-broker (provider)` / matching end marker;
2. restore the assignment carried by a
   `# blitz-broker preserved: model_provider = ...` comment when the remaining
   file does not already contain a top-level `model_provider`;
3. preserve all unrelated bytes and permissions in `.codex/config.toml`;
4. leave `.codex/auth.json` and every Claude credential file untouched;
5. remove `broker.json`, broker `known_hosts`, and the mint/deposit keypairs
   from the box state directory;
6. log only whether cleanup occurred, never configuration contents;
7. succeed when every target is already absent.

Do not implement this as broad TOML rewriting. The old writer deliberately used
markers because TOML table position makes a bare `model_provider` sensitive to
where it is restored. Port the existing marker semantics and test adversarial
files: duplicate regions, CRLF, missing final newline, user tables before and
after the regions, a preserved custom provider, and an already-clean file.

The migration should remain in the image for at least one full client release
after Release B, so a stopped machine that misses the initial rollout is still
repaired when it next boots.

### 3.5 Release A acceptance

- A seeded broker-wired config is repaired on boot and a second boot is
  byte-identical.
- A native `auth.json` remains byte-identical through the migration.
- With a valid ChatGPT login, ordinary `codex exec` uses provider `openai` and
  completes a real request without `-c model_provider=...`.
- A Lody Codex session completes through `/usr/local/bin/codex` with the same
  native login.
- A Lody Claude session completes through native Claude authentication.
- A genuinely signed-out terminal Codex tab still offers device authentication.
- `blitz-cred api-token`, agent credential requests, Git credential minting,
  rules sync, and machine operations survive an access-token rotation.
- The s6 graph contains no `register` or `watch` service and every remaining
  longrun reaches ready.
- Cloud and microVM enrollment do not invoke the deleted verbs.
- The box image builds for amd64 and arm64.

## 4. Fleet convergence gate

Do not begin Release B merely because Release A deployed. Establish all of the
following:

- every active cloud machine reports the Release A box image;
- every active microVM incarnation has been recreated on that image;
- stopped machines are either started and migrated or explicitly recorded as
  relying on the retained boot migration;
- no active machine has produced a key-registration attempt for one full
  observation window;
- a representative existing Codex login and a fresh native login both complete
  through Lody;
- no active box has `model_provider = "blitz"`, a
  `/usr/local/bin/blitz-cred-codex` auth command, or a running broker watcher.

The checks must report booleans, counts, versions, and file presence only. They
must never print vendor or machine credentials.

## 5. Credential custody audit and broker shutdown

The old watcher deleted a workspace's local Claude or Codex credential after a
broker acknowledged its deposit. Consequently, "nobody intended to use the
broker" does not prove the broker disk is empty: the automatic boot path was
enough to enroll boxes and the watcher could have moved credentials without a
separate product action.

Before deleting broker volumes:

1. Count enrolled broker boxes, broker members, and per-provider credential
   files. Record counts only.
2. Identify affected principals without reading credential contents.
3. Notify affected members that native sign-in will be required. Do not export
   or copy refresh tokens back to workspaces.
4. Stop broker containers and observe native agent traffic during a bounded
   rollback window.
5. Delete broker containers and volumes only after the product owner explicitly
   approves the count and re-login impact.

This operational deletion is intentionally not performed by a repository
migration. It targets external state and needs an exact inventory at execution
time.

## 6. Release B: purge

After section 4 and section 5 are complete:

### 6.1 Control plane and schema

- Unregister and delete `core/registry.ts`.
- Delete broker feed/key registration types from `packages/schema` and
  `core/wire.ts`; remove their wire-drift and control-plane tests.
- Move the provider tuple used by agent and recipe catalogs into
  `agent-catalog.ts` (and its control-plane mirror) before deleting
  `schema/src/broker.ts`.
- Remove `BoxIdentity.isBroker` and broker-only branches from OAuth queries.
- Remove broker key cleanup statements from machine destroy and orphan
  janitors.
- Remove `broker_box_id` from active machine/box row types.
- Add a forward migration that rebuilds referencing SQLite tables as required,
  then drops `broker_keys`, `broker_members`, and `broker_boxes`. Historical
  migrations remain immutable.
- Update the BlitzDev declarative schema and schema tests in the same change.

The migration order must respect the foreign keys from `machines` and `boxes`
to `broker_boxes`: remove or rebuild the referencing columns before dropping
the target table. Test the migration against both an empty database and a
fixture containing broker rows and assigned machines.

### 6.2 Delete the package and release surface

- Delete the remaining `packages/broker` tree.
- Remove the broker job from CI and the broker image from the release workflow.
- Remove broker digest handling from GitHub release notes.
- Remove broker paths from box-image rebuild detection.
- Remove broker commands from root scripts, CONTRIBUTING, READMEs, and the PR
  template.
- Mark `CREDENTIAL-ROAMING.md` and the broker portions of older credential plans
  retired rather than rewriting their historical decisions.
- Update `CLAUDE.md` contract notes and known-debt counts if the deletion lowers
  lint findings.

### 6.3 Release B acceptance

- Active source, workflows, image contents, and service graphs contain no
  broker daemon, route, helper, provider, or state path.
- Historical migrations and explicitly retired design documents are the only
  allowed textual broker references.
- New databases and upgraded databases have the same schema.
- A broker-era database upgrades with no dangling foreign keys.
- The box image contains `blitz-cred` with only `api-token`, `enroll`, and help.
- Release notes publish only the box image digest.
- `npm run typecheck`, `npm run lint:gate`, and `npm test` pass.
- All Go modules pass `go test ./...`.

## 7. Rollback

Release A is reversible by rolling back the control plane and box image. A
rolled-back box may generate new SSH keys and re-register; the retained broker
feed and database make that possible during the drain window.

Release B is a point of no return for broker operation. Once its database
migration and volume deletion complete, an old control plane or box image that
expects broker tables cannot be restored safely. Take the ordinary database
backup, record the final custody counts, and treat every failure after that
point as roll-forward.

Native vendor sign-in remains the recovery path throughout. Never restore the
broker provider block merely to make a rollback easier.

## 8. Definition of done

The broker retirement is complete when:

- no box can enroll with, deposit to, or mint from a broker;
- no control-plane endpoint can create or serve broker state;
- no release builds or advertises a broker image;
- existing broker-wired homes are repaired without losing native auth or user
  configuration;
- Claude and Codex sessions use only their native authentication mechanisms;
- the generic machine bearer can still refresh safely and drive `/agent/*`;
- broker infrastructure and credential volumes have been audited and deleted;
- the independent Lody native-auth error-classification defect is tracked and
  is not confused with completion of this removal.

# Credentials e2e report — 2026-08-14

Live verification of `plans/CREDENTIALS.md` phases 1–4 against the self-hosted production stack,
on **both provider paths**, each booting an unpatched production image (**zero in-box install**).
Suite: `e2e/credentials.mjs` (`CP_URL`, `OPERATOR_API_KEY`, `HETZNER_API_KEY`, `MACHINE_TYPE`).

| Leg | Machine type | Image under test | Result | Workspace |
|---|---|---|---|---|
| microvm (lab host `192.168.5.25`) | `mv-2c2g@lab` | rootfs `blitz-box-base-m2-v5-creds-d6c6ce07.ext4` | **13 PASS / 0 FAIL / 1 SKIP** | `efc62463…` |
| Hetzner cloud VM (docker path) | `cx23@fsn1` | `blitz-box:20260814-amd64` via R2 multipart (archive sha `db41bc6b…`) | **13 PASS / 0 FAIL / 1 SKIP** | `fef3a7e0…` |

Control plane `blitz-control-plane` (workers.dev), final version `c7113f16`. All workspaces
ledgered and destroyed; the Hetzner project returned to its pre-run six servers.

## Result by gate

| Step | Gate | Result | Evidence |
|---|---|---|---|
| 0/A/B | preflight, cross-compile, integration upserts | PASS | three `PUT /integrations` 204; roots never echoed |
| 1 | workspace ready + SSH | PASS | microvm ready; pinned host key |
| 2 | box bits ship in the image | PASS | `/usr/local/bin/blitz-cred`, `/etc/profile.d/blitz-creds.sh`, `/etc/gitconfig` present in the booted image; the baked `blitz-cred` speaks `sync`+`git-helper`; nothing installed |
| 3 | §4.1 zero-agent-action | PASS | fresh login shell ran only `printenv HCLOUD_TOKEN`; the profile hook synced and delivered the sentinel |
| 4 | lease visible | PASS | one active `hetzner-inject` lease on `GET /workspaces/:id/leases` |
| 5 | denied mint | PASS | two denied `blitz-cred token resend-e2e` runs; stderr `access to resend-e2e requested (<id>), awaiting approval`; `denied` events written |
| 6 | §4.3 proxy data path | PASS | in-box node fetch through `/proxy/:leaseId/*` → real Hetzner API `200`, `servers=6`; **zero occurrences of the real key in the box environment**; lease token traveled in the `Authorization` header only |
| 7 | revoke kills the token | PASS | `DELETE /leases/:id` 204 → same in-box call `401` |
| 8 | §3.13 request loop | PASS | two denials deduped to one pending request; approve widened the manifest; the box's plain retry minted; fresh shell saw the value; pending count back to 0; a mint for a never-configured name also filed a request |
| 9 | §4.1 destroy-with-active-lease | PASS | destroy 200 with 2 active leases; all leases survive as `revoked`/`expired` with `boxId=null` |
| 10 | §4.2 GitHub App live clone | **SKIP** | needs a real GitHub App (see blocked items) |
| T | teardown | PASS | workspace destroyed; 3 integrations deleted; pending requests denied |

Incidental live proofs during the debug loop: destroying a box holding active leases succeeded
(the `ON DELETE SET NULL` design), and denying a request whose integration had been deleted
succeeded after the deny fix below.

## Image parity

Neither leg patches the box: both boot production images carrying the credential machinery.

**Microvm rootfs**: baked on the lab host (`blitz-box-base-m2-v5-creds-d6c6ce07.ext4`,
loop-mounted copy of the previous base + `install` of `blitz-cred`, the system profile hook,
and the system gitconfig, sha256-published like every prior version). The agent config points
at it; the agent restarted under systemd and reconciled — the pre-existing protected VM kept
running throughout.

**Hetzner docker image**: rebuilt from `packages/box/Dockerfile` for linux/amd64 as
`blitz-box:20260814-amd64`, `docker save | gzip`, split into four ≤200 MiB parts, uploaded to
the `blitz-box-images` R2 bucket under `box-image/` with read-back verification, new
`manifest.json` published last, `BOX_IMAGE_TAG`/`BOX_IMAGE_SHA256` flipped, CP redeployed. The
previous manifest is backed up for rollback; old parts remain untouched under their old names.

Suite step 2 defaults to **verify** mode: it asserts the three files ship in the booted image
and that the baked `blitz-cred` understands the credential CLI (`sync`, `git-helper`), so a
stale image fails loudly. A byte-hash comparison against the runner's cross-compile was tried
first and dropped: the Docker image builds its own stripped Linux binary, so equal bytes only
ever hold when both come from one pipeline. `INSTALL_BOX_BITS=1` keeps the user-level install
path for older images. Earlier interim runs that used that path are superseded by the baked runs.

Operational note: the lab host's `trycloudflare` quick tunnel rotated its hostname mid-day
(old URL dead, agent healthy). `MICROVM_HOSTS` in `wrangler.toml` was updated and the CP
redeployed. A named tunnel would remove this failure class.

## Defects found by the live loop (all fixed)

1. **Suite masked its own install failure.** `… && rmdir … || :` made the trailing `|| :`
   swallow the whole `&&` chain, so a missing `sudo` reported PASS. The install status is now
   captured before cleanup.
2. **Box image reality vs suite assumptions.** No `sudo`, no `curl`, no `wget`, no `python3`
   in the image (bash, node 22, timeout present). The suite now installs at user level and
   drives the proxy gate with node's `fetch`.
3. **Phase-4 stderr forms.** The suite matched the phase-1 message; it now accepts both forms
   and extracts the request id.
4. **Cross-run feed pollution.** Pending requests survive teardown, so global count assertions
   broke reruns. Assertions now filter by the run's workspace; teardown denies its leftovers.
5. **Product fix: deny required the integration to exist.** `POST /requests/:id/deny` returned
   409 for a request naming a never-configured integration — but §3.13 makes exactly that
   request the "add this provider" signal a human must be able to decline. Deny now checks only
   pending-state and approver identity; approve keeps the grantability checks
   (`core/credentials/requests.ts`).

## Unit/typecheck baseline behind the live run

- control plane: 105 vitest tests (workerd pool, real D1 migrations), typecheck clean
- ui: 26 tests + production build; schema: 9 tests
- broker (Go): build, vet, test green; linux/amd64 cross-build of `blitz-cred`
- migration `0003_credentials.sql` applied remotely by the deploy; `CRED_MASTER_KEY` provisioned
  as a Worker secret and required by the deploy validator

## Blocked / not covered here

- **Step 10 (GitHub App live clone)**: requires creating a GitHub App (Console action, owner-only),
  installing it on a private repo, and pasting the PKCS#8 key. The minter itself is covered by
  signature-verified unit tests (JWT claims, granted-scope recording, PKCS#1 rejection with the
  conversion hint). Set `GITHUB_E2E=1` plus an integration named `github` to run the live clone.
- **Phase 5 (mode b)**: blocked on the owner-side unlocks (teenybase PR #11 deploy, npm publish).
  The emitter already carries all credential modules and the five deny-all tables, pinned by tests.
- **Phase 6 (inherit mode)**: blocked on identity plane C, as planned.
- **MicroVM on Hetzner**: not possible on this account — `/dev/kvm` is unavailable on the
  console's instance types, so the microvm leg runs on the LAN lab host only.

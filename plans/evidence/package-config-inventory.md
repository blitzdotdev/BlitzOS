# Package configuration inventory

Inventory date: 2026-08-15. Scope: direct packages under `packages/` plus
their shell, Docker, systemd, s6, Vite, Wrangler, build, and test surfaces.
The scan covered `os.Getenv`/`os.LookupEnv`, `process.env`, `import.meta.env`,
Cloudflare Worker binding reads, shell parameter expansion, Docker
`ARG`/`ENV`, systemd `Environment`/`EnvironmentFile`, and Wrangler bindings.

Classifications used below:

- **declared env**: belongs in the package's `config.json` contract;
- **non-env**: OS identity, build/test/command input, persisted state, or a
  platform resource binding rather than package configuration;
- **obsolete**: retained for now but scheduled for removal by migration step
  5.

An assignment to a child process is listed when it is important to the
boundary, even when the reader is owned by another package. Generic ambient
variables passed through to agent subprocesses remain undeclared, as required
by the resolution rules.

## box

| Name | Read or surface | Classification | Declaration / reason |
| --- | --- | --- | --- |
| `BLITZ_AGENT` | `actor/src/main.ts` | declared env | `string`, default `claude`, enum `claude`/`codex` |
| `BLITZ_ALLOWED_ORIGINS` | `actor/src/config.ts` | declared env | Optional comma-separated string; empty intentionally means no extra origins |
| `BLITZ_CP_ORIGIN` | `rootfs/usr/local/libexec/blitz-init-state` | declared env | Optional control-plane origin written to the box state directory |
| `BLITZ_GID` | `rootfs/usr/local/libexec/blitz-init-state`, smoke launch | declared env | `integer`, default 1000, range 1–60000 |
| `BLITZ_STATE_DIR` | actor, init/enroll/register/profile scripts, Docker `ENV`, s6 child environments; `blitz-cred` reads it | declared env | `string`, default `/var/lib/blitz` |
| `BLITZ_UID` | `rootfs/usr/local/libexec/blitz-init-state`, smoke launch | declared env | `integer`, default 1000, range 1–60000 |
| `HOME`, `USER`, `LANG`, `LC_ALL` | Docker and s6 fixed child environments | non-env | Runtime OS identity/locale; system users are outside the package contract |
| `SHELL` | `rootfs/usr/local/libexec/blitz-term` | non-env | Login-account input with passwd-database fallback |
| `BUILDPLATFORM`, `TARGETARCH` | Docker build stages | non-env | Docker/BuildKit build inputs |
| `IMAGE` | `test/smoke.sh` | non-env | Test command input selecting or naming an image |
| `FILES_BASE` | `test/files-smoke.sh` | non-env | Test command input supplied by the smoke harness |
| `PREVIEW_FIXTURE_PORT` | `test/preview-fixture.mjs` | non-env | Test fixture input |
| `TTYD_URL`, `TTYD_INPUT` | `test/ttyd-client.mjs` | non-env | Test fixture inputs |
| `TMPDIR` | smoke/files test temporary-directory creation | non-env | Standard test-runner ambient input |
| ambient `process.env` and `creds/env.d/*.sh` names | actor adapters and credential loader | non-env | Provider credentials are command inputs persisted in state; the package forwards/sources them without owning concrete names |

Summary: **6 declared env, 14 non-env, 0 obsolete** (unique rows; the
ambient provider row represents an intentionally open set).

Notable boundary: `blitz-cred` is built from the broker Go module but runs in
the box image. Its `/var/lib/blitz` state-directory default therefore belongs
to the box declaration, while the broker daemon's default is different.

## broker

| Name | Read or surface | Classification | Declaration / reason |
| --- | --- | --- | --- |
| `BLITZ_STATE_DIR` | both Go commands and `entrypoint.sh` | declared env | `string`, default `/var/lib/blitz-broker` for the broker daemon |
| `SSH_CONNECTION` | `cmd/blitz-broker/main.go` forced-command guard | non-env | OpenSSH protocol input, not operator configuration |
| `SSH_ORIGINAL_COMMAND` | `cmd/blitz-broker/main.go` harness selection | non-env | OpenSSH command input, validated against persisted member policy |
| `PATH` | `internal/broker/security_test.go` | non-env | Test-only inherited tool-search path extended with a fixture binary directory |
| enrollment `--origin`, `--host`, `--port` | command flags persisted as broker state | non-env | Explicit enrollment command inputs; the plan requires that they remain out of env declarations |

Summary: **1 declared env, 4 non-env, 0 obsolete**.

## control-plane

| Name | Read or surface | Classification | Declaration / reason |
| --- | --- | --- | --- |
| `APP_URL` | `teenybase.ts` `$APP_URL`; Wrangler var | declared env | Portable loopback default replaces deployment-specific Wrangler value in the declaration only |
| `BOX_IMAGE_REF` | Worker runtime; Wrangler var | declared env | Portable local image-tag default in the declaration |
| `BOX_IMAGE_SHA256` | Worker runtime; Wrangler var | declared env | Optional string; empty is meaningful for a local image reference |
| `BOX_IMAGE_TAG` | Worker runtime; Wrangler var | declared env | Optional string; empty is meaningful for a local image reference |
| `CRED_MASTER_KEY` | Worker initialization and scheduled handler | declared env | Required secret binding, no default |
| `HETZNER_API_TOKEN` | `providersFor` | declared env | Optional secret binding; required only when Hetzner operations are used |
| `JWT_SECRET_MAIN` | `teenybase.ts` `$JWT_SECRET_MAIN` | declared env | Required secret binding, no default |
| `MAX_CONCURRENT_WORKSPACES` | Worker runtime; Wrangler var | declared env | `integer`, default 10, range 1–1000 |
| `MICROVM_HOSTS` | `providersFor`; Wrangler var | declared env | `json`, default empty array; program code owns the stricter host shape |
| `MICROVM_LAB_TOKEN` | dynamically resolved from checked-in `MICROVM_HOSTS.tokenVar` | declared env | Optional secret binding, no default; validation checks the referenced name |
| `OPERATOR_API_KEY` | principal source | declared env | Required secret binding, no default |
| `RESPOND_WITH_ERRORS` | Teenybase Worker binding | declared env | `boolean`, default false |
| `RESPOND_WITH_QUERY_LOG` | Teenybase Worker binding | declared env | `boolean`, default false |
| `SESSION_TTL_DAYS` | Worker runtime; Wrangler var | declared env | `integer`, default 30, range 1–3650 |
| `DB`, `BOX_IMAGES` | Worker and tests; Wrangler D1/R2 bindings | non-env | Provider resource bindings, explicitly outside `config.json` |
| `TEENY_PRIMARY_DB`, `TEENY_PRIMARY_R2` | generated Blitz target | non-env | Provider resource bindings in generated output |
| `TEST_MIGRATIONS` | Vitest Worker binding | non-env | Test-only data binding |
| `CI` and ambient `process.env` | deploy script child environment | non-env | Command execution environment, not control-plane runtime configuration |
| `BLITZ_REPORTER_TEST_DIR`, `BLITZ_REPORTER_OLD_TOKEN`, `BLITZ_REPORTER_NEW_TOKEN`, `CP_URL`, `HOST_NAME`, `TOKEN_FILE`, `PATH`, `TMPDIR` | `test/shell-syntax.sh` | non-env | Test-harness inputs for the microvm-host reporter, not control-plane configuration |

Summary: **14 declared env, 15 non-env, 0 obsolete** (including the ambient
deploy passthrough as one intentionally open set).

The checked-in Wrangler D1 database ID and R2 bucket name are deployment
resource metadata, not environment variables. Dynamically named microVM token
bindings are configuration secrets; the current checked-in name is declared,
while arbitrary test-only token names are fixtures.

## microvm-host

The Go agent now loads the declared names below at startup through the shared
helper. The former `-config deploy/config.host.json` path and the obsolete
`lab_dir` setting have been removed.

| Former file input / name | Declared name | Classification at inventory | Declaration / reason |
| --- | --- | --- | --- |
| `listen_addr` | `BLITZ_MICROVM_LISTEN_ADDR` | declared env (migration target) | Default `0.0.0.0:8086` |
| `public_host_ip` | `BLITZ_MICROVM_PUBLIC_HOST_IP` | declared env (migration target) | Required; no machine address is checked in as a default |
| `token_file` | `BLITZ_MICROVM_TOKEN_FILE` | declared env (migration target) | Declares only a protected file path, never token contents |
| `state_dir` | `BLITZ_MICROVM_STATE_DIR` | declared env (migration target) | Portable `/var/lib/blitz-microvm` default |
| `firecracker_bin` | `BLITZ_MICROVM_FIRECRACKER_BIN` | declared env (migration target) | Portable installed path |
| `firecracker_version` | `BLITZ_MICROVM_FIRECRACKER_VERSION` | declared env (migration target) | Version string |
| fixed guest resolvers | `BLITZ_MICROVM_GUEST_DNS` | declared env | JSON array with the existing resolver pair as its portable default; Go validates one to three distinct IPv4 addresses |
| `kernel_image` | `BLITZ_MICROVM_KERNEL_IMAGE` | declared env (migration target) | Portable state path |
| `kernel_version` | `BLITZ_MICROVM_KERNEL_VERSION` | declared env (migration target) | Version string |
| `rootfs_image` | `BLITZ_MICROVM_ROOTFS_IMAGE` | declared env (migration target) | Portable state path |
| `sudo_wrapper` | `BLITZ_MICROVM_SUDO_WRAPPER` | declared env (migration target) | Portable installed path |
| `network_prefix` | `BLITZ_MICROVM_NETWORK_PREFIX` | declared env (migration target) | Default `172.30`; compound network validation stays in Go |
| `network_octet_base` | `BLITZ_MICROVM_NETWORK_OCTET_BASE` | declared env (migration target) | Bounded integer |
| `slot_count` | `BLITZ_MICROVM_SLOT_COUNT` | declared env (migration target) | Positive bounded integer |
| `ssh_port_base` | `BLITZ_MICROVM_SSH_PORT_BASE` | declared env (migration target) | Default 22000, range 1024–65535 |
| `upper_size_bytes` | `BLITZ_MICROVM_UPPER_SIZE_BYTES` | declared env (migration target) | Integer with existing 64 MiB minimum |
| `total_cpu` | `BLITZ_MICROVM_TOTAL_CPU` | declared env (migration target) | Required host capacity; no machine-specific default |
| `cpu_overcommit` | `BLITZ_MICROVM_CPU_OVERCOMMIT` | declared env (migration target) | Number, portable default 1 |
| `total_mem_mb` | `BLITZ_MICROVM_TOTAL_MEM_MB` | declared env (migration target) | Required host capacity; no machine-specific default |
| `max_vms` | `BLITZ_MICROVM_MAX_VMS` | declared env (migration target) | Positive bounded integer |
| `shutdown_timeout_seconds` | `BLITZ_MICROVM_SHUTDOWN_TIMEOUT_SECONDS` | declared env (migration target) | Default 10, range 1–60 |
| `CP_URL` | tunnel reporter environment file/script | declared env | Optional for the primary agent; the optional reporter requires a stable control-plane origin when launched |
| `HOST_NAME` | tunnel reporter environment file/script | declared env | Optional for the primary agent; the optional reporter requires a registered host name when launched |
| `TOKEN_FILE` | tunnel reporter environment file/script | declared env | Optional for the primary agent; the reporter requires a protected token-file path, not a secret value, when launched |
| `USER` | `linux_backend.go`; systemd | non-env | OS account identity; systemd `User=` is explicitly a non-goal |
| `HOME`, `PATH` | build/init/systemd fixed or inherited values | non-env | OS/tool execution environment |
| `BLITZ_BASE_SOURCE`, `BLITZ_M2_BASE_OUTPUT`, `BLITZ_M2_INIT`, `BLITZ_M2_ENROLL` | `guest/build-rootfs-m2.sh` | non-env | Offline build-tool command inputs, not agent startup configuration |
| `BLITZ_MICROVM_PHONE_HOME_B64`, `BLITZ_MICROVM_CP_ORIGIN_B64`, `BLITZ_MICROVM_WORKSPACE_B64` | guest init/enrollment | non-env | Per-VM kernel/boot command inputs, not host ambient configuration |
| ambient `process.env` | guest enrollment child process | non-env | Passed through to `blitz-cred`; concrete box/provider inputs remain owned by their source rather than the host declaration |
| `BLITZ_STATE_DIR` | fixed guest child environment | non-env | Box-owned child setting |
| `BLITZ_AGENT_REMOTE`, `BLITZ_AGENT_HOST`, `BLITZ_AGENT_PORT`, `BLITZ_AGENT_TOKEN_FILE`, `BLITZ_REMOTE_LAB`, `BLITZ_RECEIVER_PORT`, `BLITZ_TEST_CP_ORIGIN`, `BLITZ_RESULT_DIR` | `integration/live-test.sh` | non-env | Integration-test command inputs; remote identity, address, fixture path, and token path are required inputs with no personal defaults |

Summary: **24 declared env (21 agent values and 3 optional reporter reads),
20 non-env, 0 obsolete**.

Open decision 2 is resolved by declaring guest DNS. The host validates the
JSON array and passes it as a kernel argument; guest init no longer embeds a
fixed resolver list.

## ui

| Name | Read or surface | Classification | Declaration / reason |
| --- | --- | --- | --- |
| `VITE_CONTROL_PLANE_URL` | `src/main.tsx` via `import.meta.env` | declared env | Public string; empty default preserves same-origin behavior |
| CSS `env(safe-area-inset-bottom)` | several stylesheets | non-env | CSS browser safe-area function, not a process environment variable |
| integration credential placement names such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `HCLOUD_TOKEN` | settings UI data model | non-env | User-selected command inputs persisted by the control plane; the UI never reads them from its own environment |

Summary: **1 declared env, 2 non-env, 0 obsolete**.

## schema

No `os.Getenv`/`LookupEnv`, `process.env`, `import.meta.env`, shell, Docker,
systemd, s6, Vite, or Wrangler environment read exists. The `kind: "env"`
credential-placement union is protocol data describing command inputs, not a
schema-package environment read.

Summary: **0 declared env, 1 non-env protocol concept, 0 obsolete**. Per the
plan, `packages/schema/config.json` must not be created.

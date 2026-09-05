# Lody sessions — phase 1 probe results

> **Dated evidence.** As of 2026-09-04, the npm-artifact patch and daemon-pin
> rules below are superseded by `docs/LODY-MERGE.md` and
> `plans/LODY-DAEMON-FROM-TREE.md`. The measured 2026-08-29 behavior remains
> historical evidence.

Measured 2026-08-29 on this Linux box, against npm `lody@0.88.1` and the
vendored subtree at upstream `966623d0` (`apps/cli` version 0.76.0). Plan of
record: `plans/LODY-SESSIONS.md`. Phase 0 results: `lody-phase0.md`.

Every command below ran headless, with no Lody account and no network login.

| Question | Verdict |
|---|---|
| A.a daemon runs headless, no login | **YES — but only after a one-line patch.** The published npm artifact is the *cloud* build and hard-refuses. |
| A.b transport | **RELAY-BRIDGE (path i). Proven end to end.** No transport patch needed. |
| A.c session creation without the UI | **YES**, over the daemon's control socket (`/session-control`, `/machine-rpc`). The `lody session` CLI is cloud-only and unusable here. |
| A.d agent credentials | **YES.** `runtimeOverrides.claudeCodeExecutable` / `.codexPath` point the bundled adapters at our pinned binaries; the adapters read `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. No managed-runtime download is forced. |
| A.e local project registration | **YES**, over `/project-control`; `local-project/git-state` answers. |

---

## 0. THE FINDING THAT CHANGES THE PLAN

**`npm lody` is not the OSS build.** §5.1 of the plan assumed "the box installs
the prebuilt npm `lody` package". The published package is a *different
assembly* from the public tree, and it cannot run without a Lody cloud account.

The public tree bakes the platform at build time
(`vendor/lody/apps/cli/vite.config.ts:11-16`):

```
const inlineEnv = {
  // The public bundle is local-only. Deployment endpoints must never be baked
  // into it from a developer shell or an untracked environment file.
  'process.env.LODY_PLATFORM': JSON.stringify('local'),
```

The published bundle bakes the opposite value. Its own embedded manifest names
it (`dist/index.js:4327`): `const name$1 = "@lody/cli-cloud";`. And the
platform selector is a constant, not an env read (`dist/index.js:186069`):

```js
function getCliPlatformKind() {
  return resolvePlatformKind("cloud");
}
```

`LODY_PLATFORM` therefore has **no effect on composition** in the npm artifact.
It survives in exactly three places, all of which only pick a directory name:

```
$ grep -n "LODY_PLATFORM" /opt/blitz/npm/lib/node_modules/lody/dist/index.js
4317:  const PLATFORM_ENV_VAR = "LODY_PLATFORM";
130083:  path.join(os.homedir(), process.env.LODY_PLATFORM === 'local' ? '.lody-oss' : '.lody'),
176143:  path.join(os.homedir(), process.env.LODY_PLATFORM === 'local' ? '.lody-oss' : '.lody'),
```

Measured refusals, unpatched:

```
$ LODY_PLATFORM=local LODY_DATA_DIR=$SCRATCH/lody-data lody daemon start
Checking the connection to Lody…
This machine is not connected to Lody yet.
Run lody login from a terminal, or pass --auth <cli_token>.
EXIT 1
```

`--skip-auth-check` only skips the *foreground preflight*. The detached child
still enters the cloud composition root and blocks on device authorization:

```
$ LODY_DATA_DIR=$SCRATCH/lody-data2 lody daemon start --skip-auth-check
Daemon started (PID 382294)
$ lody daemon status
● Daemon is not running          # the child died
$ LODY_DATA_DIR=$SCRATCH/lody-data2 lody start        # same child, foreground
==================================================
Device Authorization
==================================================
Please visit: https://lody.ai/device?user_code=E28M7NKF
- Waiting for authorization...
```

No OSS artifact is published. Checked: `@lody/cli`, `@lody/cli-oss`,
`lody-oss`, `@lody/cli-cloud` — all `Not Found` on the registry. `lody` has
exactly one release line, and 0.88.1 is the latest.

### The fix: one line, one stable anchor

The cloud bundle still **contains** the whole local composition root — the
build only pinned the selector. Restoring the env read is a one-line patch:

```js
-  function getCliPlatformKind() {
-    return resolvePlatformKind("cloud");
-  }
+  function getCliPlatformKind() {
+    return resolvePlatformKind(process.env.LODY_PLATFORM ?? "cloud");
+  }
```

The anchor string occurs exactly once in the 12.8 MB bundle. With the patch and
`LODY_PLATFORM=local`, the daemon starts with no account:

```
$ LODY_PLATFORM=local LODY_DATA_DIR=/tmp/lp node dist/index.js start
Lody CLI v0.88.1
Starting in local platform mode (no account, no cloud services).
[platform] Created local identity local:b95719ec5d4c4c4c87460a8e3377b090
Starting agent service...
[platform] Provisioned implicit local workspace lw_60f504fe7922459fb60874b8df9209b7
✨ Local agent service is ready. Open the Lody OSS app to chat.
```

This is `DAEMON-PATCH` in the sense the phase brief reserved, but it is **not**
the transport patch the brief feared: it flips one build constant, not the
transport factory. It is recorded in `vendor/lody/BLITZ-PATCHES.md` and applied
to the npm artifact at image build, never to `vendor/`.

> **Correction, 2026-08-30 (what phase 1 actually shipped).** The patch is the
> same edit at **four** call sites, not one, and it lives at
> the now-retired `lody-local-platform.mjs`. The anchor
> `resolvePlatformKind("cloud")` occurs exactly 4× in the 0.88.1 bundle; the
> script asserts that count and the file's sha256.
>
> The extra sites matter because one of them is the default argument of
> `getInstallationProfile()`. Patching only `getCliPlatformKind` runs the local
> composition under the CLOUD installation profile, which is what produced the
> `17788` and `lody-*` measurements recorded in §A.a below. Patching all four
> selects the LOCAL profile, and the box depends on that shape:
>
> | | 1-site patch (measured below) | 4-site patch (shipped) |
> |---|---|---|
> | namespace | `lody` | `lody-oss` |
> | socket basenames | `lody-control.sock`, … | `lody-oss-control.sock`, … |
> | CLI host lease | 127.0.0.1:**17788** | 127.0.0.1:**17789** |
> | default data dir | `~/.lody` | `~/.lody-oss` (overridden by `LODY_DATA_DIR`) |
>
> **17789** is therefore the port pinned in `RESERVED_PREVIEW_PORTS`, and
> `lody-oss-` is the namespace `blitz-lody-bridge` builds its socket paths from.
> Where §A.a below says 17788 or `lody-*`, read the right-hand column.

### Rejected alternative

Building `apps/cli` from the subtree would give a genuine OSS bundle with no
patch. It needs the five `acp-extension-*` git submodules, which the subtree
carries as empty gitlinks (`plans/evidence/lody-phase0.md` §1), plus pnpm and
their `prepare:acp-adapters` chain. That trades a one-line patch for a
five-submodule build pipeline in our image. Revisit if the patch anchor ever
moves — the failure is loud (the patch script exits non-zero at image build).

---

## A.a — the daemon, headless

Sockets appear in `$LODY_DATA_DIR/run`, mode 0700 dir, 0600 sockets:

```
$ ls -la /tmp/lp/run/
-rw------- daemon.json
srw------- lody-control.sock
srw------- lody-loro-data-plane.sock
srw------- lody-probe.sock
srw------- lody-terminal.sock
$ cat /tmp/lp/run/daemon.json
{"pid":383454,"socketPath":"/tmp/lp/run/lody-probe.sock",
 "controlSocketPath":"/tmp/lp/run/lody-control.sock",
 "version":"0.88.1","startedAt":"2026-08-29T23:52:49.525Z"}
```

Four sockets, not the three `vendor/lody/packages/shared/src/node/local-ipc.ts`
names: `lody-terminal.sock` is new since 0.76.0 and has no counterpart in the
subtree. That is the §11 skew, and it is additive.

Named `lody-*`, not `lody-oss-*`, because the installation profile is pinned
the same way the platform selector was (`dist/index.js:4386`):
`function getInstallationProfile(platform2 = resolvePlatformKind("cloud"))`.
So the patched daemon runs the **local composition** under the **cloud
namespace**. Consequences, all benign once pinned: socket basenames stay
`lody-*`, the CLI host lease binds **127.0.0.1:17788** (not 17789), and the
default data dir would be `~/.lody`. We set `LODY_DATA_DIR` explicitly, so only
the port matters.

> **Superseded by the §0 correction.** This paragraph describes the 1-site
> patch. Phase 1 ships the 4-site patch, which also flips
> `getInstallationProfile()`, so the box runs the local composition under the
> **local** namespace: `lody-oss-*` sockets and the host lease on **17789**.

Both probe endpoints answer over the unix socket, with the
`x-lody-local-control` header:

```
$ curl -s --unix-socket /tmp/lp/run/lody-probe.sock \
    -H 'x-lody-local-control: 1' http://localhost/healthz
{"ok":true,"machineId":"6a682163-...","pid":383454,"cliVersion":"0.88.1",
 "homeDir":"/var/lib/blitz/home"}

$ ... http://localhost/state
{"schemaVersion":1,"phase":"running","startupStage":"ready",
 "connectivity":"online","backend":{"authorization":"pending","connection":"connecting"},
 "connectedWorkspaces":[{"id":"lw_60f504fe...","name":"Lody","slug":"local",
   "role":"owner","backendConnection":"disconnected"}],
 "activeSessionCount":0,"connectedRoomCount":0,
 "supervisor":{"pid":383443,"launchMode":"daemon"}}
```

`backend.authorization: pending` is cosmetic. Verified zero cloud I/O over a
4-minute run: `ss -tnp` shows **no outbound connection** from either daemon
pid, and the log file has no line matching
`lody\.ai|convex|backend|fetch|posthog|ECONNREFUSED`. The local composition
root never constructs `AuthClient` or the Streams transport, so the inlined
endpoint literals are never read.

**Foreground works and is what s6 should run.** `lody start` (not
`lody daemon start`) holds the process, serves all four sockets, and exits on
SIGTERM. `lody daemon start` forks a `daemon-runner` watchdog and returns —
the wrong shape for an s6 `longrun`.

### Two ports the daemon binds that we did not ask for

- **17788** — the CLI host lease (`InstallationProfile.localCliHostPort`).
  Loopback. A second `lody start` against it exits 3 with
  `Cannot start: foreground process <pid> already owns the local agent runtime.`
- **an MCP HTTP host on an EPHEMERAL port** — observed at 39111, 44775, 46229
  across restarts: `[mcp-http] host serving on http://127.0.0.1:46229/mcp`.
  It checks the peer uid (`mcp-http-host] rejected connection: peer uid …`),
  but a random loopback port would still show up in the gateway's `/ports`
  discovery as a preview candidate. `LODY_MCP_HTTP_PREFERRED_PORT` and
  `LODY_MCP_HTTP_DISABLED` exist in the bundle; phase 1 pins the port.

### The socket path length trap

`sun_path` caps a unix socket at 103 bytes, and `local-ipc.ts` throws
`local_ipc_socket_path_too_long` rather than falling back. The agent scratchpad
here is 75 bytes, and
`<scratchpad>/lody-data/run/lody-oss-loro-data-plane.sock` is 118 — over the
cap with no room to spare. This probe therefore used `LODY_DATA_DIR=/tmp/lp`.
The box path is fine:
`/var/lib/blitz/lody/run/lody-loro-data-plane.sock` is 49 bytes.

---

## A.b — THE TRANSPORT QUESTION: **RELAY-BRIDGE wins**

### Why the second path is not needed

The daemon does not need a transport swapped in. In local mode it already
**serves** its `LoroRepo` on `lody-loro-data-plane.sock`, because that is how
the Electron renderer reaches it. Nothing about that path is Electron-specific:
`apps/electron/src/main/services/loro-data-plane-relay.ts` is described in its
own doc comment as "a dumb broadcast pipe", and both halves of the protocol are
public — `packages/shared/src/local-loro-data-plane.ts` (the wire schema) and
`packages/shared/src/local-loro-transport.ts` (a `loro-repo` `TransportAdapter`
speaking it).

The browser-facing seam is four methods
(`local-loro-transport.ts:44`, `LocalLoroDataPlaneConnection`):
`send`, `onMessage`, `onStatusChange`, `isConnected`. Electron implements them
over IPC in 30 lines
(`packages/components/src/providers/local-loro-data-plane-connection.ts`). We
implement the same four over a WebSocket. `LocalLoroTransportAdapter` itself
needs **no** change, so phase 2's seam is one new file outside `vendor/`.

### Protocol versions agree across the 0.88.1 / 0.76.0 skew

```
vendor/lody/packages/shared/src/local-loro-data-plane.ts:
  export const LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION = 7;
/opt/blitz/npm/.../dist/index.js:24509:
  const LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION = 7;
```

Equal, and the schemas gate on it: `protocolVersion` is a `z.literal`, so a
mismatched peer is rejected at parse time rather than silently half-working.
This is the sharpest single piece of evidence that the vendored renderer and
the pinned daemon are a compatible pair.

### Exit evidence: the round trip

`scratchpad/bridge.mjs` — the WebSocket ⇄ unix-socket pipe, 40 lines, modelled
on the Electron relay: one long-lived socket to the daemon, newline-framed,
every client frame forwarded, every daemon frame broadcast back.

`scratchpad/probe-roundtrip.mjs` — two **independent** external clients, each
on its own WebSocket, each a real `LoroRepo` driven by Lody's own
`LocalLoroTransportAdapter` (bundled out of the subtree with esbuild). Nothing
links client A to client B except the daemon, so convergence proves the daemon
received, stored and re-served the operation.

```
$ LODY_WS_ID=lw_60f504fe... node probe-roundtrip.mjs
[A] joined room session-phase1-probe and synced with the daemon
[A] wrote and pushed: written-by-external-client-1788047758892
[B] converged through the daemon: written-by-external-client-1788047758892
[A] round trip complete: echoed-back-1788047758928written-by-external-client-1788047758892
ROUND TRIP OK
```

Both directions, through the real daemon, with no daemon change beyond the
platform flip that headless operation needs anyway.

### What this means for the plan

§4 said "run a `loro-websocket` server inside or beside the daemon, attached to
the daemon's LoroRepo". That is **not** the shape. `loro-websocket`'s
`SimpleServer` is a standalone room relay with its own store; attaching the
daemon's repo to it would need the daemon to dial out, which is the transport
patch we are avoiding. The daemon's own data-plane socket is the sync surface,
and the box service in front of it is a pipe, not a CRDT server.

Phase 0's `loro-websocket` proof is not wasted — it settled that `loro-repo`'s
transport layer is pluggable — but `loro-websocket` is **not** a phase-1
dependency and the box does not run it.

One consequence for phase 6: the relay is a broadcast pipe, so per-room ACL
cannot be a pass-through. Enforcing read-only means parsing frames and dropping
inbound `sync` payloads for rooms the ticket does not grant write on. Frames
are peer- and room-addressed by design, so the hook is well placed.
*(Phase 6 built it there: `shareVerdict` in the bridge, with the decision table
as a fixture corpus — `packages/schema/fixtures/lody-share-claim/`. The one
correction to the sentence above is that a refused JOIN and a dropped UPDATE are
different acts, for the reason `plans/LODY-SHARING.md` §4.2 gives.)*

---

## A.c — driving the daemon without the UI

**The `lody session` / `lody project` / `lody agent-config` CLI commands are
cloud-only and cannot be used.** They resolve credentials from `AuthClient` and
write through Loro Streams (`apps/cli/src/lib/command-runtime.ts:193-230`):

```
$ lody project add /tmp/lp-repo --json
Not logged in. Run `lody login` first.
$ lody agent-config list --json
{"ok":false,"error":"Not logged in. Run `lody login` first."}
```

The `withWorkspaceManager` helper is explicit about why:

> One-shot commands write directly into the workspace repo and rely on
> Loro Streams to reach the cloud (and the daemon); without the remote
> transport the write would silently strand in the local SQLite store.

The usable surface is the **control socket**, which serves three HTTP paths.
All three are live and validate against the same zod schemas the subtree
carries:

```
$ curl --unix-socket /tmp/lp/run/lody-control.sock -H 'x-lody-local-control: 1' \
    -X POST -d '{"machineId":"…","workspaceId":"…","method":"nope","params":{}}' \
    http://localhost/machine-rpc
{"ok":false,"error":"invalid_request","details":{"fieldErrors":{"method":["Invalid input"]}}}   HTTP 400

$ … -d '{"type":"nope"}' http://localhost/session-control
{"ok":false,"error":"invalid_request","details":{"fieldErrors":{"type":["Invalid input"]}}}     HTTP 400
```

A real call, `machine/status` on `/session-control`:

```
{"ok":true,"responses":[{"type":"machine/status_response",
  "machineId":"6a682163-…","success":true,
  "resources":{"totalMemoryGB":7.57,"usedMemoryGB":5.83,"totalCpus":4,"cpuUsagePercent":9.25},
  "lifecycle":{"launchMode":"daemon","canRemoteRestart":true,"canRemoteUpgrade":true}}]}
```

`LocalSessionControlRequestSchema` carries `session/create`, `session/chat`,
`session/cancel`, `session/steer`, the `machine/*` family, uploads and
previews. `session/create` (`message-schemas.ts:531`) takes a caller-chosen
`sessionId`, an `acpSessionConfig`, an optional `project`, and an `env` map —
so a session and a turn are both reachable from a plain HTTP POST over the
socket. Phase 2 does not need the CRDT dispatch-watcher path to create a
session; the CRDT is where the session's *content* lives.

No `session/create` was executed here: it dispatches an agent turn, and the
brief forbids paid turns.

---

## A.d — agent credentials

`runtimeOverrides` is the answer, and it is a first-class per-session field
(`message-schemas.ts:62-69`, reachable from `ACPSessionConfigSchema`):

```ts
export const BuiltinRuntimeOverridesSchema = z
  .object({
    codexPath: z.string().optional(),
    claudeCodeExecutable: z.string().optional(),
    kimiPath: z.string().optional(),
    grokPath: z.string().optional(),
  })
  .strict();
```

`apps/cli/src/agent/setting.ts:441-455` shows the override short-circuits the
managed runtime entirely:

```ts
const overridePath = trimRuntimeOverride(input.runtimeOverrides?.claudeCodeExecutable);
const runtime = overridePath
  ? { command: overridePath, version: undefined }
  : await resolveManagedRuntimeForLaunch('claude-code', input);
return {
  command: process.execPath,
  args: [...resolveCliAdapterEntry('claude-acp'), ...],
  env: { CLAUDE_CODE_EXECUTABLE: runtime.command },
  ...
```

So `claudeCodeExecutable: '/usr/local/bin/claude'` runs **our pinned shim**,
which is the same binary the TUI uses and the same one `blitz-cred-claude`
serves. Same shape for `codexPath`.

The adapters are shipped prebuilt and they read the credential env we already
set:

```
$ grep -o "CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CONFIG_DIR|CODEX_HOME" dist/*.js
   6 claude-acp.js:ANTHROPIC_API_KEY
   6 claude-acp.js:ANTHROPIC_AUTH_TOKEN
   6 claude-acp.js:CLAUDE_CODE_OAUTH_TOKEN
  24 claude-acp.js:CLAUDE_CONFIG_DIR
   3 index.js:ANTHROPIC_API_KEY
   3 index.js:ANTHROPIC_AUTH_TOKEN
  11 index.js:CODEX_HOME
```

`dist/` ships `claude-acp.js` (2.1 MB — the Claude Agent SDK is bundled in),
`codex-acp.js`, `grok-acp.js`, `deepseek-acp.js` and the deepseek presets, so
**yes, the npm artifact ships the acp-extension adapters prebuilt.** It is a
per-entry esbuild/vite bundle set, not one file: `index.js` (12.8 MB) plus the
adapter entries, three Tinypool workers, and `zstd.wasm`. 21 MB total.

What the daemon thinks today, with no override configured:

```
machine/acp-binary-status claude → {"status":"not-installed","platformArch":"linux-x64","version":"2.1.232"}
machine/acp-binary-status codex  → {"status":"not-installed","platformArch":"linux-x64","version":"0.148.0"}
```

"not-installed" refers to the **managed runtime** it would download (claude
2.1.232, codex 0.148.0), not to our PATH binaries (2.1.228 / 0.147.0). Left
alone it would fetch its own copies from
`packages/platform/src/runtime-artifacts.ts`'s R2 channel — a second unpinned
agent binary on the box, which is exactly what the image's
`DISABLE_AUTOUPDATER` pin exists to prevent.

**What phase 2/3 must do:**

1. Set `runtimeOverrides.claudeCodeExecutable=/usr/local/bin/claude` and
   `codexPath=/usr/local/bin/codex` on every dispatch. No agent config may go
   out without them.
2. Leave credentials to the existing path: the shims and `CLAUDE_CONFIG_DIR`
   already resolve to `$HOME/.claude`, which the daemon inherits.
   `session/create.env` is the per-session escape hatch if a turn ever needs a
   freshly minted token.
3. Never enable the kimi/grok agent types — they are managed-runtime-only and
   have no override we pin. §0.6 already limits v1 to claude and codex.

---

## A.e — local project registration for worktrees

Registration and git state both work over `/project-control`, no login:

```
$ curl … -d '{"type":"local-project/add","machineId":"…","rootPath":"/tmp/lp-repo"}' \
    http://localhost/project-control
{"ok":true,"type":"local-project/add","result":{
  "localProjectId":"local-project-c2251154d90459b8d14d3c5f","name":"lp-repo",
  "rootPath":"/tmp/lp-repo","workspaceIds":["lw_60f504fe…"]}}

$ … '{"type":"local-project/list","machineId":"…"}'
{"ok":true,"type":"local-project/list","result":{"workspaces":[{"workspaceId":"lw_60f504fe…",
  "workspaceName":"Lody","projects":[{"localProjectId":"local-project-c225…",
  "name":"lp-repo","rootPath":"/tmp/lp-repo"}]}]}}

$ … '{"type":"local-project/git-state","machineId":"…","workspaceId":"…","localProjectId":"…"}'
{"ok":true,"type":"local-project/git-state","result":{"git":true,
  "branches":["master"],"currentBranch":"master","defaultBranch":"master",
  "githubRepoFullName":null,
  "workingTree":{"clean":true,"staged":false,"unstaged":false,"conflicted":false}}}
```

The union also carries `local-project/checkout-branch`,
`local-project/{get,set}-worktree-setup`, `.../worktree-cleanup`,
`worktree/list-files` and `worktree/read-file` — the whole §6.4 worktree
surface is reachable from this socket. `githubRepoFullName: null` is the field
§6.4 says to set so the sidebar groups a repo under GitHub Worktrees; it is
derived from the clone's remote, so `/workspace/<repo>` clones will populate it
without extra work.

---

## Blockers and open items for phase 2

1. **The platform patch is a new maintenance obligation.** It is one line
   against one anchor, but it must be re-verified at every `lody` bump. The
   apply script fails the image build if the anchor moves, so the failure is
   loud, never silent. `docs/LODY-MERGE.md` (phase 7) must list it.
2. **`lody session|project|agent-config` are unusable.** Anything phase 2+
   wants to drive must go through the control socket or the CRDT. Do not write
   box bootstrap code that shells out to those subcommands.
3. **The plan's §4 sync shape was wrong and is corrected above.** No
   `loro-websocket` server on the box. Phase 2's transport seam is a
   `LocalLoroDataPlaneConnection` over a WebSocket, not a
   `WebSocketTransportAdapter` from `loro-repo`. That also removes the seam
   patch §5.3 item 1 anticipated in `create-workspace-runtime.ts`: the local
   branch there is already the one we want, and it only needs
   `createLocalLoroDataPlaneConnection` to return our WebSocket connection
   instead of `null` outside Electron.
4. **The browser-facing relay frame format is a cross-runtime contract with no
   fixtures yet.** It is Lody's protocol v7, newline-JSON, and both sides are
   Lody's own code today, so nothing in this tree pins it. When phase 2 adds
   our own `LocalLoroDataPlaneConnection`, the framing becomes a BlitzOS
   contract and needs a fixture corpus under `packages/schema/fixtures/` per
   CLAUDE.md. Phase 1 ships no fixtures for it because phase 1 ships no
   BlitzOS-authored frame — the relay copies bytes without reading them.
5. **`session/create` is untested here** (it dispatches a paid turn). Phase 2
   must budget for the first real turn to surface adapter-launch problems the
   config probes cannot.
6. **`lody-terminal.sock` is undocumented in the subtree.** It exists on 0.88.1
   and has no 0.76.0 counterpart. Not proxied, not used; noted so the next
   merge does not treat it as a surprise.

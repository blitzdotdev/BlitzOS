# README implementation gaps

> **Historical audit — snapshot of 2026-08-15.** Kept as a design record, not
> current truth. Several gaps reported below have since landed: orgs, members,
> invites, and grants (identity), workspace sharing, and workspace templates.
> Other references have moved on too (for example, the composite provider it
> cites was deleted). Trust the code and tests over this document.

Audited 2026-08-15 against the current working tree. This document compares the
product claims in the root `README.md` with the implementation in the open Blitz
core packages. It is a gap inventory, not a claim that the existing workspace
runtime is non-functional.

## Summary

Blitz core currently implements a strong single-operator workspace runner:
Linux/Docker workspaces, Hetzner and Firecracker lifecycle, Claude/Codex
terminals, ACP chat, files, live previews, workspace-local session journaling,
volumes on Hetzner, and short-lived credential delivery.

It does not yet implement the collaborative team product described by the root
README. The largest gaps are sharing and authorization, delegated provisioning
for subagents, cross-device session discovery, enforceable least-privilege
workspace configuration, and an automation/task-running layer.

| README claim                                                  | Current status                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Collaborative platform for teams; create and share workspaces | Not implemented in core                                                                                  |
| Multiplayer invites with view/edit/resume roles               | Not implemented in core                                                                                  |
| Agents provision workspaces for subagents via API             | Human/operator API exists; delegated agent flow is missing                                               |
| Resume an agent session later from any device                 | Workspace journal exists; cross-device discovery is missing                                              |
| Claude, Codex, or any other harness                           | Claude/Codex integrated; other harnesses are unmanaged shell processes                                   |
| Credentials, tools, and data scoped to the task               | Credential ceiling exists but is not exposed in create UI and defaults broad; tool/data policy is absent |
| Browser chat, terminal, files, and previews                   | Implemented; non-microVM connectivity requires an external tunnel or edge                                |
| Persistent workspaces on your cloud                           | Implemented for Hetzner and configured Firecracker hosts; other clouds require an adapter                |
| Build and automate dashboards, pipelines, CRMs, and tools     | Coding environment exists; platform task runner, workflows, and deployment do not                        |

## A. Teams, sharing, and multiplayer

**README claims:** `README.md:3-6`, `README.md:21`, and the UI package summary at
`README.md:59` advertise teams, workspace sharing, invitations, and collaborative
view/edit/resume access.

**What exists:**

- Standalone authentication produces one `operator` principal
  (`packages/control-plane/core/principals.ts:79-86`).
- A workspace has one `owner_id`; the schema has no organization, membership,
  invite, workspace ACL, or role table
  (`packages/control-plane/migrations/0001_initial.sql:3-33`).
- List, webApp, and destroy routes enforce owner equality
  (`packages/control-plane/core/workspaces.ts:299-315,362-368`).
- The UI synthesizes a personal tenant and forces every workspace to
  `canControl: true` and `shared: false`
  (`packages/webapp/src/api-adapter.ts:58-74,96-113`).
- The actor can fan a session out to multiple subscribers, and ttyd can attach a
  read-only tmux client. These are transport primitives, not an access model.
- Concurrent file saves are last-write-wins; there is no CRDT, conflict merge,
  presence, or cursor model (`packages/box/README.md:135`).

Core's own boundary record confirms that orgs, members, roles, and invites are
not in core (`packages/control-plane/TODO.md:80-85`).

**Done when:**

1. Identity and membership records exist for more than one user.
2. Workspace grants model at least owner/editor/viewer access.
3. Invite, accept/revoke, list, and authorization paths are implemented.
4. Control-plane workspace reads and webApp endpoints enforce grants server-side.
5. The webApp exposes sharing and read-only modes without synthetic tenant
   state.
6. Concurrent editing semantics are documented honestly; “like Google Docs” is
   used only if presence and conflict-safe editing are actually provided.

## B. Delegated subagent workspace provisioning

**README claim:** agents can provision workspaces for their subagents via API
(`README.md:23`).

**What exists:** `POST /workspaces` is real, but it calls `requirePrincipal` and
therefore accepts the human browser/operator authentication path
(`packages/control-plane/core/app.ts:21-26`,
`packages/control-plane/core/workspaces.ts:194-196`). A box token is accepted by
the credential endpoint only and may mint only for its own workspace
(`packages/control-plane/core/credentials/mint.ts:180-188`).

There is no delegated provisioning capability, agent API key, parent/child
workspace relation, subagent quota, or child cleanup policy. Giving a workspace
the global operator key would technically let its process call the human API,
but that is not a supported or scoped subagent flow.

**Done when:**

1. A workspace can obtain a narrow, expiring capability to create child
   workspaces without receiving the operator credential.
2. The API records parent workspace, initiating principal/session, and child
   lifecycle.
3. Delegation narrows compute, integration manifest, data inputs, TTL, and child
   count.
4. Revocation, quota enforcement, cleanup, and audit events are covered by
   end-to-end tests.

## C. Session persistence and cross-device resume

**README claim:** sessions are stored with the workspace, keep working through
disconnects, and can be resumed later from any device (`README.md:22`).

**Implemented:**

- The box actor stores sessions, replay events, turns, permissions, and provider
  resume IDs in SQLite (`packages/box/actor/src/journal.ts:16-49`).
- Losing a browser socket removes only that subscriber; it does not cancel the
  running turn (`packages/box/actor/src/actor.ts:276-278`).
- Replay and identical multi-subscriber delivery are tested
  (`packages/box/actor/test/actor.test.ts:215-254`).

**Missing or narrower than advertised:**

- ACP exposes session new/load/prompt/cancel but no session list or discovery
  operation (`packages/box/actor/src/server.ts:54-70`).
- Chat session IDs and tab layout live only in browser `localStorage`
  (`packages/webapp/src/storage.ts:74-76,109-132,200-289`).
- Control-plane `sessions` are login cookies, not agent-session records
  (`packages/control-plane/core/sessions.ts:13-40`).
- On actor restart, an unfinished turn is marked terminal `refusal`; it does not
  continue automatically (`packages/box/actor/src/journal.ts:49`).
- Replay to a newly attached UI is limited to the most recent 2,048 events
  (`packages/box/actor/src/config.ts:3`).

Today, “continues through a browser/network disconnect while the workspace and
actor remain alive” is accurate. “Resume from any device” is not.

**Done when:**

1. Sessions can be listed and identified without possession of a browser-local
   UUID.
2. A newly authenticated device can discover and open the workspace's sessions.
3. Session names, tabs, and provider metadata have a server-authoritative home.
4. Restart and replay semantics are explicit, with an acceptance test covering
   disconnect, new device, actor restart, and long histories.

## D. Scoped credentials, tools, and data

**README claims:** a workspace holds only the credentials, tools, and data the
task requires (`README.md:6,18,48-49`).

**Credential implementation:** integration manifests, scope ceilings, leases,
minting, proxying, brokerage, and workspace-side placement are real. The gap is
the default and product surface:

- `manifestAllows(null, ...)` permits every active integration
  (`packages/control-plane/core/credentials/manifest.ts:45-58`).
- An unqualified credential sync requests every active integration that passes
  authorization (`packages/control-plane/core/credentials/mint.ts:224-238`).
- The create API accepts a manifest (`packages/schema/src/api.ts:9-18`), but the
  browser create form sends only machine type, SSH key, and optional volume
  (`packages/webapp/src/CreateWorkspaceDialog.tsx:57-68`).

**Tool/data implementation:** there is no workspace-level tool allow-list,
dataset entitlement, repository policy, or data-source manifest. The box ships a
fixed tool set and Docker access. `/workspace`, user-data, and an optional volume
are caller-controlled coarse inputs, not enforced per-task policy.

**Done when:**

1. Workspace creation requires an explicit deny-by-default credential manifest,
   or an equally visible deliberate broad-access choice.
2. The webApp can inspect and configure the manifest before launch.
3. Tool and data scoping have concrete enforcement models, or the README is
   narrowed to describe VM isolation and credential scoping only.
4. Tests prove a workspace cannot discover or mint an undeclared integration,
   read undeclared data, or invoke a disallowed tool path.

## E. BYO agent and harness extensibility

**README claim:** run Claude Code, Codex, or any other harness (`README.md:20`).

The integrated provider type is exactly `claude | codex`
(`packages/box/actor/src/types.ts:9`). Actor startup rejects other providers
(`packages/box/actor/src/main.ts:11-20`), the ttyd launcher accepts only Claude,
Codex, or a terminal (`packages/box/rootfs/usr/local/libexec/blitz-term:22-35`),
and those are the only harness choices exposed by the webApp
(`packages/webapp/src/WebAppHeader.tsx:7-22`).

Any other CLI can be installed and run manually in the Linux terminal, but it
does not receive ACP chat, managed resume, credential-provider integration, or a
typed launcher. The normal browser chat path also records Claude as the provider
even though the actor contains a Codex adapter
(`packages/webapp/src/CloudApp.tsx:1373-1382`).

**Done when:** either add a documented provider/launcher extension contract and
prove it with a third harness, or narrow the README to “integrated Claude and
Codex, with arbitrary CLIs available in the terminal.” Browser chat must also
allow selection of every provider claimed as integrated.

## F. Browser connectivity and open-core ingress

**README claim:** create, watch, and steer workspaces from the browser with chat,
terminal, files, and previews (`README.md:19`).

Those webApp endpoints are implemented. MicroVM ACP/files/terminal/preview traffic is
proxied through the control plane. For a normal cloud VM, however, the standalone
resolver ignores the workspace SSH endpoint and points every workspace at the
same localhost ports (`packages/webapp/src/resolver.ts:25-53`). The user must run and
retarget an SSH tunnel or provide an external edge. The open packages explicitly
exclude hosted ingress (`packages/box/TODO.md:136-146`).

**Done when:**

1. The webApp owns a per-workspace SSH-forward lifecycle with pinned host-key
   verification, or an open authenticated ingress/reference edge is shipped.
2. Two remote workspaces can be open concurrently without manually remapping
   the same local ports.
3. The root README documents the tunnel/edge requirement until that exists.

## G. Compute, persistence, and volume parity

**README claim:** persistent Linux workspaces run on “your cloud”
(`README.md:17,38-50`).

Hetzner and configured Firecracker hosts are implemented. A different public
cloud requires a new `VmProvider` adapter
(`packages/control-plane/README.md:12-13`). This is a valid extension seam, but
not out-of-the-box support for an arbitrary cloud.

There is also a provider-composition defect around volumes:

- The microVM provider reports `volumes: false`
  (`packages/control-plane/core/providers/microvm.ts:435-437`).
- The composite VM provider exposes Hetzner's capabilities globally
  (`packages/control-plane/core/providers/composite.ts:18-20`).
- The UI lists volumes without filtering them by selected machine type.
- Create then calls the Hetzner volume provider with the newly created microVM
  ID (`packages/control-plane/core/workspaces.ts:267-269`).

Selecting a volume with a microVM therefore produces a create error rather than
a supported persistent-volume workspace.

The Firecracker package is also not a turnkey host installer: its checked-in
configuration is lab-specific and the guest image builder expects an external
base rootfs and recipe assets
(`packages/microvm-host/deploy/config.host.json:1-22`,
`packages/microvm-host/guest/build-rootfs-m2.sh:4-13`).

**Done when:** filter or reject invalid provider/volume combinations before VM
creation, add an acceptance test for every advertised combination, and provide a
reproducible host/rootfs installation path. The README should list the built-in
providers and persistence boundaries explicitly.

## H. Build and automate

**README claim:** use agents for quick tasks and build or automate dashboards,
pipelines, CRMs, and tools (`README.md:24`).

The workspace is a real coding environment and can produce those artifacts. Core
does not provide a task-runner API, workflow/job model, schedule, webhook intake,
event egress, or application deployment/hosting lifecycle. The missing reusable
runner is already described in `plans/ENTRYPOINTS.md:21-32`.

**Done when:** either implement and test the automation lifecycle, or present
this line as an example of code users can create rather than a Blitz platform
feature.

## I. Architecture and package-label drift

The root architecture places “sessions” and “access” in the control plane and
shows “your team · apps” as callers (`README.md:29-50`). The package list says the
control plane owns sessions/access and the UI supports sharing
(`README.md:57-59`). In current core:

- Control-plane sessions are authentication cookies.
- Agent sessions live entirely inside each box actor.
- Workspace access is owner equality, not grants or roles.
- UI sharing is hard-coded false.
- There is no app registry, external invocation API, or team model.

The diagram and package descriptions must change with the implementations above,
or be narrowed to the current single-operator ownership model.

## J. Distribution and repository packaging

These do not erase the source implementation, but they prevent the root README
from being a complete installable-product description:

- Box images are not published (`packages/box/README.md:20-21`).
- Broker images are not published (`packages/broker/README.md:3-4`).
- Firecracker deployment relies on operator-provided binaries, kernel, rootfs,
  sudo wrapper, networking, and stable HTTPS exposure.
- The root declares Apache-2.0 and `package.json` contains that license metadata,
  but no `LICENSE` or `NOTICE` file is present.

**Done when:** immutable public image digests, a reproducible Firecracker host
install, end-to-end install documentation, and the Apache-2.0 license text are
included in a release.

## Verified implemented baseline

The audit should not be read as discounting these implemented capabilities:

- Workspace create/poll/destroy and readiness transitions.
- Hetzner VMs and Firecracker microVM allocation/networking/webApp proxying.
- Linux, key-only SSH, Docker-in-Docker, terminal, Claude, and Codex.
- ACP chat, replay journal, permission requests, and multi-subscriber fan-out.
- File browsing/editing/upload, port discovery, and HTTP/WebSocket previews.
- Credential integration registry, manifests, leases, short-lived minting,
  proxying, broker routing, and workspace-side env/file placement.
- Hetzner volume create/list/attach/detach/delete and survival across workspace
  destroy.

At audit time, the JavaScript tests and typecheck, broker Go tests, box gateway Go
tests, microVM host race-enabled Go tests, control-plane shell tests, and box
shell syntax tests passed. The full Docker box smoke test was not run because no
Docker daemon was available.

## Recommended dependency order

1. Identity, membership, and workspace grants.
2. Server-authoritative agent session discovery and cross-device resume.
3. Deny-by-default workspace manifest exposed in the create UI.
4. Delegated child-workspace capability and task-runner primitive.
5. Open/per-workspace browser connectivity for non-microVM providers.
6. Harness extension contract and third-provider proof.
7. Provider/volume validation and reproducible microVM distribution.
8. Collaboration UX, automation entrypoints, and application lifecycle.
9. Align the root README and architecture diagram with only the acceptance
   criteria that have shipped.

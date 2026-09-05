# Security Review: BlitzOS

## Scope

Repository-wide, source-backed security review focused on workspace authorization, membership and organization revocation, derived capabilities, sibling privileged routes, and server-side enforcement.

- Scan mode: repository
- Target kind: git_revision
- Target ID: target_sha256_7e7bd101aafd16b05670ebff919f94df64cc4ca2102bb9a8058cf15203cdf77b
- Revision: 11218111b4f697bedd8179fc1937aa97f4a6c2da
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Runtime or test status: 35 tests passed across four focused control-plane suites (member-machines, session-shares, agent-rules-library, webapp-tickets). Static-token owner equivalence was also confirmed independently. Go tooling and a production cloud environment were unavailable.
- Artifacts reviewed: Active control-plane router registration and principal resolution, Workspace access, membership, settings, machines, state, attachments and shared-session routes, Machine OAuth, box callers, guest gateway and Cloudflare tunnel credential flow, Organization credentials, connections, leases and grant controls, Volume provider routes and lifecycle, Agent-rule storage, guest delivery and agent launchers, Credential broker enrollment, placement and deposit flow, Relevant migrations, security guidance, design documents and focused tests
- Scan context: The reported scenario was treated as a required invariant: deleting a workspace member must remove the workspace and all derived authority; only current stored workspace admins may add members.

Limitations and exclusions:
- Lody MCP session tooling was attempted but unavailable because the current Lody client is not logged in.
- No production organization, VM provider, public tunnel, broker fleet, or real vendor credential was exercised.
- The immutable scan target is Git revision 11218111b4f697bedd8179fc1937aa97f4a6c2da. It is an ancestor of the later observed HEAD a6949fd9a6342a363e3c6a4d2e8e3a003ea477f9; the intervening changes do not modify the reported authorization controls.
- Excluded vendor/lody/\*\*: Vendored upstream internals were excluded except where Blitz-owned bridges and data-plane integration formed a reported authorization path.
- Excluded packages/control-plane/core/templates.ts and recipes.ts: Template and recipe product routes are explicitly unmounted; their inactive code is not a production attack surface.
- Excluded generated schemas, built output and visual fixtures: Generated or presentation-only artifacts were not treated as production entrypoints; focused tests and design evidence were used only to confirm reachable behavior.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 12 |
| Severity mix | critical: 1, high: 4, medium: 5, low: 2 |
| Confidence mix | high: 12 |
| Coverage | partial |
| Validation mode | Static source/control/sink tracing with counterevidence and attack-path calibration, supplemented by existing focused tests. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

BlitzOS is a multi-tenant hosted control plane with distinct organization, workspace, per-member VM, machine-token, shared-session, external-provider, and global broker trust boundaries. A membership or role transition must revoke both future policy decisions and every derived live capability.

### Assets

- Workspace membership and administrative authority
- Per-member VM data, sessions and interactive channels
- Organization/workspace credentials and external vendor identities
- Provider-funded machines and persistent volumes
- Fleet-global credential broker infrastructure

### Trust Boundaries

- Browser or agent request to control-plane policy
- Organization role to explicit workspace ACL
- Control plane to public per-member VM gateway
- Machine bearer to workspace and organization credential stores
- Control plane to billable external cloud providers
- Workspace guests to global credential brokers

### Attacker Capabilities

- Create or hold an ordinary active organization membership, including under open signup
- Hold an organization-admin or workspace role before removal
- Retain credentials, identifiers, SSH keys and sockets issued during authorized access
- Send direct HTTP/WebSocket requests without respecting frontend visibility
- Operate an Internet-reachable SSH endpoint

### Security Objectives

- Every privileged workspace operation requires current explicit workspace membership and the required stored role
- Removal, demotion and disablement revoke live and derived capabilities before asynchronous provider cleanup
- Ordinary members cannot control fleet infrastructure or allocate/delete unrelated billable resources
- Shared configuration cannot inject trusted instructions into inaccessible workspaces
- History and recovery views enforce the same object visibility as active views

### Assumptions

- The user's stated workspace-removal policy overrides repository comments/tests that describe implicit organization-admin reach as intentional.
- A removed member may retain any token, endpoint identifier or key observable during prior authorized access.
- Public workspace tunnels are deployed as documented when Cloudflare tunnel configuration is enabled.
- Interactive agents and terminals are full-trust within their VM as documented in SECURITY.md.

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Any active member can enroll an attacker-controlled global credential broker](#finding-1) | critical | high | inline below |
| [Any organization member can delete another workspace's detached state volume](#finding-2) | high | high | inline below |
| [Removed members retain a non-expiring owner bearer for surviving workspace machines](#finding-3) | high | high | inline below |
| [Organization disablement leaves member machines and direct access alive](#finding-4) | high | high | inline below |
| [Removing an organization admin from a workspace does not revoke workspace authority](#finding-5) | high | high | inline below |
| [Member removal and demotion leave shared-session WebSockets authorized](#finding-6) | medium | high | inline below |
| [Any active member can allocate unbounded provider-billed volumes](#finding-7) | medium | high | inline below |
| [Any organization member can overwrite trusted agent instructions used by private workspaces](#finding-8) | medium | high | inline below |
| [Old session-share grants silently reactivate when a removed member is re-added](#finding-9) | medium | high | inline below |
| [Workspace removal relies on fallible VM destruction to end direct machine access](#finding-10) | medium | high | inline below |
| [Deleted-workspace history exposes private project metadata to unrelated org members](#finding-11) | low | high | inline below |
| [Machine credential routes do not recheck current workspace membership](#finding-12) | low | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Any active member can enroll an attacker-controlled global credential broker

| Field | Value |
| --- | --- |
| Severity | critical |
| Confidence | high |
| Confidence rationale | The complete HTTP-to-placement-to-deposit chain is explicit in production code. No deployment run was available, but no missing authorization or provenance check appears anywhere in the enrollment path. |
| Category | Missing authorization on fleet infrastructure enrollment |
| CWE | CWE-862 |
| Affected lines | packages/control-plane/core/app.ts:90-103, packages/control-plane/core/oauth.ts:381-477, packages/control-plane/core/registry.ts:108-117, packages/control-plane/core/registry.ts:151-163, packages/control-plane/core/registry.ts:226-253, packages/control-plane/core/registry.ts:265-356, packages/broker/internal/workspace/watch.go:28-83, packages/broker/internal/workspace/ssh.go:56-82 |

#### Summary

Membership-only device authorization can create a standalone box, and that box may mark itself as a global credential broker without platform-operator approval. The global placement algorithm can then send unrelated members' Claude or Codex credential blobs to the attacker-controlled SSH endpoint.

#### Root Cause

Broker enrollment reuses a self-service standalone box capability as authority to join fleet-global trusted infrastructure; it authenticates box ownership but never authorizes the operator or broker provenance.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- The OAuth device approval route is mounted behind active membership, not platform-operator authorization.
- A device-created standalone box receives renewable credentials and PUT /boxes/:id/broker checks only that the bearer owns that box.
- The enrolled row participates in the global least-loaded pool used for unrelated workspace machine placement.
- Workspace watchers transmit changed Claude/Codex credential blobs to the assigned SSH host and delete the local copy after acknowledgement.

Counterevidence and remaining uncertainty:
- The attacker must approve their own device flow and operate an Internet-reachable SSH service.
- SSH host-key pinning authenticates the endpoint selected from the untrusted enrollment, so it does not restore operator authorization.
- A victim must be placed on the malicious broker and subsequently log in or refresh a watched credential.

Limitations:
- No live broker fleet or vendor credential was exercised.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/app.ts:90-103, packages/control-plane/core/oauth.ts:381-477, packages/control-plane/core/registry.ts:108-117, packages/control-plane/core/registry.ts:151-163, packages/control-plane/core/registry.ts:226-253, packages/control-plane/core/registry.ts:265-356, packages/broker/internal/workspace/watch.go:28-83, packages/broker/internal/workspace/ssh.go:56-82, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Authorize and redeem a device code to obtain a standalone box access/refresh family.
- Call PUT /boxes/\<box\>/broker with the attacker's SSH endpoint; no operator approval is required.
- Repeat enrollment if desired to dominate least-loaded placement.
- Wait for an unrelated member's workspace to be assigned to an attacker broker.
- A routine vendor login changes the watched credential file; the watcher deposits its bytes to the attacker and removes the workspace copy.

#### Reachability

An ordinary signed-in user converts a self-owned standalone box into a trusted fleet broker and waits for global placement to route victim credentials to it.

- **Attacker:** Any active organization member, including an open-signup user, who controls an SSH endpoint.

- **Entry point:** POST /oauth/device/approve and /oauth/token, followed by PUT /boxes/:id/broker.

- **Source:** Attacker-supplied broker host, port, and SSH host key accepted under a self-owned box bearer.

- **Sink:** Global broker placement and the workspace watcher deposit operation.

- **Outcome:** Cross-tenant exfiltration of long-lived Claude/Codex credentials and vendor impersonation.

Preconditions:
- Credential-broker support is active.
- The attacker can run the enrolled SSH endpoint.
- At least one victim placement and credential deposit occurs.

Assumptions:
- Open signup may be enabled as documented in SECURITY.md.

Existing controls:
- Active membership is required for the initial device approval.
- The box must authenticate as itself.
- Broker member_cap limits victims per single broker row, but multiple unauthorized broker rows are allowed.
- SSH host-key pinning prevents interception by a third party but pins the attacker-provided host.

Blind spots:
- Runtime broker enablement and current production pool composition were unavailable.

#### Severity

**Critical** — Impact and likelihood are both high: an open-signup or ordinary member can repeatedly enroll brokers, influence a fleet-global least-loaded pool, and receive long-lived cross-tenant vendor credentials. This is a near-authenticated, scalable control-plane credential compromise.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** The path crosses organizations and exposes reusable external-service credentials from multiple victims.

Likelihood assessment:
- **Level:** high
- **Rationale:** Enrollment is remote and self-service; repeated broker creation can materially increase placement probability, and credential deposit is a normal product workflow.

#### Remediation

Require a platform-operator-scoped, single-use enrollment capability for broker registration; persist approval and immutable broker provenance; allow placement only onto an operator allowlist; cap broker creation per approved operator; quarantine existing broker rows and rotate any credentials potentially deposited to unapproved hosts.

Tests:
- An active non-operator can complete device auth but receives 403 from broker enrollment.
- Only a purpose-bound operator enrollment token may create a broker row, and it cannot be replayed.
- Placement excludes unapproved, disabled, or decommissioned broker rows.
- Disabling the enrolling user revokes standalone box credentials and removes the broker from placement.

Preventive controls:
- Separate human membership, machine identity, and fleet-operator capabilities.
- Audit every broker enrollment and placement with operator identity and immutable endpoint fingerprints.

<a id="finding-2"></a>

### [2] Any organization member can delete another workspace's detached state volume

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | The route, ownership query, provider sink, and retained-volume semantics are explicit. Provider refusal for attached volumes narrows the exploit to detached provider-deletable volumes but does not defeat it. |
| Category | Missing object-level authorization for destructive cloud resource operation |
| CWE | CWE-862, CWE-639 |
| Affected lines | packages/control-plane/core/volumes.ts:53-75, packages/control-plane/core/volumes.ts:78-101, packages/control-plane/core/compute/hetzner.ts:675-677, packages/control-plane/core/workspace-volumes.ts:5-14, packages/control-plane/core/workspace-volumes.ts:104-117 |

#### Summary

GET /volumes enumerates every provider volume owned by the organization, and DELETE /volumes/:id checks only org_id before calling the provider. It ignores creator, workspace, machine references, and workspace role, allowing an unrelated same-org member to permanently delete the retained /workspace copy for another member or workspace.

#### Root Cause

Volume ownership is modeled at organization scope for raw routes even though rows retain creator/workspace attribution and detached volumes are security-sensitive per-member workspace state.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- Listing uses only volume_ownership.org_id and returns all matching provider volumes.
- Deletion uses only volume_id plus org_id and performs no role, creator, workspace-membership, or machine-reference check.
- The provider delete call precedes deletion of the ownership row.
- Auto-created volumes are the only retained copy of /workspace after teardown and intentionally survive for seven days.

Counterevidence and remaining uncertainty:
- Cross-organization IDs return 404.
- Attached volumes may be rejected by the provider.
- An older identity design calls raw volumes organization-scoped, but current rows preserve creator/workspace attribution and no ordinary-member product workflow requires deleting another workspace's recovery copy.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/volumes.ts:53-75, packages/control-plane/core/volumes.ts:78-101, packages/control-plane/core/compute/hetzner.ts:675-677, packages/control-plane/core/workspace-volumes.ts:5-14, packages/control-plane/core/workspace-volumes.ts:104-117, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Call GET /volumes to enumerate organization-owned provider volumes.
- Select a volume belonging to another workspace or member.
- When it is detached, call DELETE /volumes/\<id\>.
- The control plane authorizes solely by shared org_id and deletes it at the provider.

#### Reachability

An ordinary organization member enumerates volume IDs, waits for another workspace's volume to detach, then invokes the raw delete route and permanently removes the recovery copy.

- **Attacker:** Any active ordinary member in the victim organization, without membership in the target workspace.

- **Entry point:** GET /volumes and DELETE /volumes/:id.

- **Source:** Organization-wide volume ID listing.

- **Sink:** Hetzner DELETE /volumes/\<id\>.

- **Outcome:** Irreversible loss of another member's retained workspace state and stale machine references that can prevent restart.

Preconditions:
- The attacker and volume share an organization.
- The target is a Hetzner-backed, detached, provider-deletable volume.

Existing controls:
- Cross-organization ownership is enforced.
- Provider state may refuse deletion while attached.

#### Severity

**High** — Impact and likelihood are high within one organization: identifiers are enumerable, the destructive provider call is remotely reachable, and detached volumes are deliberately the sole recovery copy. The same-tenant scope keeps it below critical.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** The action permanently deletes the sole retained copy of another workspace's data.

Likelihood assessment:
- **Level:** high
- **Rationale:** IDs are directly enumerable and detached volumes are a normal stop/removal state; the mutation route has no finer-grained guard.

#### Remediation

Remove the unused raw delete surface or require org-admin plus explicit workspace/creator authority. Refuse deletion while any machine references the volume, clear dependent references atomically only after confirmed deletion, and expose recovery deletion through a purpose-specific audited workflow.

Tests:
- An ordinary member cannot list or delete volumes outside workspaces they administer.
- A referenced or attached volume cannot be deleted through the raw route.
- Cross-workspace guessed IDs return the same non-disclosing denial.

Preventive controls:
- Authorize provider resources by their owning workspace/member, not only billing organization.
- Require referential-integrity checks before destructive external calls.

<a id="finding-3"></a>

### [3] Removed members retain a non-expiring owner bearer for surviving workspace machines

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Repository documentation establishes public deterministic tunnels; production code establishes shared token delivery and owner-equivalent acceptance; a targeted unit test explicitly confirms static-token owner equivalence. |
| Category | Non-expiring shared capability survives membership revocation |
| CWE | CWE-613, CWE-863 |
| Affected lines | packages/control-plane/core/webapp-tickets.ts:224-256, packages/control-plane/core/workspace-tunnels.ts:58-89, packages/control-plane/core/cloud-init.ts:76-92, packages/control-plane/core/workspace-records.ts:181-228, packages/control-plane/core/workspace-members.ts:311-330, packages/box/gateway/main.go:321-378, packages/box/gateway/main.go:1175-1188, plans/CONNECTIVITY.md:84-92 |

#### Summary

Every member VM receives the same readable per-workspace static webApp token. Public tunnel hostnames are deterministic from machine IDs, and the gateway's compatibility branch accepts the static token as role owner with effectively infinite expiry. Removing a member does not rotate it on surviving machines, so the former member can establish fresh direct connections after revocation.

#### Root Cause

A workspace-wide bootstrap secret is treated as a permanent owner identity. The ACL lifecycle revokes database membership but has no membership generation or token rotation that surviving gateways can enforce.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- WorkspaceTunnels derives one token from workspaceId and returns it for every member-machine provision.
- Cloud-init writes that credential mode 0600 owned by the interactive box user.
- Workspace projections expose all member machine IDs, while the public hostname is ws-\<machine-id\>.\<zone\>.
- The Go gateway accepts a non-v1 credential by raw comparison and assigns legacy-owner/owner without an expiry or current membership lookup.
- The existing webapp-tickets test passed and explicitly asserts owner-equivalent static-token acceptance.

Counterevidence and remaining uncertainty:
- The normal browser uses the control-plane proxy and never receives the tunnel hostname or token.
- The attacker must copy the token from their own authorized VM before removal and learn the public tunnel suffix.
- The repository trust model treats active workspace members as mutually trusted, but that trust is no longer applicable after removal.

Limitations:
- Direct traffic against a production tunnel was not attempted; the documented public ingress and gateway verifier were validated statically.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/webapp-tickets.ts:224-256, packages/control-plane/core/workspace-tunnels.ts:58-89, packages/control-plane/core/cloud-init.ts:76-92, packages/control-plane/core/workspace-records.ts:181-228, packages/control-plane/core/workspace-members.ts:311-330, packages/box/gateway/main.go:321-378, packages/box/gateway/main.go:1175-1188, plans/CONNECTIVITY.md:84-92, but no expanded source-to-sink narrative was recorded.

Attack steps:
- While authorized, read the static webApp token from the member's VM and retain the workspace member-machine IDs.
- After membership deletion, select any surviving member machine and construct its documented public tunnel hostname.
- Send a direct request with the retained static credential and the expected control-plane Origin for WebSockets.
- The gateway assigns owner identity and serves the requested privileged surface without consulting the control plane.

#### Reachability

A member retains the workspace bootstrap bearer before removal, computes a surviving peer's public tunnel hostname, and presents the bearer directly as owner after the database ACL is gone.

- **Attacker:** A current or former workspace member with prior interactive access to their own VM.

- **Entry point:** Public Cloudflare tunnel at https://ws-\<machine-id\>.\<zone\> with X-Blitz-WebApp-Token.

- **Source:** /var/lib/blitz/webapp-token in any member VM plus machine IDs returned in workspace membership views.

- **Sink:** Gateway terminal, file, session, preview, diagnostic, and administrative routes authorized as owner.

- **Outcome:** Fresh post-removal access to surviving member VMs, including read/write workspace data and interactive control.

Preconditions:
- Cloudflare workspace tunnels are enabled.
- The public zone suffix is known or discoverable.
- At least one target machine in the workspace remains online.

Assumptions:
- The removed member can retain information they legitimately observed before removal.

Existing controls:
- Unauthenticated tunnel requests are denied.
- Short-lived v1 tickets carry identity and expiry, but the static compatibility branch bypasses both.
- WebSocket Origin checking requires a known deployment origin, which is public configuration rather than a secret.

Blind spots:
- Self-hosted deployments may not configure Cloudflare tunnels; provider-proxied deployments have a different reachability path.

#### Severity

**High** — Impact and likelihood are high, but the reach is bounded to a workspace whose token the attacker legitimately held before removal. The result is a practical post-revocation authorization bypass to full-trust VM surfaces.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** The attacker regains full owner-equivalent access to privileged VM data and controls after explicit revocation.

Likelihood assessment:
- **Level:** high
- **Rationale:** The credential is readable during ordinary authorized use, persists indefinitely, and targets deterministic public endpoints.

#### Remediation

Remove the static-token compatibility path after an image migration window. Mint only short-lived identity-bound tickets, include a workspace membership-generation claim, increment that generation on removal/demotion/disable, and require gateways to reject older generations. Until migration completes, rotate the workspace key on every ACL change and push the replacement atomically to surviving gateways.

Tests:
- A raw static workspace token is rejected by current gateways.
- A ticket minted before member removal is rejected or actively drained immediately afterward.
- A former member cannot reach a surviving member machine directly through its public tunnel.
- Role demotion invalidates previously issued higher-role tickets.

Preventive controls:
- Never use bootstrap transport secrets as human authorization identities.
- Inventory all long-lived capabilities and bind them to revocable membership generations.

<a id="finding-4"></a>

### [4] Organization disablement leaves member machines and direct access alive

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Both disable paths and their transaction contents are explicit, and the documented lifecycle requires scoped machines to be destroyed. Fresh control-plane APIs correctly reject the disabled membership, isolating the missing direct-machine cleanup. |
| Category | Incomplete session and machine capability revocation |
| CWE | CWE-613 |
| Affected lines | packages/control-plane/core/identity/members.ts:145-193, packages/control-plane/core/identity/members.ts:196-267, packages/control-plane/core/oauth.ts:200-235, packages/control-plane/core/cloud-init.ts:7-24, packages/control-plane/core/webapp-tickets.ts:224-256, packages/box/gateway/main.go:1175-1188, plans/MEMBER-MACHINES.md:272-285 |

#### Summary

Self-leave and administrator disable update membership status and rebind browser sessions only. They do not mark the member's machines for destruction, revoke machine token families and leases, remove installed SSH keys, or drain interactive connections, so direct VM access and compute can continue indefinitely.

#### Root Cause

Organization membership status is treated as the sole revocation state for control-plane requests, while derived machine, network, SSH, OAuth, and live-channel capabilities have no coordinated revocation transaction or durable teardown job.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- Self-leave updates status and rebinds sessions in a two-statement transaction only.
- Admin disable similarly changes status and session binding but never queries or mutates machines.
- Machine and standalone-box refresh lookup omits membership status, although many downstream principal builders later fail closed.
- SSH public keys are installed into the VM and remain usable while it is online.
- The documented lifecycle explicitly says machines in the member's scope are destroyed when the member leaves the organization.

Counterevidence and remaining uncertainty:
- Browser sessions are rebound away from the disabled organization.
- Fresh workspace, boxCaller, and machine-principal requests usually reject disabled memberships.
- Those checks do not terminate SSH, existing gateway sockets, or owner-equivalent static webApp credentials.

Limitations:
- No live VM was disabled during validation.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/identity/members.ts:145-193, packages/control-plane/core/identity/members.ts:196-267, packages/control-plane/core/oauth.ts:200-235, packages/control-plane/core/cloud-init.ts:7-24, packages/control-plane/core/webapp-tickets.ts:224-256, packages/box/gateway/main.go:1175-1188, plans/MEMBER-MACHINES.md:272-285, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Provision a machine and retain an ordinary SSH key or guest webApp credential.
- Leave the organization, or have an administrator set membership status to disabled.
- The control plane rebinds browser sessions but performs no machine/capability lifecycle operation.
- Continue connecting directly to the still-running VM.

#### Reachability

A member provisions a machine and retains an SSH key or direct webApp capability, then leaves or is disabled; the membership is blocked in D1 but the VM and its network surfaces are never revoked.

- **Attacker:** A formerly active organization member who had their own machine.

- **Entry point:** DELETE /members/self or PATCH /members/:id followed by the machine's SSH endpoint or public webApp tunnel.

- **Source:** Installed SSH key, live socket, or retained per-workspace static bearer.

- **Sink:** The still-running privileged member VM and its workspace data/processes.

- **Outcome:** Persistent post-deactivation interactive access, data modification, credential use already present in processes/files, and ongoing compute consumption.

Preconditions:
- The member has a live machine and retained a direct access mechanism.

Existing controls:
- Fresh application API calls that resolve a membership generally require status=active.
- The last active member/admin cannot leave, limiting only who may trigger disablement.
- No corresponding network or VM revocation is present.

Blind spots:
- The exact lifetime of provider-side SSH reach depends on the configured VM provider.

#### Severity

**High** — Impact and likelihood are high: every member may own a privileged VM, self-leave is user-triggerable, and no asynchronous cleanup is even scheduled. Retained SSH/static-token access is a practical full-machine revocation failure.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** A disabled identity keeps full-trust access to a privileged VM and its data, defeating the primary offboarding boundary.

Likelihood assessment:
- **Level:** high
- **Rationale:** The path is deterministic for any member with a machine; no provider failure or race is required.

#### Remediation

Make membership disablement a durable coordinated revocation: in the authoritative transaction revoke machine/box token families, leases and broker keys; increment workspace generations; mark every scoped machine destroying; enqueue idempotent teardown; drain gateway connections; and sever tunnels/SSH reach before slower provider destruction. Require active membership in every OAuth refresh and raw box authentication query.

Tests:
- Self-leave and admin-disable immediately revoke browser, machine, static webApp, lease, SSH/tunnel, and existing WebSocket access.
- All member machines enter a durable destroying state and are eventually removed despite provider retryable failures.
- Re-enabling the membership does not resurrect old capabilities.

Preventive controls:
- Maintain a capability inventory per membership and revoke it from one lifecycle coordinator.
- Use durable teardown jobs with idempotent retries and observable failure states.

<a id="finding-5"></a>

### [5] Removing an organization admin from a workspace does not revoke workspace authority

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | The behavior is explicit in the shared authorization helper, frontend, comments, and tests. The user-supplied invariant establishes that this intentional implementation is a policy violation. |
| Category | Incorrect authorization caused by organization-role override of workspace ACL |
| CWE | CWE-863 |
| Affected lines | packages/control-plane/core/workspace-members.ts:311-330, packages/control-plane/core/workspace-access.ts:17-39, packages/control-plane/core/workspace-access.ts:54-68, packages/control-plane/core/workspace-access.ts:96-130, packages/control-plane/core/workspaces.ts:686-698, packages/control-plane/core/session-shares.ts:99-118, packages/control-plane/core/webapp-state.ts:334-354, packages/webapp/src/WorkspaceDetailsDialog.tsx:117-120 |

#### Summary

Deleting the workspace_members row removes rendered content but workspaceAccess reconstructs full workspace-admin authority solely from the caller's active organization-admin role. The removed user can use fresh API requests to list the workspace, add themselves or others, mutate settings and machines, delete the workspace, and obtain implicit session access.

#### Root Cause

The centralized access matrix treats organization admin as an implicit workspace role even when no workspace ACL row exists, so deletion cannot represent revocation for that principal.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- DELETE removes only the workspace_members row before machine teardown.
- accessFor sets orgAdmin whenever principal.role is admin and the workspace is in the same organization.
- isWorkspaceAdmin and isWorkspaceMember accept that implicit flag across shared administrative routes.
- Workspace listing retains null-stored-role projections for org admins, and the UI deliberately treats myRole=null as manageable.
- The targeted member-machines suite passed and includes a test that org admins pass workspace-admin gates implicitly.

Counterevidence and remaining uncertainty:
- A user who was only a stored workspace admin and remains an ordinary organization member is denied by fresh backend requests after deletion.
- The owner cannot be removed through this endpoint.
- Repository comments/tests call implicit org-admin reach intentional, but the user explicitly requires removal to end workspace authority and requires stored workspace admin status for member management.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/workspace-members.ts:311-330, packages/control-plane/core/workspace-access.ts:17-39, packages/control-plane/core/workspace-access.ts:54-68, packages/control-plane/core/workspace-access.ts:96-130, packages/control-plane/core/workspaces.ts:686-698, packages/control-plane/core/session-shares.ts:99-118, packages/control-plane/core/webapp-state.ts:334-354, packages/webapp/src/WorkspaceDetailsDialog.tsx:117-120, but no expanded source-to-sink narrative was recorded.

Attack steps:
- An authorized workspace admin deletes the target's workspace_members row.
- The target sends a fresh request naming the same workspace.
- workspaceAccess observes same org and principal.role=admin and sets orgAdmin=true despite stored=null.
- The shared workspace-admin gate authorizes the operation; adding the attacker or an accomplice restores an explicit row.

#### Reachability

An active organization admin whose explicit workspace row was deleted sends a new administrative request; the shared gate rebuilds authority from the organization role and accepts it.

- **Attacker:** A removed workspace member who remains an active organization administrator.

- **Entry point:** Any /workspaces/:id administrative API, including POST /workspaces/:id/members.

- **Source:** Session principal with org role admin but no workspace_members row.

- **Sink:** Workspace member management, settings, machine lifecycle, connections, state, attachments, deletion, and implicit session reads.

- **Outcome:** The intended revocation is ineffective; the user can restore access or exercise workspace administration directly.

Preconditions:
- The target remains active in the organization with role admin.
- The workspace remains in that organization.

Assumptions:
- The user-supplied workspace ACL invariant supersedes the repository's comments describing implicit org-admin reach as intentional.

Existing controls:
- Cross-organization access is denied.
- Ordinary organization members require a stored workspace role.
- Workspace ownership cannot be removed by this endpoint.

#### Severity

**High** — The bypass is immediate and remote and reaches destructive workspace administration and session confidentiality. It is bounded to an active same-organization administrator, so it remains high rather than critical.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** The bypass reaches high-value destructive and confidentiality-sensitive workspace operations after explicit revocation.

Likelihood assessment:
- **Level:** high
- **Rationale:** No race or stale client state is needed; every fresh request deterministically reconstructs authority.

#### Remediation

Make current workspace_members existence mandatory for workspace access and require stored role=admin for workspace administration. If organization administrators need emergency access, implement a separate time-bounded, audited break-glass grant that creates an explicit workspace access event.

Tests:
- After deleting an org admin's workspace row, fresh list, add-member, settings, machine, state, session, and delete requests return 403/404.
- An org admin can regain access only through the separately authorized break-glass workflow.
- The frontend closes the workspace shell and controls as soon as polling reports no stored role.

Preventive controls:
- Keep organization and workspace roles orthogonal in one explicit policy matrix.
- Add deny-after-revocation contract tests for every privileged workspace router.

<a id="finding-6"></a>

### [6] Member removal and demotion leave shared-session WebSockets authorized

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The missing drain is directly contrasted with the explicit share-revoke route that performs it, and the gateway connection tracker contains no expiry or membership recheck. |
| Category | Live session not invalidated after authorization revocation |
| CWE | CWE-613 |
| Affected lines | packages/control-plane/core/workspace-members.ts:207-247, packages/control-plane/core/workspace-members.ts:311-330, packages/control-plane/core/session-shares.ts:279-327, packages/control-plane/core/workspace-drain.ts:29-60, packages/box/gateway/main.go:444-490 |

#### Summary

Membership deletion and role changes neither delete affected session shares nor invoke the existing gateway drain helper. The gateway authorizes only at WebSocket upgrade and then tracks the socket until it closes, allowing a removed read grantee to keep observing and a removed or demoted read-write grantee to keep steering the shared session.

#### Root Cause

Authorization is snapshotted into an upgraded connection, but member and role lifecycle paths do not invoke the available revocation/drain primitive or bind sockets to a revocable generation.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- Member PATCH/DELETE paths contain no share cleanup or drain call.
- Explicit share DELETE removes the row and invokes drainWorkspaceMemberConnections when the last target share is gone.
- The gateway stores identity on each upgraded connection and closes it only when /admin/drain matches.
- The targeted session-shares suite passed, confirming the explicit revoke/drain behavior used as the missing control.

Counterevidence and remaining uncertainty:
- After disconnection, an ordinary removed member cannot mint a replacement ticket.
- Read-only grants remain read-only.
- The attacker must already hold a relevant live connection.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/workspace-members.ts:207-247, packages/control-plane/core/workspace-members.ts:311-330, packages/control-plane/core/session-shares.ts:279-327, packages/control-plane/core/workspace-drain.ts:29-60, packages/box/gateway/main.go:444-490, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Open a WebSocket to a shared session while the grant is valid.
- An administrator removes the member or demotes their role.
- The lifecycle route updates/deletes the ACL but does not delete shares or call the gateway drain.
- Keep the socket alive with ordinary pings and continue using its original authorization.

#### Reachability

A grantee keeps a shared-session socket open while an administrator removes or demotes them; no drain occurs, so the established channel continues with its original scope.

- **Attacker:** A workspace member holding an explicit read or read-write session share.

- **Entry point:** An already-upgraded shared Lody WebSocket.

- **Source:** Identity and share scope captured in the ticket at upgrade.

- **Sink:** Long-lived Lody session data plane and read/write session commands.

- **Outcome:** Continued observation or manipulation after membership or role revocation.

Preconditions:
- A relevant share and live WebSocket exist at the instant of removal or demotion.

Existing controls:
- Tickets expire after 60 seconds for new handshakes.
- Explicit share deletion has a best-effort drain.
- The gateway enforces viewer restrictions captured at handshake.

#### Severity

**Medium** — The impact can be high for a read-write session, but likelihood is medium because exploitation requires a relevant explicit share and an already-open socket at the lifecycle event.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** Read-write grantees can continue prompting, steering, or cancelling private agent sessions; readers retain private worktree/session visibility.

Likelihood assessment:
- **Level:** medium
- **Rationale:** Long-lived sockets are normal, but the attack depends on an existing share and timing with a lifecycle change.

#### Remediation

As part of member removal and role demotion, delete or recompute affected share grants and drain the grantee from every serving gateway before returning success. Bind each socket to a membership/role generation and close it when that generation changes.

Tests:
- Removing a member closes their read-only and read-write shared-session sockets.
- Demoting to viewer closes or downgrades every established write-capable socket.
- A failed drain is retried durably rather than left best-effort indefinitely.

Preventive controls:
- Centralize live-channel revocation in the same membership lifecycle coordinator as token and machine cleanup.

<a id="finding-7"></a>

### [7] Any active member can allocate unbounded provider-billed volumes

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The public route, parser, deployment credential fallback, and billing provider sink are explicit. Exact monetary exposure depends on provider/account policy. |
| Category | Uncontrolled allocation of billable resources |
| CWE | CWE-770 |
| Affected lines | packages/control-plane/core/volumes.ts:13-19, packages/control-plane/core/volumes.ts:27-50, packages/control-plane/core/compute/org-credentials.ts:458-472, packages/control-plane/core/compute/hetzner.ts:618-629, packages/control-plane/core/janitors.ts:140-147 |

#### Summary

POST /volumes accepts any positive safe integer size and invokes Hetzner volume creation with no role, entitlement, maximum-size, count, byte, or rate check. When no organization credential exists, volume resolution can fall back to the deployment's Hetzner credential, allowing open-signup or ordinary members to consume operator-funded storage until provider limits intervene.

#### Root Cause

The raw provider allocation API is guarded as ordinary organization functionality but bypasses the entitlement/quota reservation model used for workspace compute, and manually created volumes are not retention swept.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- sizeGb uses positiveInteger with no application maximum.
- Any active membership reaches provider createVolume before an ownership row is written.
- resolveVolume explicitly preserves deployment-credential fallback.
- No route-level rate, count, byte, role, or entitlement check exists.
- The volume janitor excludes manual POST /volumes allocations.

Counterevidence and remaining uncertainty:
- A Hetzner credential path must be configured.
- Provider-side size, account, and API limits bound spend.
- The web client does not expose the raw mutation, but direct HTTP access remains available.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/volumes.ts:13-19, packages/control-plane/core/volumes.ts:27-50, packages/control-plane/core/compute/org-credentials.ts:458-472, packages/control-plane/core/compute/hetzner.ts:618-629, packages/control-plane/core/janitors.ts:140-147, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Join or create an organization.
- Send repeated POST /volumes requests with provider-accepted large sizes.
- The control plane falls back to its deployment credential if needed and creates each volume without an application reservation.
- Manual volumes persist until explicitly deleted.

#### Reachability

An active member scripts large or repeated raw volume-create requests; the control plane charges them to the org or deployment credential without reserving quota and never automatically reclaims the manual rows.

- **Attacker:** Any active organization member, including an open-signup user when deployment compute is available.

- **Entry point:** POST /volumes.

- **Source:** Attacker-controlled name, sizeGb, and location.

- **Sink:** Hetzner POST /volumes using org or deployment credentials.

- **Outcome:** Provider storage exhaustion and operator/organization charges.

Preconditions:
- A deployment or organization Hetzner credential is configured and has available provider quota.

Existing controls:
- Inputs must be positive safe integers.
- Provider/account limits eventually refuse allocation.

#### Severity

**Medium** — Impact is medium financial/resource abuse and likelihood is high where deployment credentials are configured; the provider's own account limits bound the maximum loss.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Rationale:** The result is financial and availability harm rather than direct confidentiality compromise.

Likelihood assessment:
- **Level:** high
- **Rationale:** The endpoint is remote, scriptable, membership-only, and lacks any application throttle or quota.

#### Remediation

Remove the unused manual volume-create route or make it operator/admin-only. Enforce provider-aware maximum size, per-org volume count/bytes, rate limits, platform-compute entitlement, and an atomic quota reservation before the external create. Add rollback and retention for orphaned/manual allocations.

Tests:
- Ordinary members and non-entitled open-signup orgs cannot create manual volumes.
- Oversize, over-count, over-byte, and rate-exceeded requests fail before any provider call.
- Concurrent requests cannot overrun a reserved quota.

Preventive controls:
- Route every billable external allocation through one quota/entitlement reservation service.

<a id="finding-8"></a>

### [8] Any organization member can overwrite trusted agent instructions used by private workspaces

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The write, selection, delivery, installation, and privileged-agent chain is source-complete. Actual downstream command/exfiltration behavior is model-dependent, which is reflected in severity. |
| Category | Missing authorization on security-critical shared configuration |
| CWE | CWE-862, CWE-639 |
| Affected lines | packages/control-plane/core/app.ts:101-103, packages/control-plane/core/agent-rules.ts:165-176, packages/control-plane/core/agent-rules.ts:194-219, packages/control-plane/core/agent-rules.ts:150-161, packages/box/rootfs/usr/local/bin/blitz-rules:116-160, packages/box/rootfs/usr/local/libexec/blitz-term:35-40, packages/box/rootfs/usr/local/libexec/blitz-codex-session:114 |

#### Summary

Membership-only agent-rule library routes let an ordinary same-org member read and overwrite any mutable rule by ID without creator, workspace-membership, workspace-admin, or org-admin authorization. A victim workspace retains the mutable ID; on boot the box installs the attacker's content as Claude and Codex instruction files before agents run with permission enforcement bypassed.

#### Root Cause

A mutable organization-wide content object is treated as harmless shared configuration even though it is consumed as authoritative startup instructions inside full-trust agent runtimes.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- The library is mounted behind active membership only.
- PUT authorizes same org but not creator, admin role, or any referencing workspace.
- A selected workspace rule is fetched by a box and atomically written to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md.
- Agent launchers disable permission prompts/approvals.
- The targeted agent-rules suite passed and explicitly confirms a plain member may author the shared library.

Counterevidence and remaining uncertainty:
- Cross-organization writes are denied and the built-in rule is immutable.
- The victim must reference a custom rule and later boot or sync.
- Command execution or exfiltration depends on subsequent victim agent behavior and model compliance.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/app.ts:101-103, packages/control-plane/core/agent-rules.ts:165-176, packages/control-plane/core/agent-rules.ts:194-219, packages/control-plane/core/agent-rules.ts:150-161, packages/box/rootfs/usr/local/bin/blitz-rules:116-160, packages/box/rootfs/usr/local/libexec/blitz-term:35-40, packages/box/rootfs/usr/local/libexec/blitz-codex-session:114, but no expanded source-to-sink narrative was recorded.

Attack steps:
- List the org rule library and identify a custom mutable rule.
- Overwrite its content through the membership-only PUT route.
- A workspace already referencing that ID boots or syncs and fetches the current content.
- blitz-rules installs it into both agent instruction paths.
- A subsequent victim agent session interprets the malicious instructions with broad VM permissions.

#### Reachability

An ordinary org member overwrites a custom rule referenced by a workspace they cannot access; the next box sync installs it into trusted agent instruction paths, influencing later full-trust agent execution.

- **Attacker:** Any active ordinary member of the victim organization, without membership in the victim workspace.

- **Entry point:** GET /agent-rules to learn IDs and PUT /agent-rules/:id to overwrite content.

- **Source:** Attacker-controlled rule content.

- **Sink:** Claude/Codex canonical instruction files and permission-bypassed agent sessions in the victim workspace.

- **Outcome:** Stored cross-workspace instruction injection that can direct agents to alter files, invoke credential tools, or expose workspace data.

Preconditions:
- A victim workspace references the custom rule and later syncs; a subsequent agent follows the injected content.

Existing controls:
- Cross-org IDs are hidden.
- Content is capped at 256 KiB.
- The built-in rule cannot be overwritten.

#### Severity

**Medium** — Impact can be high trusted-instruction compromise across workspace boundaries, but likelihood is medium because a victim must use a custom mutable rule, sync/boot afterward, and an agent must follow the injected instructions.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** Successful instruction execution can cross into private workspace data and credentials under full-trust agent permissions.

Likelihood assessment:
- **Level:** medium
- **Rationale:** The stored injection is deterministic, but consequential execution requires later victim/model activity.

#### Remediation

Restrict organization-library mutation to org administrators and require an authorized workspace admin to adopt each immutable version. Prefer content-addressed/versioned rules so editing a library object cannot silently alter existing workspaces; show and audit diffs before rollout.

Tests:
- An ordinary org member cannot create, update, or delete shared rules.
- Updating a library rule creates a new version and does not change existing workspace content without workspace-admin approval.
- Every adoption records actor, workspace, old digest, and new digest.

Preventive controls:
- Classify agent prompts/instructions as executable security-critical configuration.

<a id="finding-9"></a>

### [9] Old session-share grants silently reactivate when a removed member is re-added

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Schema keys, removal behavior, re-add identity reuse, and ticket-mint query form a complete static chain. |
| Category | Use of stale authorization grant after relationship recreation |
| CWE | CWE-672 |
| Affected lines | packages/control-plane/migrations/0045_session_shares.sql:17-30, packages/control-plane/core/workspace-members.ts:137-170, packages/control-plane/core/workspace-members.ts:311-330, packages/control-plane/core/session-shares.ts:70-83 |

#### Summary

session_shares references stable organization membership IDs rather than a workspace-membership incarnation. Removing a member leaves those rows intact; re-adding the same organization membership restores ticket minting from the old rows without fresh consent, including prior read-write grants.

#### Root Cause

A share grant is keyed to durable org membership rather than the revocable workspace relationship or an incarnation/generation of that relationship.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- Both grantee and owner foreign keys reference memberships(id), not workspace_members.
- Workspace-member removal does not delete shares.
- Re-add uses the same membershipId in an upsert.
- Ticket mint queries old rows solely by workspaceId, grantee membershipId, and owner membershipId.

Counterevidence and remaining uncertainty:
- The stale row cannot mint while an ordinary member remains removed.
- An authorized admin must re-add the member.
- A row naming a no-longer-existing session grants no effective access.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/migrations/0045_session_shares.sql:17-30, packages/control-plane/core/workspace-members.ts:137-170, packages/control-plane/core/workspace-members.ts:311-330, packages/control-plane/core/session-shares.ts:70-83, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Receive a session share while a workspace member.
- Be removed; the workspace row is deleted but the share row persists.
- Later be re-added under the same organization membership ID.
- Request the old target session; ticket mint consumes the dormant row and restores its prior level.

#### Reachability

A former grantee is legitimately re-added for ordinary workspace access, and the old durable share row immediately restores access to a private session without the owner or admin reauthorizing it.

- **Attacker:** A former workspace member who previously held an explicit session share.

- **Entry point:** POST /workspaces/:id/members followed by a shared webApp request.

- **Source:** Dormant session_shares row keyed by stable organization membership ID.

- **Sink:** shareClaimForTarget and a newly minted session ticket.

- **Outcome:** Unexpected restoration of prior read or read-write private-session authority.

Preconditions:
- Authorized re-addition occurs and the referenced target session still exists.

Existing controls:
- No tickets mint while an ordinary user is removed.
- Missing target sessions have no effect.

#### Severity

**Medium** — Impact is high for resurrected read-write session control, while likelihood is medium because an authorized administrator must re-add the former member and the referenced session must still exist.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** A stale rw grant can restore control of private agent sessions without renewed consent.

Likelihood assessment:
- **Level:** medium
- **Rationale:** Re-addition and session survival are plausible lifecycle events but not attacker-controlled in isolation.

#### Remediation

Delete all shares involving a membership on full workspace removal, or key shares to a workspace-membership incarnation that changes on every re-add. Require explicit reauthorization before carrying grants across a new relationship.

Tests:
- Remove and re-add a grantee, then verify all previous share rows remain unusable until newly granted.

Preventive controls:
- Give revocable relationships immutable incarnation IDs and bind all derived grants to them.

<a id="finding-10"></a>

### [10] Workspace removal relies on fallible VM destruction to end direct machine access

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The ordering and failure exits are explicit in removal, destroyMachine, and the janitor. Runtime failure frequency is unknown, which affects likelihood rather than validity. |
| Category | Security revocation depends on incomplete external resource cleanup |
| CWE | CWE-404 |
| Affected lines | packages/control-plane/core/workspace-members.ts:311-329, packages/control-plane/core/machines.ts:451-490, packages/control-plane/core/janitors.ts:42-137, packages/box/gateway/main.go:444-490 |

#### Summary

The member ACL is committed before destroyMachine. Although machine API tokens are revoked early, tunnel/SSH cleanup and final state changes occur only after external shutdown, detach, and destroy calls. A slow or failed provider operation leaves a reachable destroying VM and already-open terminal or SSH access until a best-effort janitor eventually succeeds.

#### Root Cause

Logical authorization revocation, network severance, and slow physical destruction are one sequential request rather than separate fail-closed stages backed by a durable teardown state machine.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- The ACL deletion commits before destroyMachine is invoked.
- destroyMachine marks destroying and revokes token families, then awaits fallible provider destruction before tunnel cleanup and SSH-field clearing.
- The orphan sweep retries destroying rows but skips indefinitely on provider ownership/credential/operation errors.
- An already-open gateway socket is not closed by token-family revocation.

Counterevidence and remaining uncertainty:
- Fresh browser and machine-token control-plane requests are rejected after successful ACL/token revocation.
- Successful provider shutdown ends reachability.
- Exploitation needs a retained direct channel and an external teardown delay or failure.

Limitations:
- Provider failure rates and network reach after each provider-specific partial failure were not measured.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/workspace-members.ts:311-329, packages/control-plane/core/machines.ts:451-490, packages/control-plane/core/janitors.ts:42-137, packages/box/gateway/main.go:444-490, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Keep a direct SSH or interactive socket open.
- An admin deletes the workspace membership.
- destroyMachine begins but a provider shutdown/detach/destroy operation throws or stalls.
- Because network/tunnel/drain cleanup is later, continue using the still-reachable VM while retries fail.

#### Reachability

A member maintains an SSH or terminal connection during removal; an external provider teardown call fails before network/tunnel cleanup, leaving the full-trust VM reachable while the database says access was removed.

- **Attacker:** A workspace member being removed who already has interactive access to their machine.

- **Entry point:** Existing SSH or gateway connection to the member VM.

- **Source:** Installed SSH key or established socket.

- **Sink:** Provider VM left in destroying state with network surfaces still present.

- **Outcome:** Continued access to workspace data and already-delivered credentials during an unbounded cleanup interval.

Preconditions:
- An existing direct channel and a slow or failed provider teardown.

Existing controls:
- Machine API token families are revoked before provider destruction.
- A lazy janitor retries rows in destroying state.

#### Severity

**Medium** — Impact is high because the retained foothold is a privileged VM, but likelihood is medium: it requires a slow/failing provider operation and an already-open connection or installed key.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** The retained channel controls a privileged single-tenant VM with workspace data and credentials.

Likelihood assessment:
- **Level:** medium
- **Rationale:** Provider failures are plausible but not attacker-controlled; the attacker must prepare a connection before revocation.

#### Remediation

Separate immediate revocation from physical destruction: atomically revoke all credentials and grants, drain sockets, disable SSH/tunnel ingress, and mark a durable teardown job before calling the provider. Retry provider cleanup idempotently until complete and alert on aged destroying rows.

Tests:
- Inject failures at every provider teardown step and verify membership removal immediately blocks SSH/tunnel/WebSocket access.
- Verify the durable job resumes and completes without restoring any capability.

Preventive controls:
- Design resource cleanup so security state fails closed independently of provider availability.

<a id="finding-11"></a>

### [11] Deleted-workspace history exposes private project metadata to unrelated org members

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | The contrasting list filters and projection fields are explicit. The only uncertainty is whether organization-wide recovery visibility is intended product policy. |
| Category | Authorization-sensitive metadata exposure |
| CWE | CWE-200 |
| Affected lines | packages/control-plane/core/workspaces.ts:686-698, packages/control-plane/core/workspaces.ts:711-735, packages/control-plane/core/workspace-records.ts:193-228 |

#### Summary

The active workspace list filters projections with no access role, but /workspaces/history returns every deleted workspace in the organization to any active member. Null-role projections still include project name, owner, identifiers, timestamps, agent-rule ID, and limited retained infrastructure metadata.

#### Root Cause

The recovery-history route is organization-scoped rather than workspace- or admin-scoped, while it reuses a projection that retains identifying metadata even when role is null.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- GET /workspaces filters role=null projections.
- GET /workspaces/history requires only active organization membership and omits the equivalent filter.
- workspaceView suppresses members/connections/SSH but retains names, owner, IDs, timestamps, agentRuleId, and retained-volume-related fields.

Counterevidence and remaining uncertainty:
- Cross-organization access is blocked.
- Workspace content, member roster, credentials, and SSH details are not returned.
- The route may be intended as an organization-wide recovery catalog, though recreate is admin-gated.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/workspaces.ts:686-698, packages/control-plane/core/workspaces.ts:711-735, packages/control-plane/core/workspace-records.ts:193-228, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Join the same organization.
- Call GET /workspaces/history.
- The route queries all deleted rows with retained volumes and projects them without the active-list role filter.
- Read metadata for unrelated former workspaces.

#### Reachability

An unrelated same-org member calls the history endpoint and receives identifying metadata for deleted workspaces in which they never held a role.

- **Attacker:** Any active organization member.

- **Entry point:** GET /workspaces/history.

- **Source:** Organization-wide query over deleted workspace rows.

- **Sink:** WorkspaceView fields returned with role=null.

- **Outcome:** Disclosure of private project names, ownership, identifiers, timestamps, rule selection, and limited recovery metadata.

Preconditions:
- A deleted workspace with retained volume exists in the same organization.

Existing controls:
- Cross-org isolation holds.
- High-sensitivity content fields are suppressed.

#### Severity

**Low** — Impact is low metadata disclosure and likelihood is high for any same-org member. Sensitive content, credentials, members, and SSH details remain hidden.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** low
- **Rationale:** Only metadata is exposed.

Likelihood assessment:
- **Level:** high
- **Rationale:** The route is directly reachable by every active same-org member.

#### Remediation

Restrict recovery history to organization administrators or to callers with current/historical workspace grants, and minimize null-role projections to opaque recovery records where broader visibility is required.

Tests:
- An unrelated ordinary member cannot enumerate deleted workspace metadata; an authorized recovery admin still can.

Preventive controls:
- Apply the same row-level visibility predicate to active, deleted, search, and history views.

<a id="finding-12"></a>

### [12] Machine credential routes do not recheck current workspace membership

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | The missing ACL query and ordering are explicit; uncertainty concerns the practical duration and incremental attacker value, not the code path. |
| Category | Missing current relationship check on machine-authenticated request |
| CWE | CWE-862 |
| Affected lines | packages/control-plane/core/workspace-members.ts:311-329, packages/control-plane/core/agent-routes.ts:62-95, packages/control-plane/core/agent-routes.ts:156-209, packages/control-plane/core/org-credentials.ts:149-167, packages/control-plane/core/machines.ts:451-464 |

#### Summary

boxCaller authenticates the machine token and active organization membership, then trusts the machine's stored workspace ID without requiring a current workspace_members row. During the interval between ACL deletion and token-family revocation—or if the request terminates between those operations—the removed member's machine can still read a workspace-granted organization credential and potentially mutate one covered by a write grant.

#### Root Cause

Machine identity derives workspace authority from a durable machines.workspace_id pointer rather than revalidating the revocable workspace_members relationship on each privileged credential request.

#### Validation

Validation outcomes are recorded below.

Validation method: Static source/control/sink tracing against the registered Git revision, plus focused existing tests where identified.

- **Status:** validated
- **Disposition:** reportable

Assertions:
- boxCaller verifies active organization membership but never queries workspace_members.
- It supplies the stale machine workspace ID to orgCredentialAccess, so a workspace-scoped grant still covers it.
- Removal deletes the ACL before calling destroyMachine, which revokes the token in a later database operation.
- The direct organization-credential branch returns the decrypted value when the stale workspace grant covers the request.

Counterevidence and remaining uncertainty:
- Fully successful teardown revokes the token family quickly.
- Disabled organization memberships are rejected by boxCaller.
- Provider-connection minting performs additional workspace authorization; the strongest sink is the direct org-credential path.
- The attacker could have copied the credential before removal, limiting incremental impact.

#### Dataflow

The canonical finding records the affected path at packages/control-plane/core/workspace-members.ts:311-329, packages/control-plane/core/agent-routes.ts:62-95, packages/control-plane/core/agent-routes.ts:156-209, packages/control-plane/core/org-credentials.ts:149-167, packages/control-plane/core/machines.ts:451-464, but no expanded source-to-sink narrative was recorded.

Attack steps:
- Continuously request a workspace-granted organization credential.
- An administrator deletes the workspace ACL.
- Before destroyMachine deletes the token family, one request authenticates.
- boxCaller does not observe the missing workspace row and the workspace grant releases the value.

#### Reachability

A removed member's still-valid machine bearer races the non-atomic gap after ACL deletion; boxCaller accepts the active org membership and stale machine workspace pointer, and a workspace grant releases a secret.

- **Attacker:** A workspace member being removed who controls their machine bearer.

- **Entry point:** POST /agent/credentials/:name/token.

- **Source:** Machine bearer plus machines.workspace_id after workspace_members deletion.

- **Sink:** Decrypted organization credential covered by a workspace grant.

- **Outcome:** One or more post-removal secret reads/writes during a narrow revocation window.

Preconditions:
- An active org membership, valid machine token, applicable org-credential grant, and precise timing or interrupted teardown.

Existing controls:
- Token family revocation occurs before external VM destruction.
- Many downstream machine APIs require active membership/current access.
- Access tokens expire.

#### Severity

**Low** — Impact could be high for a granted secret, but likelihood is low: normal teardown revokes the token family immediately after ACL deletion, the attacker had the same access immediately beforehand, and the exploitable interval is narrow.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Rationale:** The sink can disclose or mutate organization secrets.

Likelihood assessment:
- **Level:** low
- **Rationale:** The path is a narrow race/interruption and often adds little beyond access held moments earlier.

#### Remediation

Require a current non-viewer workspace_members row and live machine state in boxCaller before every privileged operation. Delete the ACL and revoke machine token families/derived capabilities in one transaction, then perform external cleanup.

Tests:
- A machine request issued after its workspace row is deleted is denied even if its token family still exists.
- Concurrent credential requests cannot succeed after the removal transaction commits.

Preventive controls:
- Every delegated capability should recheck the current relationship it derives authority from.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Workspace authorization and member removal | Broken access control and incomplete revocation | Reported | Org-admin implicit reach, direct static-token reuse, and deleted-history visibility were validated; ordinary workspace-only admins are denied by fresh API calls after removal. |
| Guest webApp tickets, static credentials and public tunnels | Bearer lifetime, role binding and revocation | Reported | Static owner-equivalent compatibility credential survives ACL changes; short-lived ticket verification itself fails closed for new requests. |
| Shared-session grants and upgraded connections | Live authorization and stale grant resurrection | Reported | Removal/demotion omit drain and share incarnation binding; explicit share revoke contains the expected drain control. |
| Member and organization machine lifecycle | Direct access retained after logical revocation | Reported | Organization disable has no machine cleanup; workspace removal cleanup is ordered after fallible provider work. |
| Machine OAuth and credential routes | Stale delegated authority | Reported | A narrow workspace-removal race remains because boxCaller omits the current workspace row; most disabled-member machine API paths correctly fail closed. |
| Fleet broker enrollment, placement and credential deposit | Cross-tenant credential interception | Reported | Box ownership is incorrectly accepted as fleet-operator enrollment authority. |
| Provider volume creation, listing and deletion | Object authorization and resource quotas | Reported | Cross-workspace detached-volume deletion and unbounded provider-funded allocation were validated. |
| Shared agent instruction library and guest installation | Trusted configuration injection | Reported | Any active org member may overwrite mutable instructions consumed by inaccessible workspaces. |
| Sessions, invites, organization roles and disablement | Offboarding completeness | Reported | Browser/session principal checks generally revalidate active membership; organization disablement fails to revoke machine-side capabilities. |
| Connection grants, credential minting and proxy leases | Post-removal delegated credential reuse | Rejected | The late lease-revocation candidate was suppressed as a standalone finding: the lease resolves only the attacker's own user grant, expires, and does not establish a new cross-user privilege boundary. Early revocation remains defense in depth. |
| Folder grants, files and workspace attachments | Cross-workspace object authorization | No issue found | Active mounted routes consistently apply organization and workspace/folder grant checks; no independent source-to-sink bypass survived review. |
| Compute credentials, machine types and workspace settings | Privileged administration | No issue found | No additional independent auth bypass survived beyond the centralized org-admin override and volume routes already reported. |

## Open Questions And Follow Up

- Independent baseline worker candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit baseline:broker-enrollment and close its stated proof gap. Paths: packages/control-plane/core/app.ts, packages/control-plane/core/oauth.ts, packages/control-plane/core/registry.ts, packages/broker/internal/workspace/watch.go, packages/broker/internal/workspace/ssh.go, packages/broker/internal/broker/deposit.go. Surfaces: fleet-broker-enrollment.
- Independent baseline worker candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit baseline:stale-machine-workspace-auth and close its stated proof gap. Paths: packages/control-plane/core/agent-routes.ts, packages/control-plane/core/org-credentials.ts, packages/control-plane/core/workspace-members.ts, packages/control-plane/core/machines.ts. Surfaces: machine-agent-auth, workspace-auth.
- Focused lifecycle worker candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit lifecycle:org-admin-workspace-override and close its stated proof gap. Paths: packages/control-plane/core/workspace-members.ts, packages/control-plane/core/workspace-access.ts, packages/control-plane/core/workspaces.ts, packages/control-plane/core/session-shares.ts, packages/control-plane/core/machines.ts, packages/control-plane/core/workspace-settings.ts, packages/control-plane/core/files/attachments.ts, packages/control-plane/core/box-config.ts, packages/control-plane/core/connections/mint.ts, packages/control-plane/core/connections/requests.ts, packages/control-plane/core/connections/leases.ts, packages/control-plane/core/webapp-state.ts. Surfaces: workspace-auth.
- Focused lifecycle worker candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit lifecycle:live-shared-websocket and close its stated proof gap. Paths: packages/control-plane/core/workspace-members.ts, packages/control-plane/core/session-shares.ts, packages/control-plane/core/workspace-drain.ts, packages/control-plane/core/webapp-tickets.ts, packages/box/gateway/main.go, packages/webapp/src/lody/data-plane-connection.ts, packages/box/rootfs/usr/local/libexec/blitz-lody-bridge. Surfaces: session-share-revocation.
- Focused lifecycle worker candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit lifecycle:share-resurrection and close its stated proof gap. Paths: packages/control-plane/migrations/0045_session_shares.sql, packages/control-plane/core/workspace-members.ts, packages/control-plane/core/session-shares.ts. Surfaces: session-share-revocation.
- Focused lifecycle worker candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit lifecycle:provider-teardown-interactive-access and close its stated proof gap. Paths: packages/control-plane/core/workspace-members.ts, packages/control-plane/core/machines.ts, packages/control-plane/core/janitors.ts, packages/control-plane/core/compute/hetzner.ts, packages/control-plane/core/compute/aws.ts, packages/control-plane/core/compute/microvm.ts, packages/box/gateway/main.go. Surfaces: machine-teardown.
- Independently validated candidate checkpointed before parent final validation and ranking.
  - Follow-up prompt: Review deferred unit parent:volume-api-auth-and-quota and close its stated proof gap. Paths: packages/control-plane/core/volumes.ts, packages/control-plane/core/compute/org-credentials.ts, packages/control-plane/migrations/0010_volume_ownership.sql, packages/control-plane/migrations/0038_workspace_volumes.sql. Surfaces: volume-api.
- Independently validated candidate checkpointed before parent final validation and ranking.
  - Follow-up prompt: Review deferred unit parent:agent-rule-injection and close its stated proof gap. Paths: packages/control-plane/core/agent-rules.ts, packages/box/rootfs/usr/local/bin/blitz-rules, packages/control-plane/test/agent-rules-library.test.ts. Surfaces: agent-rules.
- Independent route-inventory candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit baseline-followup:org-disable-machine-revocation and close its stated proof gap. Paths: packages/control-plane/core/identity/members.ts, packages/control-plane/core/oauth.ts, packages/control-plane/core/machines.ts, packages/control-plane/core/cloud-init.ts, packages/control-plane/core/bootstrap.ts, packages/control-plane/core/workspace-records.ts. Surfaces: machine-teardown, machine-agent-auth, workspace-auth.
- Independent route-inventory candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit baseline-followup:late-proxy-lease-revocation and close its stated proof gap. Paths: packages/control-plane/core/workspace-members.ts, packages/control-plane/core/machines.ts, packages/control-plane/core/connections/leases.ts, packages/control-plane/core/connections/minters/grant.ts, packages/control-plane/core/connections/proxy.ts. Surfaces: machine-teardown, machine-agent-auth.
- Independent route-inventory candidate checkpointed before parent validation.
  - Follow-up prompt: Review deferred unit baseline-followup:deleted-workspace-history and close its stated proof gap. Paths: packages/control-plane/core/workspaces.ts, packages/control-plane/core/workspace-records.ts. Surfaces: workspace-auth.
- Parent source/control/sink trace completed after worker review; final validation and ranking pending.
  - Follow-up prompt: Review deferred unit parent:static-webapp-owner-token and close its stated proof gap. Paths: packages/control-plane/core/webapp-tickets.ts, packages/control-plane/core/cloud-init.ts, packages/control-plane/core/workspace-tunnels.ts, packages/control-plane/core/workspace-records.ts, packages/box/gateway/main.go, docs/TUNNEL.md, plans/CONNECTIVITY.md. Surfaces: guest-webapp-auth, workspace-auth, machine-teardown.

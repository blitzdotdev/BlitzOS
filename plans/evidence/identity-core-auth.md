The change is feasible, but it is not a grant-table-only change. Human identity currently terminates at the control-plane surface proxy; inside a workspace, terminal, files, agent sessions, and credentials all collapse to one `blitz` Unix user and one workspace-owner box identity. I made no repository changes.

## 1. Authentication today

### Browser/operator flow

1. The only configured human identity is a `Principal` containing `id`, `unixName`, and permitted harnesses; it has no email, profile, organization, role, or tenant fields. [`principals.ts:13-17`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/principals.ts:13)

2. Login accepts a bearer token or `x-operator-key`, compares it with the single `OPERATOR_API_KEY`, and always returns:

   ```ts
   { id: "operator", unixName: "operator", harnesses: ["claude", "codex"] }
   ```

   [`principals.ts:79-87`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/principals.ts:79)

3. `POST /sessions` exchanges that operator key, upserts the principal, stores only the SHA-256 token hash, and returns `blitz_session` as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. [`sessions.ts:18-27`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/sessions.ts:18) [`principals.ts:90-120`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/principals.ts:90)

4. Subsequent requests hash the cookie and join `sessions` to `principals`, requiring `expires_at > now`. [`principals.ts:61-77`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/principals.ts:61)

5. `requirePrincipal` performs that lookup, returns 401 if absent, and re-upserts the principal. [`app.ts:21-27`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/app.ts:21)

6. `DELETE /sessions` deletes only the session identified by the current cookie. There is no human session-list or session-administration endpoint. [`sessions.ts:29-40`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/sessions.ts:29)

7. The UI login path sends the operator key and thereafter relies on cookies. [`api.ts:51-53`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api.ts:51) [`api.ts:66-72`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api.ts:66)

### Box identities and tokens

There are two box enrollment paths:

- BYOM/device authorization creates an unauthenticated device capability, but `/oauth/device/approve` requires the human principal and binds the approved device to that principal. [`oauth.ts:169-220`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/oauth.ts:169)
- `/oauth/token` exchanges the approved capability or rotates a refresh token, creating a box whose `principal_id` is the approving principal. [`oauth.ts:222-294`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/oauth.ts:222)
- Managed workspace phone-home uses a one-time URL capability, not a human session. It creates the box by copying `workspaces.owner_id` into `boxes.principal_id`. [`workspaces.ts:407-422`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:407) [`workspaces.ts:448-490`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:448)
- Box bearer authentication hashes the access token and returns `boxId`, `principalId`, `workspaceId`, and broker status. [`oauth.ts:137-162`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/oauth.ts:137)
- Access tokens last 15 minutes and refresh tokens rotate their token family generation. [`oauth.ts:16-19`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/oauth.ts:16) [`oauth.ts:101-135`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/oauth.ts:101)
- Box registry operations require the bearer-authenticated box ID to equal the route box ID. [`registry.ts:60-69`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/registry.ts:60)

### Mode-B/Teenybase

Mode B does not introduce a different user model:

- The generated Teenybase configuration explicitly defines `principals`, `sessions`, and all Blitz tables. Every direct table operation has deny-all rules. [`build-blitzdev.mjs:64-99`](/Users/minjunes/blitz-core-microvm/packages/control-plane/scripts/build-blitzdev.mjs:64) [`build-blitzdev.mjs:275-304`](/Users/minjunes/blitz-core-microvm/packages/control-plane/scripts/build-blitzdev.mjs:275)
- Its generated worker still imports and instantiates the same `createOperatorPrincipalSource`, backed by the same `OPERATOR_API_KEY`. [`build-blitzdev.mjs:334-372`](/Users/minjunes/blitz-core-microvm/packages/control-plane/scripts/build-blitzdev.mjs:334) [`build-blitzdev.mjs:492-511`](/Users/minjunes/blitz-core-microvm/packages/control-plane/scripts/build-blitzdev.mjs:492)
- The schema test asserts the exact table set and verifies deny-all extensions on every table. That set contains `principals` and `sessions`, but no Teenybase `users`, organizations, memberships, or auth tables. [`blitzdev-schema.test.ts:9-40`](/Users/minjunes/blitz-core-microvm/packages/control-plane/test/blitzdev-schema.test.ts:9)
- The generated migration test checks that same explicit table set. [`blitzdev-schema.test.ts:93-113`](/Users/minjunes/blitz-core-microvm/packages/control-plane/test/blitzdev-schema.test.ts:93)

Therefore, Teenybase supplies persistence/routing here, not user records or a parallel authentication system.

## 2. Data model and migrations 0001–0005

| Migration | Relevant model |
|---|---|
| `0001` | `principals`, browser `sessions`, `workspaces`, device authorizations, boxes, box-token families, broker boxes, and broker keys. [`0001_initial.sql:3-81`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0001_initial.sql:3) |
| `0002` | Adds `sessions.expires_at`; there is still no device/user-agent metadata or session ownership beyond `principal_id`. [`0002_session_expiry.sql:1-8`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0002_session_expiry.sql:1) |
| `0003` | Adds integrations, credential-specific `user_connections`, leases, events, requests, and the workspace manifest. [`0003_credentials.sql:1-65`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:1) |
| `0004` | Adds `workspaces.machine_type_id`; it adds no tenant relationship. [`0004_workspace_machine_type.sql:1-6`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0004_workspace_machine_type.sql:1) |
| `0005` | Adds a global `microvm_hosts` registry keyed by host name. [`0005_microvm_hosts.sql:1-6`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0005_microvm_hosts.sql:1) |

Ownership facts:

- The only `owner_id` column is `workspaces.owner_id`, a required foreign key to `principals.id`. [`0001_initial.sql:15-33`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0001_initial.sql:15)
- Boxes have `principal_id` and an optional unique `workspace_id`; that is box attribution, not a grant or membership. [`0001_initial.sql:46-56`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0001_initial.sql:46)
- `user_connections` is specifically an integration refresh grant keyed by `(user_id, integration_id)`, not a general user record or organization membership. [`0003_credentials.sql:15-23`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:15)
- There are no `users`, `organizations`, `memberships`, `workspace_grants`, invitations, teams, access roles, or share-link tables in migrations 0001–0005. [`0001_initial.sql:3-81`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0001_initial.sql:3) [`0003_credentials.sql:1-65`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:1)
- Volumes are provider resources represented only by a free-form `workspaces.volume_id`; there is no control-plane volume table or volume owner. [`0001_initial.sql:20-21`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0001_initial.sql:20)

A multi-user schema consequently needs at least durable user identities, organizations, organization memberships, workspace grants with role/capabilities, and actor fields on sensitive actions.

## 3. Enforcement points

### Route-by-route matrix

| Surface | Authentication and authorization today |
|---|---|
| `POST /workspaces` | Requires a principal. Stores `principal.id` as owner and applies the concurrent-workspace quota per owner. A supplied `volumeId` is attached without a volume-owner/grant check. [`workspaces.ts:194-245`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:194) [`workspaces.ts:267-269`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:267) |
| `GET /workspaces` | Requires a principal and filters strictly by `owner_id = principal.id`. [`workspaces.ts:299-305`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:299) |
| `GET /workspaces/:id` | No such route exists. The registered workspace routes are create, list, surface, destroy, and phone-home. [`workspaces.ts:194-407`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:194) |
| `ALL /workspaces/:id/surface/:port[/…]` | Requires a principal; missing workspace or `owner_id !== principal.id` becomes 404. Only ports 7444 and 7445 are accepted. [`workspaces.ts:308-336`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:308) [`workspaces.ts:359-360`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:359) |
| `DELETE /workspaces/:id` | Requires a principal and strict owner equality; then shuts down/destroys the VM, revokes workspace leases, and deletes boxes. [`workspaces.ts:362-404`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:362) |
| Workspace phone-home | One-time capability only; no human principal. The resulting box inherits the workspace owner identity. [`workspaces.ts:407-422`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:407) [`workspaces.ts:451-470`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:451) |
| `GET /workspaces/:id/leases` | Requires a principal. Allowed when the caller owns the workspace or its ID is literally `"operator"`. [`mint.ts:241-249`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:241) [`leases.ts:115-140`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:115) |
| `DELETE /leases/:id` | Requires a principal. Uses the same workspace-owner-or-literal-operator rule. [`mint.ts:252-260`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:252) [`leases.ts:143-163`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:143) |
| `GET /requests` | Requires a principal. SQL returns requests for owned workspaces, unless the caller is literal `"operator"`, who sees all. [`requests.ts:217-238`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:217) [`requests.ts:248-258`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:248) |
| Approve/deny request | Requires a principal. Resolution requires workspace owner or literal `"operator"`. The integration allowlist is evaluated against the workspace owner, not the resolving human. [`requests.ts:84-119`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:84) [`requests.ts:261-271`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:261) |
| Volumes create/list/delete | Every route requires any principal, but none filters or checks ownership. The provider operations operate on account-global volume IDs. [`volumes.ts:25-44`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/volumes.ts:25) [`hetzner.ts:382-387`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/providers/hetzner.ts:382) |
| `GET /machine-types` | Requires any principal; machine types are global. [`app.ts:36-40`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/app.ts:36) |
| `POST /hosts/:name/register` | Does not use a human principal. It checks a host-specific bearer registration token. [`microvm.ts:464-479`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/providers/microvm.ts:464) [`microvm.ts:741-760`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/providers/microvm.ts:741) |
| `POST /workspaces/:id/credentials` | Uses box bearer authentication, not the active human. The box may mint only for its own workspace. Authorization then accepts a box whose `principalId` is literal `"operator"` or equals the workspace owner, plus manifest/integration allowlists. [`mint.ts:180-218`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:180) [`mint.ts:62-74`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:62) |
| `ALL /proxy/:leaseId/*` | No principal or box authentication. It extracts the opaque lease token from a configured header and validates token hash, lease state/expiry, integration state, custody, and header prefix. It does not re-check workspace membership or the current human. [`proxy.ts:44-83`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/proxy.ts:44) [`proxy.ts:110-143`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/proxy.ts:110) [`proxy.ts:231-237`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/proxy.ts:231) |
| `GET /integrations` | Requires any principal and returns all global integration metadata. [`registry.ts:281-299`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/registry.ts:281) |
| `PUT /integrations/:name` | Requires any principal. Any principal can create or overwrite the globally unique name; conflict updates do not require creator ownership and do not update `created_by`. [`registry.ts:301-350`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/registry.ts:301) |
| `DELETE /integrations/:name` | Requires any principal. Any principal can globally revoke the integration and its leases. [`registry.ts:353-369`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/registry.ts:353) |
| Box broker/key/feed routes | Require a box token and exact authenticated-box/route-box equality. Key registration rejects workspace boxes; feed access requires a broker box. [`registry.ts:60-69`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/registry.ts:60) [`registry.ts:114-157`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/registry.ts:114) [`registry.ts:199-203`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/registry.ts:199) |

`workspaceView` exposes `canObserve` and `launchable` based only on readiness, not caller role, and does not return owner or grant information. [`workspaces.ts:68-89`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:68) [`wire.ts:43-59`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/wire.ts:43)

## 4. Box/session layer and full hop chain

### Agent journal and ACP sessions

- An agent session stores only `id`, `provider`, `cwd`, and provider resume ID. It has no principal, workspace member, creator, owner, or ACL. [`journal.ts:4-9`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/journal.ts:4)
- SQLite stores sessions, event frames, turns, and permission request/responses. [`journal.ts:16-49`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/journal.ts:16)
- Loading a session requires only that the supplied ID exists and that the requested CWD matches. [`actor.ts:254-266`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:254)
- `prompt` and `cancel` address a session by ID without checking the caller’s identity or even requiring that socket to be attached to the session. [`actor.ts:268-274`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:268)
- Subscribers are random per-WebSocket connection IDs with a set of session IDs; they carry no authenticated identity. [`actor.ts:16-43`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:16)
- Every emitted event and permission request is fanned out to all subscribers of that session. The first valid permission response wins. [`actor.ts:170-241`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:170)
- Tests explicitly assert identical event delivery to multiple subscribers and first-answer-wins permission handling. [`actor.test.ts:228-254`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.test.ts:228) [`actor.test.ts:275-310`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.test.ts:275)
- Replay is capped at the last 2,048 events. [`config.ts:3`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/config.ts:3) [`journal.ts:87-96`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/journal.ts:87)
- ACP exposes `initialize`, `session/new`, `session/load`, `session/prompt`, and `session/cancel`. There is no session-list operation. [`server.ts:54-70`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/server.ts:54)
- The actor listens only on `127.0.0.1:7444`. WebSocket upgrade checks Origin but performs no user/token authentication; a missing Origin is accepted. [`server.ts:14-31`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/server.ts:14) [`config.ts:6-29`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/config.ts:6)

### Terminal/gateway

- The guest gateway exposes port 7445 and routes `/terminal/ws` to ttyd. Its WebSocket control is an Origin allowlist, not authentication; missing Origin is accepted. [`main.go:19-36`](/Users/minjunes/blitz-core-microvm/packages/box/gateway/main.go:19) [`main.go:74-117`](/Users/minjunes/blitz-core-microvm/packages/box/gateway/main.go:74) [`main.go:295-313`](/Users/minjunes/blitz-core-microvm/packages/box/gateway/main.go:295)
- ttyd receives `AuthToken: ""`; the session type/key and optional `ro` argument are URL arguments. [`TtydTerminal.tsx:257-282`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/TtydTerminal.tsx:257)
- `blitz-term … ro` creates the tmux session if absent and uses `tmux attach -r`; normal mode creates/attaches it read-write. [`blitz-term:19-71`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/usr/local/libexec/blitz-term:19)
- The component can suppress input and resizing when `readOnly` is true, but the production `CloudApp` invocation does not pass `readOnly`, so the current terminal is writable. [`TtydTerminal.tsx:48-50`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/TtydTerminal.tsx:48) [`TtydTerminal.tsx:246-253`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/TtydTerminal.tsx:246) [`CloudApp.tsx:1373-1395`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CloudApp.tsx:1373)
- ttyd, the actor, gateway, files service, and interactive shell all run as the single `blitz` user; `/workspace` and state are owned by that identity. [`ttyd/run:3-6`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/etc/s6-overlay/s6-rc.d/ttyd/run:3) [`actor/run:3-5`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/etc/s6-overlay/s6-rc.d/actor/run:3) [`blitz-init-state:41-49`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/usr/local/libexec/blitz-init-state:41)
- There is one installed SSH authorized key for the workspace, not one key or Unix account per member. [`blitz-init-state:69-75`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/usr/local/libexec/blitz-init-state:69)

### Hop chain: user B opens user A’s terminal

Current behavior stops at hop 2:

1. B’s browser sends B’s `blitz_session` cookie to `/workspaces/A/surface/7445/terminal/ws`.
2. The control plane authenticates B, loads A’s workspace, finds `owner_id !== B.id`, and returns 404. [`workspaces.ts:308-315`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:308)

If that one check were changed to permit a grant, the remaining chain would be:

3. The control plane removes browser `Cookie`, `Host`, and authorization headers and substitutes the global microVM-host bearer token. No B identity or role is forwarded. [`microvm.ts:713-738`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/providers/microvm.ts:713)
4. The host validates that static host token and VM ID, strips `Authorization`, proxy authorization, and cookies, then proxies to guest port 7445. [`http.go:53-58`](/Users/minjunes/blitz-core-microvm/packages/microvm-host/internal/server/http.go:53) [`http.go:115-168`](/Users/minjunes/blitz-core-microvm/packages/microvm-host/internal/server/http.go:115)
5. The guest gateway checks only Origin and proxies `/terminal/ws` to ttyd. [`main.go:74-117`](/Users/minjunes/blitz-core-microvm/packages/box/gateway/main.go:74)
6. ttyd uses an empty auth token and invokes `blitz-term` as the shared `blitz` Unix user. [`TtydTerminal.tsx:276-282`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/TtydTerminal.tsx:276) [`ttyd/run:3-6`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/etc/s6-overlay/s6-rc.d/ttyd/run:3)
7. Unless the CP/UI deliberately adds `ro`, B gets the same writable tmux/workspace environment as A. No viewer/editor identity reaches ttyd or tmux. [`blitz-term:51-71`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/usr/local/libexec/blitz-term:51)

Therefore a viewer grant cannot safely be implemented merely by relaxing the surface owner check. The surface must convey an unforgeable capability/role, and terminal, files, and agent operations must enforce it independently.

### Hop chain: user B opens A’s chat

1. B connects through `/workspaces/A/surface/7444`; today the control plane rejects B at the same owner check. [`workspaces.ts:308-315`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:308)
2. After a hypothetical grant, the CP substitutes the host token, and the host strips B’s identity and rewrites actor traffic’s Origin to loopback. [`microvm.ts:721-737`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/providers/microvm.ts:721) [`http.go:147-154`](/Users/minjunes/blitz-core-microvm/packages/microvm-host/internal/server/http.go:147)
3. The actor sees only an allowed Origin and assigns the socket a random subscriber ID; it has no B principal or role. [`server.ts:20-31`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/server.ts:20) [`server.ts:53-76`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/server.ts:53)
4. B can create a new session or load a known session ID. There is no discover/list operation, but knowledge of A’s ID plus matching `/workspace` CWD is sufficient to load its replay. [`server.ts:54-70`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/server.ts:54) [`actor.ts:262-270`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:262)
5. Once subscribed, A and B receive identical event and permission streams; either can answer a permission prompt first. [`actor.ts:170-241`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:170)

Shared sessions therefore require session ownership/membership, session enumeration, per-operation capabilities, actor attribution on messages and permission decisions, and role-aware fan-out.

## 5. UI and client-only state

### Synthetic organization and sharing flags

- `/me` is synthesized as one personal organization named `Personal`, one membership ID `operator`, and role `admin`; it is not obtained from the control plane. [`api-adapter.ts:31-83`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api-adapter.ts:31) [`api-adapter.ts:134-138`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api-adapter.ts:134)
- Every backend workspace is mapped to that personal membership with `canControl: true` and `shared: false`; owner data is absent. The adapter ignores the wire-level `canObserve`. [`api-adapter.ts:96-113`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api-adapter.ts:96)
- The UI model has only a binary `canControl`, a `shared` flag, and organization membership roles `admin | member`. It cannot express workspace roles `owner | editor | viewer`. [`protocol.ts:15-49`](/Users/minjunes/blitz-core-microvm/packages/ui/src/protocol.ts:15)
- Workspace mutation and selection are blocked whenever `canControl` is false. [`workspace-store.ts:73-83`](/Users/minjunes/blitz-core-microvm/packages/ui/src/workspace-store.ts:73) [`workspace-store.ts:198-205`](/Users/minjunes/blitz-core-microvm/packages/ui/src/workspace-store.ts:198)
- `CloudApp` only treats controllable workspaces as active, exposing terminal/chat/files through that same binary permission. [`CloudApp.tsx:368-381`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CloudApp.tsx:368) [`CloudApp.tsx:613-623`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CloudApp.tsx:613)
- Destruction is also keyed solely to `canControl`. Thus mapping editor to `canControl` would implicitly grant delete unless capabilities are split. [`CloudApp.tsx:816-823`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CloudApp.tsx:816) [`CockpitRail.tsx:262-273`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CockpitRail.tsx:262)
- Non-controllable shared workspaces link to `/observe/{org}?workspace=…`, but page-state parsing recognizes only `/settings` and `/workspaces`; there is no functional observer route. [`CockpitRail.tsx:212-233`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CockpitRail.tsx:212) [`sessions-page-state.ts:7-25`](/Users/minjunes/blitz-core-microvm/packages/ui/src/sessions-page-state.ts:7)

### State with no server-side home

The following are localStorage-only:

- Active workspace, rail collapse state, workspace order, local titles, and default agents. [`storage.ts:96-107`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:96) [`storage.ts:173-198`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:173)
- Tab IDs, tab types, chat provider/session ID, file path, and preview port. [`storage.ts:109-132`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:109) [`storage.ts:200-289`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:200)
- File-drawer open/width/expanded-path/segment state. [`storage.ts:127-142`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:127) [`storage.ts:299-340`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:299)
- Chat authorization dismissals. [`storage.ts:342-384`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:342)
- The chat session ID is written into the local tab record and later passed to `ChatPanel`; no server session index exists to recover it. [`CloudApp.tsx:1105-1133`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CloudApp.tsx:1105) [`ChatPanel.tsx:39-116`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/ChatPanel.tsx:39)

Consequences:

- A second device does not know A’s chat session IDs, tabs, titles, ordering, active workspace, open files, or layout, so it creates a new chat instead of discovering the existing one.
- Different real users on the same browser origin would share the fixed `personal/operator` localStorage namespace unless the synthetic namespace is replaced. [`storage.ts:9-12`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:9) [`storage.ts:62-87`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:62)
- Terminal tab IDs become tmux session keys, so independently created client layouts can accidentally converge on the same server tmux session without that being an explicit share grant. [`CloudApp.tsx:1386-1392`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CloudApp.tsx:1386) [`blitz-term:19-51`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/usr/local/libexec/blitz-term:19)

## 6. Credential plane

### What a second workspace user would see or trigger

Current APIs still reject a non-owner B from A’s leases and requests. However, once B is allowed onto the terminal/chat surface:

- Before each agent turn, the actor asks the credential source for the selected provider token. [`actor.ts:111-159`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:111)
- The credential source invokes `blitz-cred token`, which calls the control plane using the workspace box credential. [`credentials.ts:10-27`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/credentials.ts:10) [`controlplane.go:135-141`](/Users/minjunes/blitz-core-microvm/packages/broker/internal/controlplane/controlplane.go:135)
- The CP attributes that mint to the box principal, which for managed workspaces is A’s owner identity—not B. [`workspaces.ts:451-456`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:451) [`mint.ts:210-236`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:210)
- Static/inject credentials are materialized as environment variables or files in the shared workspace environment; proxy credentials are opaque lease tokens plus the proxy URL. [`static.ts:74-104`](/Users/minjunes/blitz-core-microvm/packages/broker/internal/provider/static.ts:74) [`static.ts:82-94`](/Users/minjunes/blitz-core-microvm/packages/broker/internal/provider/static.ts:82)
- Shell synchronization and placement write those values into the shared `blitz` user environment/files. [`cp.go:327-399`](/Users/minjunes/blitz-core-microvm/packages/broker/internal/workspace/cp.go:327) [`cp.go:430-442`](/Users/minjunes/blitz-core-microvm/packages/broker/internal/workspace/cp.go:430)
- The box access and refresh tokens are persisted in `box-credential.json` mode 0600; terminal and actor use the same Unix owner, so OS permissions do not isolate collaborators. [`store.go:16-25`](/Users/minjunes/blitz-core-microvm/packages/broker/internal/store/store.go:16) [`store.go:54-67`](/Users/minjunes/blitz-core-microvm/packages/broker/internal/store/store.go:54) [`ttyd/run:3-6`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/etc/s6-overlay/s6-rc.d/ttyd/run:3)

The effective surfaces are therefore:

- **Requests inbox:** currently owner/operator-only at the API, but the settings UI treats it as a global feed and workspace drawers expose approve/deny actions. [`SettingsPage.tsx:26-117`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/SettingsPage.tsx:26) [`WorkspaceDrawer.tsx:149-214`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/WorkspaceDrawer.tsx:149)
- **Leases panel:** currently owner/operator-only at the API; a future editor mapped to `canControl` would receive the same drawer controls, including revocation. [`WorkspaceDrawer.tsx:31-145`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/WorkspaceDrawer.tsx:31)
- **Mint trigger:** terminal/chat access can indirectly mint credentials through the owner-bound box even if B cannot call the lease/request human APIs.
- **Integration registry:** any authenticated principal can list, create, replace, or delete global integrations independently of workspace grants. [`registry.ts:281-369`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/registry.ts:281)
- **Mint audit:** there is no credential-event list route or UI. Events are internal append-only writes only. [`0003_credentials.sql:42-48`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:42) [`app.ts:29-34`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/app.ts:29)

### Acting-principal attribution

| Record/event | Attribution today |
|---|---|
| `integrations.created_by` | Records the creator principal, but an overwrite does not change it and the list response does not expose it. [`0003_credentials.sql:1-12`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:1) [`registry.ts:324-348`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/registry.ts:324) |
| `credential_requests.resolved_by` | Records the approving or denying principal. There is no requester/initiating-box/user column. [`0003_credentials.sql:50-59`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:50) [`requests.ts:54-81`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:54) |
| Approval event | Includes `resolved_by` in JSON detail. [`requests.ts:168-190`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:168) |
| Denial | Updates `resolved_by`, but appends no denial-resolution event. [`requests.ts:198-215`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:198) |
| `credential_leases` | Records workspace, box, integration, optional `user_id`, scopes, mode, and time. Current creation always writes `user_id = NULL`. [`0003_credentials.sql:25-40`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:25) [`leases.ts:60-111`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:60) |
| Mint/revoke/deny events | Event detail records integration, scopes, box, workspace, and reason, but no acting human. [`leases.ts:87-98`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:87) [`leases.ts:165-186`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:165) [`mint.ts:76-98`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:76) |
| `user_connections.user_id` | Exists for a proposed per-user credential mode, but current lease creation does not use it. [`0003_credentials.sql:15-23`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:15) [`leases.ts:70-84`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:70) |
| `ownerName` crypto argument | Despite its name, callers pass the integration name, not a human owner. [`root-crypto.ts:43-77`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/root-crypto.ts:43) [`registry.ts:323`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/registry.ts:323) [`mint.ts:141-145`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:141) |

There is no `granted_by` or `approved_by` column. The closest fields are `integrations.created_by` and `credential_requests.resolved_by`; neither provides complete per-human mint/use attribution.

## Single-operator assumptions

- One configured `OPERATOR_API_KEY` authenticates every human as the literal principal `"operator"`. [`principals.ts:79-87`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/principals.ts:79)
- Mode B uses that same operator principal source rather than Teenybase users. [`build-blitzdev.mjs:492-511`](/Users/minjunes/blitz-core-microvm/packages/control-plane/scripts/build-blitzdev.mjs:492)
- The UI hard-codes one personal organization, one operator membership, and `admin` role. [`api-adapter.ts:58-83`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api-adapter.ts:58)
- Every workspace is synthesized as personal, owned/control-capable, and unshared. [`api-adapter.ts:96-113`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api-adapter.ts:96)
- The persistent identity record has only ID, Unix name, and harnesses. [`0001_initial.sql:3-7`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0001_initial.sql:3)
- A workspace has exactly one owner and no organization or grant relation. [`0001_initial.sql:15-33`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0001_initial.sql:15)
- Workspace list, surface access, and destruction all use direct owner equality. [`workspaces.ts:299-315`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:299) [`workspaces.ts:362-369`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:362)
- Workspace quota is counted per owning principal, not organization. [`workspaces.ts:225-244`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:225)
- Literal `"operator"` is a hard-coded superuser bypass in credential mint, lease, and request authorization. [`mint.ts:62-74`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:62) [`leases.ts:120-129`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:120) [`requests.ts:96-101`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:96)
- Managed workspace boxes inherit the sole workspace owner as their principal. [`workspaces.ts:451-456`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:451)
- Agent-triggered credential actions are consequently attributed to the workspace owner/box, not the human operating the session. [`mint.ts:210-236`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/mint.ts:210)
- Integration configuration is account-global and mutable by any authenticated principal, assuming all authenticated humans are the same operator. [`registry.ts:281-369`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/registry.ts:281)
- Volume creation/list/deletion and machine-type listing are global to any authenticated principal. [`volumes.ts:25-44`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/volumes.ts:25) [`app.ts:36-40`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/app.ts:36)
- Supplying a volume ID during workspace creation performs no volume ownership check. [`workspaces.ts:267-269`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:267)
- Human identity and role are discarded at the control-plane-to-host proxy boundary. [`microvm.ts:721-737`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/providers/microvm.ts:721)
- Guest actor and terminal surfaces rely on network placement and Origin checks rather than per-human authentication. [`server.ts:20-31`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/server.ts:20) [`main.go:74-117`](/Users/minjunes/blitz-core-microvm/packages/box/gateway/main.go:74)
- Missing Origin is accepted by both actor and gateway checks. [`config.ts:22-29`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/config.ts:22) [`main.go:295-299`](/Users/minjunes/blitz-core-microvm/packages/box/gateway/main.go:295)
- All collaborators would share one `blitz` Unix account, home, state directory, workspace, tmux namespace, and credential files. [`blitz-init-state:41-49`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/usr/local/libexec/blitz-init-state:41) [`ttyd/run:3-6`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/etc/s6-overlay/s6-rc.d/ttyd/run:3)
- A workspace supports one installed SSH authorized key, not per-member SSH identities. [`blitz-init-state:69-75`](/Users/minjunes/blitz-core-microvm/packages/box/rootfs/usr/local/libexec/blitz-init-state:69)
- Agent sessions contain no creator, participant, organization, or ACL fields. [`journal.ts:4-48`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/journal.ts:4)
- ACP exposes no session-list operation; shared-session discovery depends on client-held IDs. [`server.ts:54-70`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/server.ts:54)
- Knowing a session ID and CWD is sufficient to load it; prompt and cancel have no caller authorization. [`actor.ts:262-274`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:262)
- Permission prompts are shared among subscribers, with the first response winning and no human attribution. [`actor.ts:189-241`](/Users/minjunes/blitz-core-microvm/packages/box/actor/src/actor.ts:189)
- The UI’s binary `canControl` conflates ordinary use, terminal write access, and destructive workspace administration. [`workspace-store.ts:73-83`](/Users/minjunes/blitz-core-microvm/packages/ui/src/workspace-store.ts:73) [`CockpitRail.tsx:262-273`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CockpitRail.tsx:262)
- `canObserve` reflects workspace readiness rather than a viewer grant, and the adapter ignores it. [`workspaces.ts:68-89`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/workspaces.ts:68) [`api-adapter.ts:96-113`](/Users/minjunes/blitz-core-microvm/packages/ui/src/api-adapter.ts:96)
- The observer URL is UI scaffolding without a corresponding parsed application route. [`CockpitRail.tsx:226-230`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CockpitRail.tsx:226) [`sessions-page-state.ts:7-25`](/Users/minjunes/blitz-core-microvm/packages/ui/src/sessions-page-state.ts:7)
- Terminal read-only support is an optional client URL argument, while the current application always opens a writable terminal. [`TtydTerminal.tsx:257-282`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/TtydTerminal.tsx:257) [`CloudApp.tsx:1373-1395`](/Users/minjunes/blitz-core-microvm/packages/ui/src/components/CloudApp.tsx:1373)
- UI layout, titles, active workspace, file state, and chat-session IDs are scoped to the synthetic personal/operator localStorage namespace rather than a server-side user. [`storage.ts:62-107`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:62) [`storage.ts:200-340`](/Users/minjunes/blitz-core-microvm/packages/ui/src/storage.ts:200)
- Credential leases currently write `user_id = NULL`, and credential events have no acting-principal column. [`leases.ts:70-98`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/leases.ts:70) [`0003_credentials.sql:42-48`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:42)
- Credential requests record their resolver but not the human or box that initiated the request. [`0003_credentials.sql:50-59`](/Users/minjunes/blitz-core-microvm/packages/control-plane/migrations/0003_credentials.sql:50) [`requests.ts:54-81`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/requests.ts:54)
- Proxy leases are bearer capabilities with no re-check of current user, workspace grant, or box identity. [`proxy.ts:44-83`](/Users/minjunes/blitz-core-microvm/packages/control-plane/core/credentials/proxy.ts:44)
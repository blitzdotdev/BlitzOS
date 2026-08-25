# Organization presence fixtures

The browser reports what a member is looking at with
`PUT /presence/connections/:clientId` and reads the organization's redacted
snapshot from `GET /presence`. Both payloads are shared TypeScript types
(`packages/schema/src/presence.ts`, mirrored in `control-plane/core/wire.ts`),
but the two sides are built and tested separately, so the behaviour — which
requests the control plane accepts, what a snapshot looks like authorized and
redacted — is pinned here rather than in either side's own tests.

## `requests/`

One PUT body each, with the status the control plane answers.

- `producer`, when present, is the browser-side input (`tabs`, the ids of the
  visible tabs, the focused tab id) that `presenceViewForTabs` must turn into
  exactly `body.workspaceId`/`surfaces`/`focusedSurface`. Fixtures without a
  `producer` are server-side rejections the browser never emits.
- `body` is sent as-is after placeholder substitution: `{{workspace}}` is a
  workspace the caller can open, `{{other-workspace}}` a second one, and
  `{{session}}` an active shared session of `{{workspace}}`.
- `status` is the expected response status.

Labels carry a basename only; anything with a path separator or a control
character is refused, so a file's location never reaches the presence table.

## `snapshots/`

One `GET /presence` response each with `accepts`: whether the browser decoder
takes it. The two `accepts: true` scenario fixtures are also produced by the
control plane from a fixed scenario — owner focused on a shared terminal in
their own workspace, a same-org member on the organization page — and compared
after normalizing the dynamic values (`{{workspace}}`, `{{workspace-name}}`,
`{{session}}`, timestamps to `0`):

- `authorized.json` is what the owner sees of themselves.
- `redacted.json` is what the member without access sees: the owner is
  **in another workspace**, with no workspace id, name, session, or title.

Conformance: control plane `packages/control-plane/test/presence-conformance.test.ts`
(request consumer, snapshot producer); browser
`packages/webapp/test/presence-conformance.test.ts` (request producer,
snapshot consumer).

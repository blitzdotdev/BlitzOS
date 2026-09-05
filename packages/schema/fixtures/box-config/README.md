# Box-config fixtures

The VM host polls `GET /workspaces/self/box-config` (box-authenticated) and
reports update attempts to `POST /workspaces/self/box-update-result`. Both
payloads cross TS ↔ bash/python: the control-plane Worker is the box-config
producer and the update-result consumer; the host-side updater
(`blitz-box-update`, emitted inline by `core/bootstrap.ts`) is the box-config
consumer and the update-result producer. This corpus pins both directions.

`config-*.json` fixtures pair a candidate box-config response body (`response`)
with whether the host consumer must accept it (`accepts`). The accept rule:
a JSON object whose `boxImageRef` is one image-reference token
(`[A-Za-z0-9][A-Za-z0-9._/:@-]*` — a registry ref or the R2 tarball https
URL), whose `controlPlaneOrigin` is exactly an http(s) origin (scheme, host,
optional port, nothing after — the host writes it verbatim into
`/var/lib/blitz/origin`, which the box gateway compares against the browser
Origin header), and whose `updateRequested` is a boolean. Unknown extra keys
are tolerated on both sides for forward compatibility. That includes the
additive `payload: {version, manifestUrl} | null` field consumed by the
in-box payload updater: the old host image updater deliberately ignores it,
as pinned by `config-valid-payload.json`. The optional
`features: {lodySessions: boolean}` member is also consumed in-box. The updater
writes every known flag to `/opt/blitz/payload/state/features`. It records a
completed reader restart in `features.applied`. An absent `features` member
means all flags are false, preserving compatibility with older control planes.
`config-valid-features-on.json`, `config-valid-features-off.json`, and
`config-valid-minimal.json` pin those three cases. An unversioned or versioned
box-image manifest URL is accepted by the parser; the updater fetches its
manifest, verifies and concatenates its parts, loads the image under the
manifest's `imageTag`, and replaces the container by that tag. Other
URL-shaped refs report `unsupported` rather than being passed to `docker
pull`, so the origin refresh still happens. On a rejected envelope the host
changes nothing and keeps polling.

The in-box updater independently parses the additive `payload` and `features`
members.
`payloadAccepts` records that consumer's expectation and defaults to `true`;
this lets malformed payload pins remain valid fixtures for the legacy host,
which deliberately ignores that forward-compatible member.

`result-*.json` fixtures pair a candidate update-result request body
(`request`) with whether the control-plane consumer must accept it
(`accepts`): `ref` is one image-reference token and `outcome` is one of
`updated`, `up-to-date`, `rolled-back`, `pull-failed`, `fetch-failed`,
`start-failed`, `unsupported` (`BOX_UPDATE_OUTCOMES` in
`packages/schema/src/box-config.ts`).
Extra keys are tolerated on purpose: hosts only update by shipping new
images, so an older control plane must keep accepting a newer host's report
or the workspace's update flag would stay set forever.

Conformance: the control-plane side is
`packages/control-plane/test/box-config-conformance.test.ts`; the host side
(the parser and producer embedded in the emitted updater, run with real
`python3`) is `packages/control-plane/test/box-update-conformance.test.mjs`;
the real in-box updater parser runs the same config fixtures in
`packages/box/guest-tests/test/box-payload-conformance.test.ts`.

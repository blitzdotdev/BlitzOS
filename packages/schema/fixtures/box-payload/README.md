# Box-payload v1 fixtures

This corpus is the source of truth for the `box-payload v1` boundary shared by
the control-plane publisher/result consumer and the in-box `blitz-payload`
updater. Manifest bodies live directly under `valid/` and `invalid/`;
updater report bodies live under `payload-result/valid/` and
`payload-result/invalid/`. Every file is JSON. `cases.json` maps each invalid
fixture to the field name its rejection message must contain.

A manifest contains a safe payload version token, a positive millisecond
creation time and updater protocol version, one or more `rootfs/` files, the
payload archive, an optional daemon archive, and a restart dependency map.
The archive also contains the reserved root entry `payload-version`, whose
single line equals `manifest.version`. It lives outside `rootfs/`, so it is not
listed in `manifest.files` and does not relax that list's path rules. Daemon
archives likewise reserve `daemon-version` and `daemon-protocol-version` at
their root.
Digests are exactly 64 lowercase hexadecimal characters; modes are exactly
four octal characters; artifact URLs are absolute HTTP(S) URLs. File and
restart-dependency paths are canonical relative paths below `rootfs/` with no
`.` or `..` segment. Restart keys come from
`BOX_PAYLOAD_RESTART_SERVICES`, which the producer conformance test pins to the
actual base-image s6 service directory.

`valid/min-updater-unsupported.json` is deliberately valid. Parsing establishes
contract validity; updater capability is a later decision. A v1 updater must
accept that manifest, apply nothing, and report `unsupported` because its
`minUpdater` is 2. This corpus does not use an `unsupported/` directory because
the neighboring manifest corpora classify parser input only as valid or
invalid.

Unknown object members are tolerated for forward compatibility. The
payload-result outcomes are `booted`, `applied`, `deferred`, `rolled-back`,
`unsupported`, `fetch-failed`, `verify-failed`, `start-failed`, and
`up-to-date`. Its `version` and `daemonVersion` identify the unit currently
running; a `deferred` report therefore keeps the old identity and names the
fully staged pin in `detail`, as failed attempts do.

Producer/control-plane conformance is
`packages/control-plane/test/box-payload-conformance.test.ts`. Consumer
conformance arrives with the updater in
`packages/box/guest-tests/test/box-payload-conformance.test.ts`.

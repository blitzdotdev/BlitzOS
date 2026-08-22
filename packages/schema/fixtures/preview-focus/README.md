# Preview-focus fixtures

The `blitz teenyapp open` CLI (documented verb; `blitz preview open` remains a
silent alias) writes a single "focus" marker to
`/var/lib/blitz/preview-focus.json`; the Go gateway reads it at
`GET /preview-focus` and returns `{ "focus": <marker> }` or `{ "focus": null }`.

Each fixture pairs the marker file content (`input`) with the canonical gateway
response (`expected`). `input: null` represents an absent marker file. The
gateway rejects a marker that is not version 1, whose port is out of the
1024-65535 range or reserved by the box (see `../preview-ports/reserved.json`),
or whose path is not rooted, is longer than `maxPathLength`, or contains a `..`
segment; a rejected marker yields `{ "focus": null }`.

The marker is written by the in-box agent's own uid, so the CLI's validation is
convenience rather than a boundary and every reader repeats it. The traversal
rule is the load-bearing one: the browser normalizes
`/preview/<port>/app/../../workspace/` before the request leaves the tab, so a
`..` any reader passes on walks the iframe out of the `/preview/<port>/` prefix
and onto another box surface.

Conformance: the Go gateway reader is tested in
`packages/box/gateway/main_test.go`; the CLI producer is tested in
`packages/box/actor/test/preview-focus-conformance.test.ts`; the browser
consumer (`fetchWorkspacePreviewFocus` / `parsePreviewFocus` in
`packages/webapp/src/preview.ts`) is tested in
`packages/webapp/test/preview-focus.test.ts`.

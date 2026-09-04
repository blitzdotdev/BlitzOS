# Preview-focus fixtures

The `blitz browser open <port|file|https-url>` CLI (`blitz teenyapp open` and
`blitz preview open` remain aliases for the port form) writes a single "focus"
marker to `/var/lib/blitz/preview-focus.json`; the Go gateway reads it at
`GET /preview-focus` and returns `{ "focus": <marker> }` or `{ "focus": null }`.

A version-2 marker names its `kind`:

- `port`: `port` in 1024-65535 and not reserved by the box (see
  `../preview-ports/reserved.json`), `path` rooted, at most `maxPathLength`
  characters and free of `..` segments.
- `file`: `file` an absolute path under `/workspace`, the same length and
  traversal rules, no line break. The browser serves it from the gateway's
  `/workspace/` surface.
- `url`: `url` an `https` URL with a host, at most `maxPathLength` characters.
  Whether the host is embedded is the browser's decision, not the marker's.

A version-1 marker (`port`, `path`, no `kind`) is what boxes in the field
still carry; every reader keeps accepting it as a port.

Each fixture pairs the marker file content (`input`) with the canonical gateway
response (`expected`). `input: null` represents an absent marker file. A
rejected marker yields `{ "focus": null }`.

The marker is written by the in-box agent's own uid, so the CLI's validation is
convenience rather than a boundary and every reader repeats it. The traversal
rule is the load-bearing one: the browser normalizes
`/preview/<port>/app/../../workspace/` before the request leaves the tab, so a
`..` any reader passes on walks the iframe out of the `/preview/<port>/` prefix
and onto another box surface.

Conformance: the Go gateway reader is tested in
`packages/box/gateway/main_test.go`; the CLI producer is tested in
`packages/box/guest-tests/test/preview-focus-conformance.test.ts`; the browser
consumer (`fetchWorkspacePreviewFocus` / `parsePreviewFocus` in
`packages/webapp/src/preview.ts`) is tested in
`packages/webapp/test/preview-focus.test.ts`.

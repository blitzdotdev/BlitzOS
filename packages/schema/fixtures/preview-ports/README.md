# Preview port fixtures

`reserved.json` is the single shared definition of which TCP ports a preview may
use. Four readers decide this independently and must never disagree:

- `packages/schema/src/preview.ts` — `RESERVED_PREVIEW_PORTS` / `isPreviewPort`,
  which the browser (`packages/webapp/src/preview.ts`) re-exports.
- `packages/box/gateway/main.go` — `excludedPorts`, used both to hide box
  services from the discovered-port list and to reject a focus marker.
- `packages/box/rootfs/usr/local/bin/blitz` — `RESERVED_PORTS` in the
  `blitz preview open` producer.
- `packages/control-plane/core/agent-rules.ts` — the rule doc tells the in-box
  agent the same range, via `packages/box/rootfs/opt/blitz/skel/agent-rules.md`.

The Go and shell runtimes cannot import the TypeScript constant, so they mirror
it and each test suite pins its own mirror to this file:
`packages/box/gateway/main_test.go`,
`packages/box/actor/test/preview-focus-conformance.test.ts`, and
`packages/webapp/test/preview-focus.test.ts`.

`maxPathLength` is the deep-link `--path` bound. The control plane rejects a
longer `tabs.tabs[].path` outright (`core/webapp-state.ts`), so the producer
caps it and the browser drops it before a write rather than losing the whole
document to a 400.

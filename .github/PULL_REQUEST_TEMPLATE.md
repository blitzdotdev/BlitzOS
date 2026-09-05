## What and why

<!-- What changes, and what problem it solves. Link the issue if one exists. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint:gate` passes
- [ ] `npm test` passes
- [ ] `lint-baseline.json` was not raised (and was lowered if this change removes findings)
- [ ] Any new payload crossing a runtime boundary has fixtures under `packages/schema/fixtures/` and conformance tests on both sides
- [ ] Go changes: `go test ./...` passes in the affected module(s) (`packages/broker`, `packages/box/gateway`)
- [ ] Docs updated where behavior or setup changed (`docs/`, package READMEs)

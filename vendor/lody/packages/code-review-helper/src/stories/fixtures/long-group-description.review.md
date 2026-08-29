---
review_version: 1
merge_base: a11b22c3d4e5f60718293a4b5c6d7e8f90123456
current_commit: e55f66a7b8091a2c3d4e5f60718293a4b5c6d7e8
base_ref: main
line_budget: 1500
---

# Long group description story

This story exercises a very long group description to verify that the sidebar
navigation renders it compactly, supports Markdown headings, and scrolls once
the content exceeds the maximum height.

## Group: Adapter public surface refactor with an intentionally verbose explanation

Changed lines: 20
Commits: `a11b22c`, `c33d44e`

## Why this group matters

The adaptor package is the boundary between the runtime and every consumer of
the library. Any change here ripples through the CLI, the Electron app, the
mobile wrapper, and downstream extensions. We need to be especially careful
about exported names, type signatures, and the order in which factories are
initialized.

## What changed

- Removed the legacy alias map that was kept for backward compatibility during
the v0.x migration window.
- Replaced the string-keyed `ADAPTER_ALIASES` record with a typed
`ADAPTER_FACTORIES` object so TypeScript can narrow adapter kinds at compile
time.
- Centralized label casing in `toAdaptorLabel` so the UI and CLI no longer
format display names differently.
- Added package exports and the first CLI entry points so the review helper can
be invoked from CI without reaching into package internals.

## Risks to watch

- Any code that imported `createLegacyAdapter` or `detectLegacyRuntime` will now
fail to compile. Those helpers were already documented as deprecated, but grep
the repo to confirm no lingering references remain.
- The new `AdapterKind` type is derived from the factory record keys. If a
factory is renamed, the public type changes too, which is a breaking API
change.
- `toAdaptorLabel` now upper-cases the first letter of each word. Make sure
this matches the design system expectations; previously some labels were left
lower-cased.

### Cross-cutting concerns

Because the adaptor package is imported by both Node and browser bundles, the
factory table must stay serializable and free of Node-only imports. The
introduced `satisfies Record<string, AdapterFactory>` constraint should help,
but double-check that no platform-specific globals leak in during tree-shaking.

`changes://packages/adaptors/src/index.ts`

- `new://L1-L10`: verify the factory table only exports runtime-safe creators.

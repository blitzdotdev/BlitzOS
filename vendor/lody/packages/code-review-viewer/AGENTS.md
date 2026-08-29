# lody-code-review-viewer

Workspace build package that produces the prebuilt single-file code-review viewer
used by the `lody` CLI without bundling ~8 MB into the CLI.

## Invariants

- This package is a private workspace build dependency and contains exactly one
  shipped asset: `standalone.html` (the inlined viewer, generated — gitignored).
- `standalone.html` is produced by `@lody/code-review-helper`'s `build:standalone`
  and copied here verbatim by `scripts/build-viewer.mjs`; never hand-edit it.
- A published viewer version MUST stay in lockstep with the matching `lody`
  release. The CLI embeds this exact version + the sha256 of `standalone.html`
  (the `./manifest` export) for its local viewer asset.
- `LODY_RELEASE_VERSION` may override only the generated manifest version for a
  downstream immutable package build. It must never rewrite this package's tracked
  metadata; without the override, `package.json` is authoritative.
- `./manifest` resolves to the generated `dist/manifest.generated.ts` at runtime but
  to the stable `src/manifest.d.ts` for typecheck, so typecheck never needs the
  generated file.

## Files

- `scripts/build-viewer.mjs` — copies the helper's `standalone.html` here, computes
  its sha256, and writes `dist/manifest.generated.ts` (version + sha256 + filename).
- `src/manifest.d.ts` — stable types for the `./manifest` export.
- `package.json` `build` = build the helper's standalone viewer, then run the script.

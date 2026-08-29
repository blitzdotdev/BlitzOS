# file-icons

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

## Invariants

- `mappings.ts` resolves icon names by direct SVG basename through
  `new URL("./files/${name}.svg", import.meta.url)` and
  `new URL("./folders/${name}.svg", import.meta.url)`.
- Every icon name used by `compoundExtensionMap`, `extensionMap`, `fileNameMap`,
  `folderNameMap`, `defaultFileIcon`, or `defaultFolderIcon` must have a matching
  local SVG file. The resolver does not understand upstream icon-definition aliases.
- When copying from `vscode-symbols`, materialize aliases as local SVG files. Example:
  upstream `go-mod` points at `go-pink.svg`, so this package keeps a `go-mod.svg`
  alias file.
- `packages/code-review-helper/src/file-icons` is a standalone copy of the file
  icon subset. Keep file SVG additions in sync there when its mappings reference
  the same icon names.

## Verification

Run a mapping-vs-assets check after changing mappings or icon files. It should
report zero missing file icons and zero missing folder icons for this package.

# Pristine upstream sources, for the seam-patch pin

The `.tsx.txt` files here are byte-for-byte copies of vendored Lody files as
UPSTREAM wrote them, before any BlitzOS seam patch. They are evidence, not code:
`packages/webapp/test/lody-surface-tabs.test.tsx` reads them to prove that every
line the vendored tree lost is one `vendor/lody/BLITZ-PATCHES.md` declares, and
nothing else.

| Baseline | Vendored file it is the baseline for |
|---|---|
| `session-tab-bar.tsx.txt` | `vendor/lody/packages/components/src/components/sessions/session-tab-bar.tsx` |
| `session-detail.tsx.txt` | `vendor/lody/packages/components/src/components/sessions/session-detail.tsx` |
| `session-side-panel-tab-bar.tsx.txt` | `vendor/lody/packages/components/src/components/sessions/session-side-panel-tab-bar.tsx` (seam patch 19) |
| `session-browser-panel.tsx.txt` | `vendor/lody/packages/components/src/components/sessions/session-browser-panel.tsx` (seam patch 20) |
| `managed-preview-surface.tsx.txt` | `vendor/lody/packages/components/src/components/sessions/managed-preview-surface.tsx` (seam patch 20) |
| `mobile-session-tab-sheet.tsx.txt` | `vendor/lody/packages/components/src/components/mobile/mobile-session-tab-sheet.tsx` |
| `mobile-home-screen.tsx.txt` | `vendor/lody/packages/components/src/components/mobile/mobile-home-screen.tsx` |

The two mobile files arrived with seam patch 16, which is the first patch to
edit a mobile-only file; the three side-panel files with seam patches 19 and
20. `components/chat/chat-landing.tsx` is patched by seam patches 7, 15 and 16
and has NO baseline here: adding one means declaring seam patch 7's removals in
that file as well, which is a job for whoever needs it.

**Taken from `f34748945028ffc04316861ad25edc24535c0235`**, the commit
`vendor/lody/UPSTREAM.md` pins. The test reads that pin out of `UPSTREAM.md` and
fails when this file no longer names it, so a merge cannot move the pin and
leave these behind.

## Why a committed copy, and not `git show`

The first version of the pin test asked git for the pristine source:

```sh
git show <pin>:packages/components/src/components/sessions/session-tab-bar.tsx
```

That works in a full clone of this repository and fails in CI. The subtree
squash puts the upstream tree at its OWN root, with no `vendor/lody/` prefix, so
the path resolves only where the upstream commit object happens to be present
and reachable — and a shallow or partial checkout may not carry it at all. A
check on the vendored tree must not depend on the shape of the clone, so the
evidence is checked in beside the test that reads it.

## The `.txt` extension is not decoration

`packages/webapp/tsconfig.json` includes `test/**/*.tsx`, and these files are
written against Lody's compiler options and their pnpm workspace's `@/` paths.
As `.tsx` they would be typechecked, and would fail. As `.txt` they are what
they are: data.

## Refreshing them at an upstream merge

`docs/LODY-MERGE.md` §4 re-anchors every line number in `BLITZ-PATCHES.md` after
a subtree pull. These baselines and the anchor tables in
`lody-surface-tabs.test.tsx` are re-anchored in the same change, from a clone
that has the new upstream commit:

```sh
PIN=<the new upstream sha>
for f in sessions/session-tab-bar sessions/session-detail \
         sessions/session-side-panel-tab-bar sessions/session-browser-panel \
         sessions/managed-preview-surface \
         mobile/mobile-session-tab-sheet mobile/mobile-home-screen; do
  git show "$PIN:packages/components/src/components/$f.tsx" \
    > packages/webapp/test/upstream-baseline/"$(basename "$f").tsx.txt"
done
```

Then update the sha named above, re-run
`npx vitest run test/lody-surface-tabs.test.tsx`, and move each anchor's line
number to wherever the merge put it. The test names every anchor by line number
AND by text, so a stale number fails on the text rather than passing quietly.

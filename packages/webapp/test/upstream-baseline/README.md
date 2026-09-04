# Pristine upstream sources, for the seam-patch pin

The `.tsx.txt` files here are byte-for-byte copies of vendored Lody files as
UPSTREAM wrote them, before any BlitzOS seam patch. They are evidence, not code:
`packages/webapp/test/lody-seam-pin.test.ts` reads them to prove that every
line the vendored tree lost is one `vendor/lody/BLITZ-PATCHES.md` declares, and
nothing else.

| Baseline | Vendored file it is the baseline for |
|---|---|
| `session-tab-bar.tsx.txt` | `vendor/lody/packages/components/src/components/sessions/session-tab-bar.tsx` |
| `session-detail.tsx.txt` | `vendor/lody/packages/components/src/components/sessions/session-detail.tsx` |
| `mobile-session-tab-sheet.tsx.txt` | `vendor/lody/packages/components/src/components/mobile/mobile-session-tab-sheet.tsx` |
| `mobile-home-screen.tsx.txt` | `vendor/lody/packages/components/src/components/mobile/mobile-home-screen.tsx` |
| `message-processor.ts.txt` | `vendor/lody/apps/cli/src/lib/message-processor.ts` |
| `agent-client.ts.txt` | `vendor/lody/apps/cli/src/agent/agent-client.ts` |
| `lody-mcp-http-server.ts.txt` | `vendor/lody/apps/cli/src/mcp/lody-mcp-http-server.ts` |

The two mobile files arrived with seam patch 16, which is the first patch to edit
a mobile-only file. The daemon message processor arrived with source seam 19.
The agent and MCP server baselines cover seam 20's conditional fallback logs.
`components/chat/chat-landing.tsx` is patched by seam patches
7, 15 and 16 and has NO baseline here: adding one means declaring seam patch 7's
removals in that file as well, which is a job for whoever needs it.

**Taken from `f4b1ba259eb754cd954da776d8e7384a8c30f1c9`**, the commit
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

Follow the single procedure in `docs/LODY-MERGE.md`; it owns the baseline-copy,
provenance, re-anchoring, and seam-test commands.

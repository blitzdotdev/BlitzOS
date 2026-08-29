# BlitzOS divergences from upstream Lody

Every deliberate edit inside `vendor/lody` is listed here, with the file, the
upstream anchor it depends on, and the reason. An upstream-merge agent treats
this file as its conflict manual (`plans/LODY-SESSIONS.md` §5.3, §5.4).

**The rule: nothing in `vendor/lody` is edited except at a declared seam.**
Everything BlitzOS-specific lives in `packages/webapp/src/lody/`. If a vendored
component cannot render without a change, stub around it from there or record a
blocker — do not patch the vendor tree.

## Seam patches

_None. As of the phase-0 spike (2026-08-29) the vendor tree is byte-identical to
upstream `966623d0`, apart from this file and `UPSTREAM.md`, which upstream does
not carry._

Verify with:

```sh
git diff --stat <subtree-import-commit> -- vendor/lody \
  ':!vendor/lody/UPSTREAM.md' ':!vendor/lody/BLITZ-PATCHES.md'
```

## Planned seams (not yet applied)

Declared ahead of time so a merge agent recognises them when they appear.

| File | Upstream anchor | Reason | Phase |
|---|---|---|---|
| `packages/components/src/providers/create-workspace-runtime.ts` | `syncMode: 'cloud'` construction | Build the runtime with `loro-repo`'s `transport/websocket` against our box gateway instead of the hosted Loro Streams service, which is not in the public tree (§4). | 2 |
| `packages/components/src/providers/workspace-machine-rpc-facade.ts` | the transport-selection switch | Add a "box websocket" RPC plane beside the existing ones (§4). | 2 |
| `packages/components/src/lib/electron-ipc-client.ts` | `getIpcServices()` | No change expected — it already returns `null` in a browser. Listed so nobody "fixes" it. | — |

## Things upstream does not support that we work around OUTSIDE the vendor tree

Recorded here because each is a candidate seam if the workaround stops holding.

- **`LoroSidebar` has no header/footer suppression props.** §0.3 wants its body
  mounted in `div.shell-newbar` + `div.shell-list` with its own header and
  footer suppressed "via props, not source edits", and no such prop exists at
  `966623d0` (`afterSessionListContent` is the only slot). Phase 4 has to add
  the props upstream, contribute them, or accept a seam patch.
- **`useAuthenticatedConvex` throws without a provider**, and the composer's
  mention sources call it even with `cloudApi: null`. Supplied from
  `packages/webapp/src/lody/platform.tsx` with the settled signed-out value
  their own Storybook preview uses.
- **`acp-extension-dsh` is an empty submodule.** Aliased to a local stub; see
  `UPSTREAM.md`.
- **`packages/components/vite-renderer-bundle-aliases.ts` cannot be imported.**
  It resolves `./node_modules/beautiful-mermaid/...` next to itself at module
  load, which only exists under pnpm's nested layout. The two rules we need
  (`shiki/bundle/full` → `shiki`, and the loro WASM URL rewrite) are ported into
  `packages/webapp/src/lody/vendor-bridge.ts` instead.
- **Their Tailwind entry cannot be imported into a cascade layer.**
  `@import "…/tailwind/index.css" layer(lody)` fails with "`@utility` cannot be
  nested", so the compiled output is wrapped instead. See
  `plans/evidence/lody-phase0.md`.

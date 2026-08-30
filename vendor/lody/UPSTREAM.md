# Lody upstream pin

This directory is a squashed `git subtree` of the public Lody tree. Nothing in
it is edited by hand except at a declared seam: see `BLITZ-PATCHES.md` for the
list, and `plans/LODY-SESSIONS.md` §5 for the rules. The merge procedure is
`docs/LODY-MERGE.md`.

| Field | Value |
|---|---|
| Upstream | https://github.com/LodyAI/Lody (Apache-2.0) |
| Pinned commit | `f34748945028ffc04316861ad25edc24535c0235` |
| Commit date | 2026-08-30 (`fix(electron): detect system language before onboarding (#175)`) |
| Vendored on | 2026-08-30 (first merge; initial import 2026-08-29 at `966623d0`) |
| npm `lody` (daemon) | 0.88.1 |
| Subtree commit here | `Squashed 'vendor/lody/' changes from 966623d0..f3474894` |

The npm pin did NOT move with this merge, and that is the documented answer
rather than an omission: npm's latest is still `0.88.1`, so there is no release
that corresponds to the newer subtree. `docs/LODY-MERGE.md` §3 states the rule —
a renderer merge with an unchanged daemon is a supported state; a guessed daemon
version is not.

The renderer and the daemon must move together. `apps/cli/package.json` in this
subtree says 0.76.0 while npm publishes 0.88.1 — the public tree lags releases,
which is the known skew recorded in `plans/LODY-SESSIONS.md` §11. We build the
renderer from this subtree and install the daemon from npm, so both numbers are
pinned here and both are re-checked at every merge.

## Refreshing the pin

```sh
git subtree pull --prefix vendor/lody https://github.com/LodyAI/Lody <ref> --squash
```

Then follow `plans/LODY-SESSIONS.md` §5.4: re-resolve the dependency catalog
into `packages/webapp/package.json`, re-check the patch list in
`scripts/apply-vendor-patches.mjs` against this subtree's `patches/` directory
and `pnpm-workspace.yaml`'s `patchedDependencies` (that script applies the
upstream patch files in place — there is no second copy to update), bump the
npm `lody` pin, and run the three gates plus the phase-0 spike tests.

## What is NOT here

The six ACP extension packages under `packages/` are git submodules upstream, so
the subtree carries their gitlinks and no sources:

```
packages/acp-extension-claude  packages/acp-extension-codex  packages/acp-extension-core
packages/acp-extension-dsh     packages/acp-extension-grok   packages/acp-extension-kimi
```

We do not build `apps/cli` from source, so this costs nothing on the daemon
side — the npm `lody` package bundles the adapters prebuilt. It costs one thing
on the renderer side: `@lody/shared` re-exports four DeepSeek selector
constants from `acp-extension-dsh/capabilities`. That specifier is aliased to
`packages/webapp/src/lody/stubs/acp-extension-dsh-capabilities.ts`, which
exports them empty (agents v1 is claude and codex only, §0.6).
`acp-extension-core` is installed from npm instead.

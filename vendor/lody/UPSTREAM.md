# Lody upstream pins

The upstream `AGENTS.md`, `CLAUDE.md`, `DEV.md`, `CONTRIBUTING.md`,
`README*.md`, `SECURITY.md`, and `THIRD_PARTY_NOTICES.md` files in this
directory describe Lody's own repository, not BlitzOS. BlitzOS rules are in the
root `CLAUDE.md`, the only merge procedure is `docs/LODY-MERGE.md`, and the seam
and conflict manual is `BLITZ-PATCHES.md`.

`vendor/lody` is a squashed `git subtree` of the public Lody tree. No imported
upstream file is edited by hand except at a seam declared in
`BLITZ-PATCHES.md`.

| Field | Value |
|---|---|
| Upstream | https://github.com/LodyAI/Lody (Apache-2.0) |
| Pinned commit | `f4b1ba259eb754cd954da776d8e7384a8c30f1c9` |
| Commit date | 2026-09-04 (`fix(ci): harden Electron signing credentials [risk:high] (#358)`) |
| Vendored on | 2026-09-03 (second merge; initial import 2026-08-29 at `966623d0`) |
| Subtree squash commit | `8a75ee46516c8350300841774f2223757ea9c455` |

The pinned upstream commit is the renderer and daemon source identity. The
subtree squash commit is its repository-history mirror and must contain the
matching `git-subtree-split` trailer. They are not independently selectable
pins.

## Installed daemon

The image builds `vendor/lody/apps/cli` from the pinned tree, overlays
the five reviewed CLI adapters below at their gitlink SHAs, installs the packed
artifact, and stamps it with the upstream and subtree commits. Follow
`docs/LODY-MERGE.md` for the current upstream procedure. There is no independent
npm daemon pin or compiled-bundle rewrite step.

## Adapter gitlink pins

The subtree contains six gitlinks. The CLI workspace builds the first five and
explicitly excludes Kimi in `pnpm-workspace.yaml`.

| Adapter | Gitlink commit | Snapshot filter | Build disposition |
|---|---|---|---|
| `acp-extension-core` | `23c792b910a903b74601e346473827106f991715` | exclude `dist/**`, `node_modules/**` | `vendor/lody-adapters/core/`; overlay for builds |
| `acp-extension-claude` | `d395b3dc69832c6566eb0da84a08486d16ba1e69` | exclude `dist/**`, `node_modules/**` | `vendor/lody-adapters/claude/`; overlay for builds |
| `acp-extension-codex` | `0887c5620b7b1773fa401e65a1009f10f80715a7` | exclude `dist/**`, `node_modules/**` | `vendor/lody-adapters/codex/`; overlay for builds |
| `acp-extension-dsh` | `c584a16e4f4ce982c762b2c11f0c344f1643fd6d` | exclude `dist/**`, `node_modules/**` | `vendor/lody-adapters/dsh/`; overlay for builds |
| `acp-extension-grok` | `77a994f4e0a5acec8c52020c0a8e01b0e90aaef9` | exclude `dist/**`, `node_modules/**` | `vendor/lody-adapters/grok/`; overlay for builds |
| `acp-extension-kimi` | `aab809cca845e4b1d0a0db243d336ab5f128b177` | not materialized | preserve as a gitlink; do not materialize for the CLI build |

`npm run lody:adapters:sync` replaces those five reviewed trees from the exact
public commits. Stage its output before checking it. The network-free check
rejects gitlink, URL, stamp, checkout, Kimi, or workspace-exclusion drift.
Pass `--fetch` to authenticate the staged bytes against all five upstream
commits.

## Updating these pins

Use `docs/LODY-MERGE.md`. Do not copy a subtree command, adapter-sync sequence,
or daemon-selection rule into this pin record.

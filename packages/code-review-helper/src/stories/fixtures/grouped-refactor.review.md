---
review_version: 1
merge_base: 1111111111111111111111111111111111111111
current_commit: 2222222222222222222222222222222222222222
base_ref: origin/main
line_budget: 1500
pr_number: 2401
pr_url: https://github.com/loro-dev/lody/pull/2401
pr_title: Refactor adaptor surface and add code-review-helper package
---

# Refactor adaptor surface and add code-review-helper package

This change tightens the public adaptor surface and stands up the new `code-review-helper` package end to end.

- **Adaptor API** is narrowed to the supported runtime factories, and the naming helper is centralized.
- **Renderer package** gains its parsing, React rendering, Node Git resolution, and CLI entrypoints.
- **Agent prompt** is bounded so generated reviews stay logic-first and within the line budget.

Review the adaptor surface first — it is the only change with public API impact.

## Review

- P0: Renaming the exported constant is a breaking change for downstream packages — confirm the migration note ships before merge.

  It spans two spots that must stay in sync:
  - the renamed export at `new://packages/adaptors/src/index.ts:L9`
  - the call site that still assumes the old name `new://packages/code-review-helper/src/cli.ts:L21`

  The removed aliases lived at `old://packages/adaptors/src/index.ts:L9-L16`.
- P1: The new package's CLI scripts should stay local-only in v1 — publishing them is out of scope. `new://packages/code-review-helper/package.json:L18-L22`
- P2: The label-casing helper name could read better, though behavior is fine — `packages/adaptors/src/naming.ts`.

## Group: Simplify adaptor surface

Changed lines: 128
Commits: `a11b22c`, `c33d44e`

The adaptor entry point now exports only the supported runtime surface.
Check the public naming before approving.

`changes://packages/adaptors/src/index.ts?old=L5-L19&new=L5-L17`

- `old://L9-L16`: legacy exports and aliases were removed from the public surface.

`changes://packages/adaptors/src/naming.ts`

- `new://L3`: this helper now centralizes label casing for UI and CLI output.

## Group: Wire renderer package entrypoints

Changed lines: 246
Commits: `e55f66a`

The new package exposes core parsing, React rendering, Node Git resolution, and the agent prompt.

`changes://packages/code-review-helper/package.json`

- `new://L8-L20`: review the public export names before downstream agents depend on them.

`changes://packages/code-review-helper/src/cli.ts`

- `new://L21`: validation is intentionally non-mutating and should not touch the reviewed repo.

## Group: Keep agent prompt bounded

Changed lines: 94
Commits: `f77a88b`

The prompt pushes agents toward logic-first groups, verified anchors, and range-filtered changes blocks.

`changes://packages/code-review-helper/prompts/review-helper-agent.md`

- `new://L24-L30`: this is the main line-budget rule agents need to follow.

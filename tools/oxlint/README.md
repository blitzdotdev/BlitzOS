# Repository linting

`anti-slop` is the vendored, repository-agnostic plugin for low-evidence TypeScript patterns.
`blitz-house` contains Blitz-specific conventions, including the control-plane fetch and logging boundaries. Both are loaded as Oxlint JavaScript plugins from `.oxlintrc.json`.

Run `npm run lint:gate` to lint package source files (tests are excluded) and compare all `anti-slop/*` and `blitz-house/*` findings with `lint-baseline.json`. A higher count fails; a lower count passes and prints a reminder to reduce the checked-in baseline. Update a baseline number only after removing findings and verifying the new lower count. The same run reports `max-lines` warnings for package source files over 700 lines; those warnings are intentionally not part of the error ratchet.

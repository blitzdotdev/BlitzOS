# Contributing

Thanks for working on BlitzOS. This page is the short version; the normative
house rules — lint policy, cross-runtime contracts, provider architecture —
live in [CLAUDE.md](CLAUDE.md). It is written for coding agents, but it is
the contributor guide for humans too. When this page and CLAUDE.md disagree,
CLAUDE.md wins.

## Setup

- Node.js 22.13 or newer (`engines` in the root `package.json`) and npm.
- Go 1.26+ for the Go components (broker, box gateway, microVM host).
- Docker for box-image work.

```sh
npm ci
```

## The three gates

Run all three before claiming success on any change:

```sh
npm run typecheck     # all workspaces, incl. the wire-drift tsconfig
npm run lint:gate     # per-rule ratchet vs lint-baseline.json (see below)
npm test              # control-plane, box actor, ui, guest node:test,
                      # house-rule tests, and Python fixture conformance
```

`npm test` needs a working `python3` on PATH (fixture conformance) and
compiles `better-sqlite3` for the box actor's tests.

## The lint ratchet

`lint-baseline.json` records the allowed per-rule finding counts. Counts may
only fall:

- When your change removes findings, lower the baseline in the same change.
- Never raise the baseline to make a change pass.
- The vendored plugin in `tools/oxlint/anti-slop/` is never edited locally;
  re-vendor from upstream instead of patching.

## Cross-runtime contracts

Any payload that crosses a runtime boundary (TypeScript ↔ Go ↔ bash ↔
Python ↔ browser) must have a fixture corpus under
`packages/schema/fixtures/` and conformance tests on **both** sides. Never
hand-edit one side of a contract. The full contract table — which fixtures
pin which boundary, and which tests enforce them — is in
[CLAUDE.md](CLAUDE.md).

## Go components

Three Go modules sit outside the npm workspace graph and are not touched by
`npm test`. Test them directly:

```sh
(cd packages/broker && go test ./...)
(cd packages/box/gateway && go test ./...)
(cd packages/microvm-host && go test ./...)
```

The box gateway's conformance tests read the shared fixtures from
`packages/schema/fixtures/`, so run them from a full checkout.

## Commit style

Conventional commits, imperative mood, as in the existing history:

```text
feat(webapp): working invite links, styled members/invites
fix(identity): gate webApp tickets on the VM's gateway generation
docs: add workspace screenshot to the README
chore: move e2e/ under tools/
test(identity): fixture the webApp ticket across all three verifiers
```

Types in use: `feat`, `fix`, `docs`, `chore`, `test`. Scope is the package or
subsystem when one applies.

## What CI runs

`.github/workflows/ci.yml`, on every push and pull request:

- **JavaScript**: `npm ci`, then the three gates.
- **Go broker**: `go test ./...` in `packages/broker`.
- **Box image**: an amd64 `docker build` of `packages/box/Dockerfile` as a
  build check (no push).

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds and
publishes the box and broker images for amd64 **and** arm64 — so an
amd64-only CI pass does not guarantee the arm64 release build.

## Design records

`plans/` holds design documents. They are records of decisions at a point in
time, not living documentation — for example, `plans/README-GAPS.md` is a
dated audit that predates several features it reports as missing. Trust the
code and the fixture corpus over any plan document.

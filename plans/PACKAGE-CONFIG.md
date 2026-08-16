# Package environment contract

Problem: configuration is spread across process-specific env lookups, shell
defaults, Docker arguments, systemd units, Vite variables, and Cloudflare
configuration. Defaults and validation differ by entrypoint, examples leak
machine-specific values, and no single place shows a package's contract.

## Decision

Each package that reads configuration owns a checked-in
`packages/<package>/config.json` declaring its environment-variable
interface. The program itself validates its environment at startup through a
small shared helper (one per language). There is no launcher, no wrapper CLI,
no generated environment artifacts, and no entrypoint changes. Deployment
surfaces keep setting plain environment variables exactly as they do today.

A package with no environment reads has no file; absence is the declaration.
V1 covers `box`, `broker`, `control-plane`, `microvm-host`, and `ui`.
`schema` gets a file only if inventory finds real env reads.

Goals:

- one uniform, discoverable declaration of names, types, defaults, and
  secrecy per package;
- identical interpretation on every launch path, because the same in-process
  code applies defaults and validation everywhere;
- fail at startup with package-qualified errors;
- environment variables remain the only override mechanism.

Non-goals: replacing secret stores or deployment manifests; describing
infrastructure resources (D1/R2 bindings, systemd `User=`); wrapping,
re-launching, or environment-isolating processes.

## File shape

```json
{
  "$schema": "../../config/package-config.schema.json",
  "package": "microvm-host",
  "env": {
    "BLITZ_MICROVM_LISTEN_ADDR": { "type": "string", "default": "0.0.0.0:8086" },
    "BLITZ_MICROVM_SSH_PORT_BASE": { "type": "integer", "default": 22000, "minimum": 1024, "maximum": 65535 }
  }
}
```

`package` must equal the directory name. Keys match `^[A-Z][A-Z0-9_]*$` and
are sorted. Unknown fields are errors. `type` is required; supported types
are `string`, `integer`, `number`, `boolean`, and `json`.

Optional fields: `default` (JSON value of the declared type), `required`
(default `false`), `secret` (default `false`), `allowEmpty` (strings only,
default `false`), `minimum`/`maximum` (numeric bounds), `enum`, and `public`
(`ui` only; marks a value as intentionally exposed to browser code).
Anything stricter — URL schemes, absolute paths, length limits — lives in
program code after loading.

## Resolution

For each declared key, in the program at startup:

1. Take the process environment value if the key is set.
2. Otherwise take `default`.
3. Otherwise fail if `required`; else the value is absent.
4. Parse and check the value; collect all errors and report them together.

Rules:

- Missing and empty are distinct. An unset key falls back to `default`; an
  empty string never does, and is valid only with `allowEmpty: true`.
- An invalid set value is an error; it never falls back to the default.
- `boolean` accepts only `true` or `false`; `integer` accepts canonical
  base-10; `json` must parse as JSON. The program consumes the parsed value,
  so no canonical re-serialization exists.
- Undeclared ambient variables are ignored: not validated, not stripped.
- Errors name the package and key; secret values are redacted. Secret entries
  never have defaults. Secret file contents stay in protected files or the
  platform secret store; the declaration holds only a non-secret path
  variable pointing at the file.

## Helpers

- Go: one shared package. Each program embeds its `config.json` with
  `go:embed` and calls a load function at startup that returns typed values.
- Node: one shared module. Each package imports its `config.json` and runs
  the loader against `process.env` (or the Worker `env` object).
- One shared test-vector file: declaration + environment → expected values or
  error. Both helpers must pass every vector. This replaces cross-language
  byte-for-byte golden outputs.
- No CLI. Shell scripts and CI do not validate; the program they start does.

## Platform boundaries

- Docker, systemd, shell, CI: unchanged. They set environment variables; the
  program validates at startup.
- Cloudflare: the Worker validates its `env` object once at init. A CI check
  compares declared names against Wrangler vars and secret names (names
  only). D1/R2 bindings stay in Wrangler and out of `config.json`.
- Vite: only `public: true` entries may reach the browser; `public` requires
  the `VITE_` prefix; `secret` plus `public` is a schema error. A build-time
  check compares the bundle-exposed set against the declaration.

## Defaults policy

Defaults must be portable, dev-safe values. Never check in personal
usernames, home paths, machine addresses, cloud resource IDs, or secret
contents. Loopback and documented wildcard listen addresses are fine.
Required secrets have no default. CI validates every declaration against the
schema and greps for forbidden personal and credential patterns.

## Migration

1. Inventory every env read in the covered packages. Classify each as keep,
   rename, non-env (state files, command inputs, bindings), or obsolete. Do
   not copy variables blindly.
2. Add the JSON Schema, the two helpers, and the shared vectors.
3. Add declarations and CI validation; no behavior change yet.
4. Switch startup code to the helper one package at a time: `microvm-host`,
   `broker`, `box`, then `control-plane`, then `ui`. Deployment files are
   untouched, so rollback is reverting one commit.
5. `microvm-host` cleanup rides along: delete the unused `lab_dir` /
   `BLITZ_LAB`; replace personal deploy values with portable ones; keep
   host/control-plane token contents in protected files and declare only the
   path variable; declare and validate the SSH port base.
6. Boundaries preserved: `broker` enrollment origin and advertised host/port
   remain enrollment command inputs persisted as state, not env entries;
   `box` and provider credentials remain in existing broker/state files.
7. Renames: the program reads the old name with a startup warning for one
   release, then drops it. Setting both old and new names is an error. No
   alias tables and no comparison/warn mode.

## Acceptance

- The schema rejects unknown fields, bad types/defaults/bounds/enums, and
  `secret` plus `public`.
- Go and Node helpers pass the shared vectors: precedence, missing versus
  empty, bounds, enums, booleans, JSON, redaction.
- Existing package unit/integration/e2e suites stay green after each switch.
- One CI command validates all declarations plus the defaults policy; the
  Cloudflare name check and the Vite exposure check also run in CI.
- No checked-in declaration or example contains a personal or secret value.

## Open decisions

1. Where do the two helpers and the shared test vectors live (an existing
   shared package or a small new one)?
2. Guest DNS on `microvm-host`: declare it in v1, or keep it fixed and
   document why.

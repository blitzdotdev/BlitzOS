# Package environment defaults

Problem: environment defaults and their documentation are spread across code,
shell scripts, Docker files, systemd units, Vite config, and Wrangler config.
They drift, and machine-specific values leak into checked-in files.

## Decision

One checked-in file, `env.defaults`, at the repository root. It is dotenv
format. It lists the shared package environment variables as
`KEY=portable-default`, with a `#` comment above each entry stating its type and
meaning. The box is the exception: Docker `ENV` owns its four defaults and
generates `/etc/blitz/env.defaults` for deployed host and microVM compatibility.
The repository file has no box section.

There is no loader library, no validation engine, no schema, no generated
files, and no CLI. Types are comments. A wrong value fails at runtime inside
the program that reads it, like any other bad input.

## Injection

Each launch surface injects the file with its native mechanism:

- Node processes and scripts: `node --env-file=env.defaults` (it does not
  override variables that are already set).
- Vite: `envDir` points at the repository root; Vite's own `VITE_` prefix
  rule decides what reaches the browser.
- Docker Compose: `env_file:` pointing at `env.defaults`; explicit
  `environment:` entries override it.
- systemd: `EnvironmentFile=` pointing at an installed copy of the file;
  deployment owns installing it.
- Shell/dev scripts: source the file before exec for entries not already set.
- Cloudflare Worker: it has no process environment. `wrangler.jsonc` vars
  remain its native defaults layer; `env.defaults` documents those names in
  comments only.

The real environment wins over the file wherever the mechanism supports it.

## Rules

- Programs read the environment directly (`os.Getenv`, `process.env`). Where
  `env.defaults` owns a default, the duplicate in-code fallback is removed.
  A program launched without injection fails at runtime; that is acceptable.
- Portable values only: no personal usernames, home paths, machine addresses,
  resource IDs, or secret contents. Secret contents stay in protected files;
  the file lists only the path variables that point at them. Enforced by
  review, not tooling.
- Secrets never have default values.

## Migration

1. Build `env.defaults` from the inventory in
   `plans/evidence/package-config-inventory.md`. Skip obsolete variables,
   command inputs, state-file values, and provider bindings.
2. Add native injection to each launch surface.
3. Remove the duplicated in-code and in-script defaults the file now owns.
4. Keep the `microvm-host` portability cleanup: no `BLITZ_LAB`, no personal
   values, token paths instead of token contents, declared SSH port base.

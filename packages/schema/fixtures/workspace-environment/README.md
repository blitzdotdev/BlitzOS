# Workspace environment response contract

The control plane returns exactly `env`, `startupScript`, and `filesReady` from
`GET /workspaces/self/environment`. Environment keys use shell variable syntax,
all values are strings, and `startupScript` is either a bash string or null.

Three runtimes carry this payload and none of them can share a module: the
control plane's `core/` may only import relatively, and the box actor is built
from a separate workspace. These fixtures are what keeps their limits equal —
at most 50 keys, at most 8 KiB of key and value bytes summed, and a startup
script of at most 64 KiB.

The TypeScript producer (`control-plane/core/environment.ts`, through the route
it serves) and the Go consumer (`broker/internal/workspace/environment.go`) must
accept every fixture in `valid/` and reject every fixture in `invalid/`.

The box actor reads only `env` from the copy the broker stores, so it is held to
the `env` fixtures alone: `startup-script-type`, `files-ready-type`, and
`extra-field` are deliberately not its concern.

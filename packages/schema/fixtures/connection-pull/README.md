# Connection pull contract

An agent asks for a credential at the moment it uses one. The control plane
answers `POST /workspaces/self/connections/:name/token` with exactly
`connection`, `mode`, `token`, `env`, `header`, and `expiresAt`. Nothing is
delivered ahead of use, and the box stores none of it.

Two runtimes carry this payload and cannot share a module. The producer is
`control-plane/core/connections/pull-wire.ts`. The consumer is
`broker/internal/workspace/connections.go`, and it decodes with
`DisallowUnknownFields`. These fixtures are what keeps the two sides equal.

Both sides must accept every fixture in `valid/` and reject every fixture in
`invalid/`.

The `invalid/` cases are all print safety. The box prints these bytes: `blitz-cred
get` writes the token on stdout, and `blitz-cred env` writes one comment line
naming the header, then `NAME='value'` lines an agent evals. A carriage return
or newline anywhere in that set ends a line early and lets the rest read as a
statement the control plane never sent. `token-bad-env-name` would print a
shell word that is not an identifier. `token-extra-field` is the old delivery
key: the box refuses an unknown field rather than guessing what it meant.

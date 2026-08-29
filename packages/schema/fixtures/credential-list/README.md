# Credential list contract

`blitz-cred list` asks `GET /workspaces/self/credentials` for the workspace
credential store: names and comments, never values. The CLI merges these
with the connection allow-list and prints a credential's comment after a
`#`, so an agent can pick the right key without asking.

The producer is `control-plane/core/connections/pull-routes.ts`
(`addBoxCredentialRoutes`). The Go consumer is
`broker/internal/workspace/credentials.go`, which decodes with
`DisallowUnknownFields` and prints names and comments on stdout. Both sides
must accept every fixture in `valid/` and the consumer must reject every
fixture in `invalid/`.

The `invalid/` cases are print safety: a comment with a newline could forge
a second list line; a name outside the credential alphabet is one the token
pull would refuse anyway; an unknown field is refused rather than guessed
at.

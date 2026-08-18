# Workspace environment response contract

The control plane returns exactly `env`, `startupScript`, and `filesReady` from
`GET /workspaces/self/environment`. Environment keys use shell variable syntax,
all values are strings, and `startupScript` is either a bash string or null.

The TypeScript producer and box consumers must accept every fixture in `valid/`
and reject every fixture in `invalid/`.

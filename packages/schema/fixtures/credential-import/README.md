# Credential import contract

`blitz-cred import` sends dotenv text to
`POST /workspaces/self/credentials/dotenv`; the webApp's credentials tab
sends the same body to `/workspaces/:id/credentials/dotenv`. The control
plane parses the text once, stores each KEY=value line as a workspace
credential, and answers with per-key outcomes and `linesRead`. No value
ever travels back: the response names keys and store-level outcomes only.

The producer is `control-plane/core/workspace-credential-import.ts`. The Go
consumer is `broker/internal/workspace/credimport.go`, which decodes with
`DisallowUnknownFields` and prints names and reasons on stdout. Both sides
must accept every fixture in `valid/` and the consumer must reject every
fixture in `invalid/`.

The `invalid/` cases are print safety and vocabulary. A name or reason with
a newline could forge a second `blitz-cred import` result row; an outcome
outside stored/rotated/unchanged/refused is a word the CLI would print
without knowing what it promised; an unknown field is refused rather than
guessed at.

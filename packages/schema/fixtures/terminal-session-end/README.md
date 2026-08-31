# Terminal-session-end fixtures

Closing a shared agent/terminal tab ends that session for everyone. The
browser posts `{ "kind", "key" }` to the box gateway at
`POST /terminal/session/end`; the gateway maps the kind to the tmux
session-name prefix `blitz-term` gave it, matches the exact name `=<prefix>-<key>`,
and kills it, replying `{ "ended": <bool> }` (false when nothing was running).

The load-bearing contract is the **name**: the kill target must equal the name
`blitz-term` (`box/rootfs/usr/local/libexec/blitz-term`) chose when it created
the session, or a close would leave the agent running. So the prefix map and
the key rule live in both places:

- `terminal` -> `term`, `claude` -> `claude`, `codex` -> `codex`. Only these
  three kinds are tmux-backed; any other kind is rejected, and the browser
  never posts it.
- the key matches `^[A-Za-z0-9_-]{1,128}$`, exactly `blitz-term`'s session-key
  rule.

Each fixture pairs a `request` with the expected `status` and, when accepted,
the exact tmux `target` the gateway computes. A rejected request (`status`
400) yields no kill and names no target.

Conformance: the Go gateway reader is tested in
`packages/box/gateway/main_test.go`; the browser producer/consumer in
`packages/webapp/src/terminal-session.ts` is tested in
`packages/webapp/test/terminal-session.test.ts`. The guest naming producer is
`blitz-term`, whose prefix map this corpus mirrors.

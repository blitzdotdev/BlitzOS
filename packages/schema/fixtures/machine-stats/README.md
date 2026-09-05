# Machine-stats fixtures

The box updater measures the filesystem holding its state directory after each
successful tick and posts the result to `POST /workspaces/self/machine-stats`
with its bearer. The producer is the dependency-free
`packages/box/rootfs/usr/local/libexec/blitz-payload`; the consumer is
`packages/control-plane/core/machine-stats.ts`. This corpus remains the accept
rule for the wire contract.

Each fixture pairs a candidate request body (`request`) with whether the
control-plane consumer must accept it (`accepts`).

The accept rule: a JSON object whose `diskUsedPercent` is an integer between 0
and 100 inclusive. A float, a numeric string, a null and a missing field are
all refused with 400 — a machine that cannot measure its disk must send
nothing, because a wrong figure overwrites the last true one and the column
has no way to say "this one is a guess". Unknown extra keys are accepted, so a
newer guest that reports more than this control plane understands still lands
its percentage.

Conformance tests:

- `packages/control-plane/test/machine-stats-conformance.test.ts` — the
  consumer, over the real route with a real box credential.
- `packages/box/guest-tests/test/machine-stats-conformance.test.ts` — the
  producer: the real `blitz-payload tick` runs against a local origin and its
  bearer, content type, exact body shape, range and fail-open behavior are
  checked.

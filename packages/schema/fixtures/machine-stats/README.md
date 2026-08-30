# Machine-stats fixtures

The guest measures the filesystem holding its state directory and posts the
result to `POST /workspaces/self/machine-stats` with its box credential. The
payload crosses TS ↔ sh/node: the producer is
`packages/box/rootfs/usr/local/bin/blitz-machine-stats`, the consumer is
`packages/control-plane/core/machine-stats.ts`. This corpus is the accept rule
both sides are pinned to.

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
- `packages/box/actor/test/machine-stats-conformance.test.ts` — the producer:
  the real reporter script runs against a local origin, and what it posts is
  checked against the same accept rule.

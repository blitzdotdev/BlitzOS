# Lody local data-plane frames (protocol v7)

The frames the browser and the Lody session daemon exchange on `/lody/sync`.

At HEAD the box still installs the transition `lody@0.88.1` npm artifact and
its compiled patches until plan PR C; the target daemon is built from
`vendor/lody`. The recapture rule and upstream procedure are in
`docs/LODY-MERGE.md`.

## Why this is a BlitzOS contract

It was not one in phase 1. The bridge
(`packages/box/rootfs/usr/local/libexec/blitz-lody-bridge`) copies bytes without
reading them, so both ends of the wire were Lody's own code and Lody's own
schemas pinned it (`plans/evidence/lody-phase1.md`, blocker 4).

Phase 2 wrote the browser end:
`packages/webapp/src/lody/data-plane-connection.ts` is a BlitzOS-authored
producer and parser of these frames. That makes the FRAMING ours under
CLAUDE.md's cross-runtime rule, and this is its corpus. The three runtimes that
must agree:

| Side | Code | What it does with a frame |
|---|---|---|
| browser | `webapp/src/lody/data-plane-connection.ts` | one WebSocket text message = one JSON frame; parses with `LocalLoroDataPlaneServerMessageSchema` before delivering |
| bridge (node) | `box/rootfs/usr/local/libexec/blitz-lody-bridge` | translates framing only: one newline-delimited line on the unix socket ⇄ one WebSocket message |
| daemon (node) | transition image: npm artifact until plan PR C; target source: `vendor/lody/apps/cli` | authors and reads the same frames |

The SCHEMA stays Lody's — `vendor/lody/packages/shared/src/local-loro-data-plane.ts`
is the source of truth and the conformance tests validate against it rather than
against a copy. What this corpus pins is that our two sides keep agreeing with
it, and with each other, across an upstream merge.

## Provenance

Every server frame under `server/` except `room-status-reconnecting.json` and
`error-payload-too-large-terminal.json` was **captured from a real
`lody@0.88.1` daemon** on 2026-08-30, running the box's own patched bundle
(`packages/box/patches/lody-local-platform.mjs`) in local platform mode. The
base64 blobs are genuine Loro exports and a genuine EphemeralStore presence
snapshot, not hand-written bytes.

When a reviewed semantic change requires recapture, replace the historical
sentence above with: “Captured from the daemon built from `vendor/lody` at
`<upstreamSha>` (`distSha256` `<sha>`).” Use real stamp values.

The two exceptions are synthesized from the schema because the daemon never
emits them on this path: `room-status` is authored by the CLI's own transport
client, and `payload_too_large` is reachable only for a single flock entry over
the frame budget, which no realistic write produces.

`server/doc-update-chunked.json` is derived, not captured: it slices one real
captured update into a three-frame transfer the way
`buildDocUpdateChunkPayloads` does, and carries the reassembled result beside
it so a test can prove the round trip.

## Shape

- `constants.json` — the numbers and enums both sides hard-code. A drift here is
  the failure the protocol's `z.literal(7)` gate exists to make loud.
- `client/*.json` — one instance of each of the six client → server types.
  `join` appears three times, once per room scope, because the scope
  discriminator is where a room is addressed.
- `server/*.json` — one instance of each of the seven server → client types.
- `server/pong-with-unknown-field.json` — the schemas are deliberately NOT
  `.strict()`, so a newer daemon may add fields. That tolerance was
  load-bearing across the daemon/subtree skew present when this corpus was
  captured and remains pinned here.
- `invalid/*.json` — frames every reader must REJECT. A rejected frame is
  counted and dropped, never thrown: the link is a broadcast pipe, so one bad
  frame from a skewed peer must not tear down rooms that are converging.

## Conformance

- Browser: `packages/webapp/test/lody-data-plane-frames.test.ts`
- Bridge: `packages/box/guest-tests/test/lody-bridge-frames.test.ts`

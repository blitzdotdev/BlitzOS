# Lody session-control response stream (NDJSON)

The bytes `/lody/control` answers with when the caller negotiates
`Accept: application/x-ndjson`, and the buffered envelope it answers with when
nobody does.

## Why this is a BlitzOS contract

The daemon serves `/session-control` two ways and picks by `Accept`
(`vendor/lody/apps/cli/src/lib/local-session-control.ts:33`):

- with `application/x-ndjson` it writes one `{"kind":"response"}` frame per
  response AS THE FLOW PRODUCES IT, and a `{"kind":"complete"}` frame at the end;
- without it, it buffers every response and answers one
  `{"ok":true,"responses":[…]}` envelope when the whole request has finished.

Until 2026-08-31 the browser sent no `Accept` and `blitz-lody-bridge` replaced
the browser's headers with a fixed set that had none either, so every call took
the buffered path. `stream/authenticate-start.ndjson` is the file that shows why
that was a bug: the `authorization` frame carrying the sign-in URL is the SECOND
line, and the `machine/acp-authenticate_response` is the fifth. On the buffered
path the browser sees neither until the login process exits — and the login
process is `claude auth login --claudeai`, which blocks on stdin until the member
pastes back the code that is inside the frame it cannot see. The sign-in popup
sat at `about:blank` forever.

So there are now three runtimes that have to agree about these bytes:

| Side | Code | What it does |
|---|---|---|
| browser | `webapp/src/lody/rpc-client.ts` (`sendSessionControl`) | asks for the stream, reads it frame by frame, emits each response before resolving |
| bridge (node) | `box/rootfs/usr/local/libexec/blitz-lody-bridge` | decides whether the negotiation goes upstream, and pipes the frames back unbuffered |
| daemon (node) | `lody@0.88.1`, not in this tree | authors the frames |

The FRAME UNION stays Lody's: `LocalSessionControlStreamFrameSchema`
(`vendor/lody/packages/shared/src/node/local-ipc.ts:80`) is the source of truth.
It is neither exported nor importable in a browser — that module pulls in
`node:net` and `node:http` — so `rpc-client.ts` re-states it by hand, and this
corpus is what keeps the hand-written copy honest. The RESPONSE payloads inside
each frame are validated against Lody's own `LocalSessionControlResponseSchema`,
never against a copy.

## Provenance

Everything under `stream/` except the last two files, and
`envelope/authenticate-cancel-not-running.json`, was **captured from a real
`lody@0.88.1` daemon** on 2026-08-31, running the box's own patched bundle
through the real `blitz-lody-bridge`. The authorization URL in them is a real one
that `claude auth login --claudeai` printed (claude 2.1.228, headless, scratch
`HOME`); it is a PKCE challenge for a login nobody completed, so it authorizes
nothing and has long since expired.

Two files are synthesized, because the daemon cannot be made to emit them on
demand:

- `stream/refused-mid-stream.ndjson` — the `{"kind":"error"}` arm. The daemon
  writes it only when a request fails AFTER its first frame is already on the
  wire (`local-session-control.ts:158`), which needs a dispatch that dies
  between two responses.
- `stream/truncated-no-complete.ndjson` — a body that ends without its
  completion frame, i.e. a socket that died mid-flow. A reader must treat this
  as a FAILURE even though every frame in it parsed: reporting the partial batch
  as `ok` is how a dropped sign-in would become a silent one.

`envelope/refused.json` is the buffered path's own failure shape.

## Shape

- `stream/*.ndjson` — whole response bodies, newline-delimited, exactly as the
  door writes them. Whole bodies rather than one frame per file because what is
  under test is a sequence: the ORDER of the frames, and the completion frame
  that terminates them.
- `envelope/*.json` — the buffered answers, for the fallback a box whose bridge
  predates this change still takes.
- `invalid/*.ndjson` — lines every reader must refuse. Unlike the data-plane
  corpus these are FATAL rather than dropped: a session-control stream is one
  request's answer, not a broadcast pipe, so a frame that cannot be read means
  the answer cannot be trusted.

## Conformance

- Browser: `packages/webapp/test/lody-session-control-stream.test.ts`
- Bridge: `packages/box/guest-tests/test/lody-bridge-control-stream.test.ts`
- End to end against a real daemon:
  `packages/webapp/test/lody-acp-authentication.test.ts`

// @vitest-environment node
/**
 * Browser-side conformance for the session-control response stream
 * (`packages/schema/fixtures/lody-session-control-stream/`, CLAUDE.md
 * cross-runtime rule).
 *
 * `sendSessionControl` is driven against the corpus through a fake `fetch`, so
 * this runs in CI where the daemon-backed suite skips. Two properties are under
 * test and only one of them is about parsing:
 *
 * 1. every frame is emitted AS IT ARRIVES, not at the end. The chunk boundaries
 *    are chosen adversarially — mid-token, mid-line — because the delivery
 *    order is the whole reason the stream exists, and a reader that buffered the
 *    body and split it afterwards would pass a shape test while reproducing the
 *    bug this replaced.
 * 2. a stream that cannot be read is a FAILURE, never a partial success.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SESSION_CONTROL_STREAM_MEDIA_TYPE,
  sendSessionControl,
  sessionControlTimeoutMs,
  type LodyHttpPlaneEndpoints,
} from "../src/lody/rpc-client.js";
import type { LodySessionControlMessage } from "../src/lody/wire-types.js";

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../schema/fixtures/lody-session-control-stream",
);

function corpus(relative: string): string {
  return readFileSync(join(CORPUS, relative), "utf8");
}

/** One `machine/acp-authenticate` start, the message every captured stream in
 * the corpus is the answer to. */
const START: LodySessionControlMessage = {
  type: "machine/acp-authenticate",
  machineId: "c41de1f7-beab-4509-84ee-d6703f540857",
  workspaceId: "lw_00000000000000000000000000000000",
  requestId: "req-authenticate-1",
  action: "start",
  cliType: "builtin",
  agentType: "claude",
} as unknown as LodySessionControlMessage;

interface FakeCall {
  headers: Record<string, string>;
  body: string;
}

/**
 * A `fetch` that answers with `body`, delivered in `chunks` pieces.
 *
 * The pieces are byte slices at arbitrary offsets, so a multi-byte character or
 * a JSON token can be split across two of them — which is what a real socket
 * does and what a naive `chunk.toString()` reader gets wrong. The corpus is
 * full of `…` and `’`, so this is not a hypothetical.
 */
function streamingFetch(
  body: string,
  options: { contentType?: string; pieces?: number; status?: number } = {},
): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const bytes = new TextEncoder().encode(body);
  const pieces = options.pieces ?? 1;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({
      headers: { ...(init.headers as Record<string, string>) },
      body: String(init.body),
    });
    const size = Math.max(1, Math.ceil(bytes.length / pieces));
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
    });
    return {
      status: options.status ?? 200,
      headers: new Headers({
        "content-type": options.contentType ?? `${SESSION_CONTROL_STREAM_MEDIA_TYPE}; charset=utf-8`,
      }),
      body: stream,
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function endpoints(fetchImpl: typeof fetch): LodyHttpPlaneEndpoints {
  return {
    rpcUrl: "http://127.0.0.1:1/lody/rpc",
    controlUrl: "http://127.0.0.1:1/lody/control",
    projectUrl: "http://127.0.0.1:1/lody/project",
    platformUrl: "http://127.0.0.1:1/lody/platform",
    fetchImpl,
  };
}

describe("the session-control stream, read as it arrives", () => {
  it("asks the daemon for the stream in the first place", async () => {
    const { fetchImpl, calls } = streamingFetch(corpus("stream/authenticate-cancel-not-running.ndjson"));
    await sendSessionControl(endpoints(fetchImpl), START, () => undefined);
    // The one header the whole fix turns on. Without it the daemon answers a
    // buffered envelope and no response can arrive early.
    expect(calls[0]?.headers.accept).toBe(SESSION_CONTROL_STREAM_MEDIA_TYPE);
    expect(calls[0]?.headers["x-lody-local-control"]).toBe("1");
  });

  it("delivers the captured authenticate flow in order, URL first", async () => {
    const { fetchImpl } = streamingFetch(corpus("stream/authenticate-start.ndjson"));
    const emitted: LodySessionControlMessage[] = [];
    const result = await sendSessionControl(endpoints(fetchImpl), START, (response) =>
      emitted.push(response),
    );
    if (!result.ok) throw new Error(`stream refused: ${result.error}`);

    expect(emitted.map((response) => response.type)).toEqual([
      "machine/acp-authentication-progress",
      "machine/acp-authentication-progress",
      "machine/acp-authentication-progress",
      "machine/acp-authentication-progress",
      "machine/acp-authenticate_response",
    ]);
    // THE ORDERING THAT MATTERS: the sign-in URL is delivered four frames before
    // the response, which on the buffered path is four frames the member could
    // not have until the sign-in they needed it for had already ended.
    const authorization = emitted[1];
    expect(authorization?.status).toBe("authorization");
    expect(String(authorization?.authorizationUrl)).toMatch(
      /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/u,
    );
    expect(authorization?.acceptsAuthorizationCode).toBe(true);
    // And the caller still gets the whole batch, exactly as Electron's own
    // service returns it — the vendored runtime de-duplicates what it saw
    // streamed against this array.
    expect(result.responses).toEqual(emitted);
  });

  it("emits every frame before it resolves, at any chunk boundary", async () => {
    const body = corpus("stream/authenticate-start.ndjson");
    for (const pieces of [1, 2, 7, 40, body.length]) {
      const { fetchImpl } = streamingFetch(body, { pieces });
      const emitted: string[] = [];
      let settled = false;
      const result = await sendSessionControl(endpoints(fetchImpl), START, (response) => {
        // A frame emitted after the promise settles is a frame the vendored
        // `sendLocalSessionControl` has already unsubscribed from, i.e. lost.
        expect(settled, `frame after settle at pieces=${pieces}`).toBe(false);
        emitted.push(String(response.type));
      }).finally(() => {
        settled = true;
      });
      expect(result.ok, `pieces=${pieces}`).toBe(true);
      expect(emitted.length, `pieces=${pieces}`).toBe(5);
    }
  });

  it("keeps the frames it read when the daemon refuses mid-stream", async () => {
    const { fetchImpl } = streamingFetch(corpus("stream/refused-mid-stream.ndjson"));
    const emitted: LodySessionControlMessage[] = [];
    const result = await sendSessionControl(endpoints(fetchImpl), START, (response) =>
      emitted.push(response),
    );
    // The refusal wins — but the frame that arrived before it was still
    // delivered, because the panel may already have acted on it.
    expect(result).toEqual({ ok: false, error: "workspace_runtime_unavailable" });
    expect(emitted).toHaveLength(1);
  });

  it("refuses a stream that ends without its completion frame", async () => {
    const { fetchImpl } = streamingFetch(corpus("stream/truncated-no-complete.ndjson"));
    const result = await sendSessionControl(endpoints(fetchImpl), START, () => undefined);
    // Every frame in this body parsed. Reporting it as `ok` would turn a socket
    // that died mid-flow into a silently short answer.
    expect(result).toEqual({ ok: false, error: "lody_session_control_stream_truncated" });
  });

  it("refuses every frame in the invalid corpus", async () => {
    const names = readdirSync(join(CORPUS, "invalid")).sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const { fetchImpl } = streamingFetch(corpus(join("invalid", name)));
      const result = await sendSessionControl(endpoints(fetchImpl), START, () => undefined);
      expect(result.ok, name).toBe(false);
    }
  });
});

describe("the buffered envelope, for a daemon that ignored the negotiation", () => {
  it("reads the captured envelope and still emits its responses", async () => {
    const { fetchImpl } = streamingFetch(corpus("envelope/authenticate-cancel-not-running.json"), {
      contentType: "application/json; charset=utf-8",
    });
    const emitted: LodySessionControlMessage[] = [];
    const result = await sendSessionControl(endpoints(fetchImpl), START, (response) =>
      emitted.push(response),
    );
    if (!result.ok) throw new Error(`envelope refused: ${result.error}`);
    expect(result.responses).toHaveLength(1);
    expect(emitted).toEqual(result.responses);
    expect(result.responses[0]?.disposition).toBe("not-running");
  });

  it("carries the envelope's own refusal through", async () => {
    const { fetchImpl } = streamingFetch(corpus("envelope/refused.json"), {
      contentType: "application/json",
    });
    const result = await sendSessionControl(endpoints(fetchImpl), START, () => undefined);
    expect(result).toEqual({ ok: false, error: "machine_mismatch" });
  });
});

describe("sessionControlTimeoutMs", () => {
  it("gives an interactive sign-in the daemon's own deadline", () => {
    // `claude auth login --claudeai` blocks on stdin until the member pastes the
    // code, and the daemon caps that at 285 s. The old flat 120 s default cut
    // the flow in half, so the request died while the member was still reading
    // the browser page it opened.
    expect(sessionControlTimeoutMs("machine/acp-authenticate")).toBe(300_000);
    expect(sessionControlTimeoutMs("machine/acp-binary-install")).toBe(300_000);
  });

  it("lengthens deadlines and never shortens one", () => {
    // Lody's desktop table gives an unnamed type 10 s, which is right for a
    // daemon on the same machine and wrong across a Worker, a box gateway and a
    // git worktree cut. Everything not named keeps the 120 s this door always
    // had, so no existing flow gets less time than it did.
    for (const type of ["session/create", "session/chat", "session/file-send-local"]) {
      expect(sessionControlTimeoutMs(type), type).toBeGreaterThanOrEqual(120_000);
    }
  });
});

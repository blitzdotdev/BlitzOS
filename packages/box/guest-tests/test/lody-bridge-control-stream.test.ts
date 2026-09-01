/**
 * Bridge-side conformance for the session-control response stream
 * (`packages/schema/fixtures/lody-session-control-stream/`, CLAUDE.md
 * cross-runtime rule).
 *
 * This drives the REAL `/usr/local/libexec/blitz-lody-bridge` against a stand-in
 * daemon that serves `/session-control` the way `lody@0.88.1` serves it: NDJSON
 * when the request carries `Accept: application/x-ndjson`, one buffered envelope
 * when it does not (`apps/cli/src/lib/local-session-control.ts:33`).
 *
 * Two decisions belong to the bridge and neither is visible from the browser:
 *
 * 1. WHETHER THE NEGOTIATION TRAVELS. `forward()` replaces the browser's headers
 *    with a fixed set — a Cookie or an Authorization from the page has no
 *    business on the daemon's control socket — and until 2026-08-31 that set had
 *    no `accept`, so the daemon buffered every answer. It is carried now, and
 *    carried as a DECISION: the inbound value is inspected and what goes
 *    upstream is the one constant or nothing.
 * 2. WHETHER THE FRAMES ARE PIPED OR POOLED. A bridge that collected the body
 *    and answered at the end would satisfy every shape assertion and still
 *    reproduce the bug, so the stand-in daemon holds its stream open and the
 *    test reads the first frame before the last one is written.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BRIDGE = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-lody-bridge", import.meta.url),
);
const CORPUS = fileURLToPath(
  new URL("../../../schema/fixtures/lody-session-control-stream/", import.meta.url),
);
const REPO_NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

const STREAM_MEDIA_TYPE = "application/x-ndjson";

function corpus(relative: string): string {
  return readFileSync(join(CORPUS, relative), "utf8");
}

/** Every `Accept` the stand-in daemon was asked with, in order. */
const accepts: (string | undefined)[] = [];
/** Set while the stand-in daemon is holding a stream open, and called by
 * `releaseHeldStream` to write the rest of it. */
let releaseStream: (() => void) | null = null;

/** Writes the rest of the held stream and closes it. Throws rather than
 * shrugging: a test that reached here without a held stream is a test whose
 * "the bridge answered early" assertion never had anything to be early about. */
function releaseHeldStream(): void {
  const release = releaseStream;
  releaseStream = null;
  if (release === null) throw new Error("no stream is being held open");
  release();
}

describe("blitz-lody-bridge session-control streaming", () => {
  let dataDir: string;
  let bridgeSocket: string;
  let bridge: ChildProcess;
  const servers: Server[] = [];

  /**
   * The daemon's own two-way answer, reduced to the negotiation.
   *
   * A streamed answer is written in TWO writes with a gap the test controls, so
   * "the first frame reached the browser before the last was written" is a fact
   * the test can establish rather than infer from timing.
   */
  function serveControl(path: string): void {
    const server = createHttpServer((incoming, response) => {
      let body = "";
      incoming.on("data", (chunk) => (body += String(chunk)));
      incoming.on("end", () => {
        const accept = incoming.headers.accept;
        accepts.push(Array.isArray(accept) ? accept.join(",") : accept);
        const wantsStream = String(accept ?? "").split(",").some(
          (entry) => entry.trim().startsWith(STREAM_MEDIA_TYPE),
        );
        if (!wantsStream) {
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          response.end(corpus("envelope/authenticate-cancel-not-running.json"));
          return;
        }
        writeStreamed(response, body);
      });
    });
    server.listen(path);
    servers.push(server);
  }

  function writeStreamed(response: ServerResponse, body: string): void {
    response.writeHead(200, {
      "content-type": `${STREAM_MEDIA_TYPE}; charset=utf-8`,
      "cache-control": "no-store",
    });
    const lines = corpus("stream/authenticate-start.ndjson").split("\n").filter((line) => line !== "");
    // Everything up to the response frame goes now; the rest waits for the test,
    // which stands in for the member finishing the sign-in in their browser.
    const head = lines.slice(0, 2);
    const tail = lines.slice(2);
    for (const line of head) response.write(`${line}\n`);
    releaseStream = () => {
      for (const line of tail) response.write(`${line}\n`);
      response.end();
    };
    void body;
  }

  /** One POST through the bridge, reading the response as it streams. */
  function bridgePost(
    path: string,
    body: string,
    accept: string | null,
  ): Promise<{
    status: number;
    contentType: string;
    /** Resolves with the body so far, once `predicate` accepts it. */
    until: (predicate: (text: string) => boolean, what: string) => Promise<string>;
    done: Promise<string>;
  }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (accept !== null) headers.accept = accept;
      const outgoing = request({ socketPath: bridgeSocket, path, method: "POST", headers }, (response) => {
        let text = "";
        let ended = false;
        const done = new Promise<string>((settle) => {
          response.on("data", (chunk) => (text += String(chunk)));
          response.on("end", () => {
            ended = true;
            settle(text);
          });
        });
        // Polled rather than event-driven on purpose: the daemon's two writes
        // may arrive as one TCP chunk or as two, and which one it is is not the
        // property under test. What is, is that they arrive BEFORE the request
        // ends — so the deadline is short and `ended` is a failure.
        const until = async (predicate: (value: string) => boolean, what: string): Promise<string> => {
          const deadline = Date.now() + 5_000;
          for (;;) {
            if (predicate(text)) return text;
            if (ended) throw new Error(`stream ended before ${what}; body was ${text}`);
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await new Promise((settle) => setTimeout(settle, 10));
          }
        };
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          until,
          done,
        });
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "lcs-"));
    mkdirSync(join(dataDir, "run"), { recursive: true });
    bridgeSocket = join(dataDir, "b.sock");
    serveControl(join(dataDir, "run", "lody-oss-control.sock"));
    writeFileSync(
      join(dataDir, "workspace-catalog.json"),
      JSON.stringify({
        version: 1,
        identity: { userId: "local:0123456789abcdef" },
        machine: { machineId: "c41de1f7-beab-4509-84ee-d6703f540857", machineName: "box" },
        workspaces: [
          { workspaceId: "lw_deadbeef", name: "Lody", slug: "local", role: "owner", state: "active" },
        ],
      }),
    );

    bridge = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        LODY_DATA_DIR: dataDir,
        LODY_PLATFORM: "local",
        BLITZ_LODY_BRIDGE_SOCKET: bridgeSocket,
        NODE_PATH: REPO_NODE_MODULES,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      bridge.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("listening on")) resolve();
      });
      bridge.once("exit", (code) => reject(new Error(`bridge exited early with ${code}`)));
      setTimeout(() => reject(new Error("bridge did not report listening")), 8_000);
    });
  });

  afterAll(() => {
    bridge?.kill("SIGTERM");
    for (const server of servers) server.close();
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  });

  it("carries the stream negotiation to the daemon, and pipes the frames back live", async () => {
    accepts.length = 0;
    releaseStream = null;
    const call = await bridgePost("/control", '{"type":"machine/acp-authenticate"}', STREAM_MEDIA_TYPE);

    expect(accepts).toEqual([STREAM_MEDIA_TYPE]);
    expect(call.status).toBe(200);
    expect(call.contentType).toMatch(/^application\/x-ndjson/u);

    // The daemon has written two frames and is still holding the request open.
    // A bridge that pooled the body would answer nothing until `releaseStream`,
    // so reaching the authorization frame here IS the live-piping assertion.
    const early = await call.until(
      (text) => text.includes('"status":"authorization"'),
      "the authorization frame",
    );
    const first = JSON.parse(early.split("\n")[0] ?? "{}");
    expect(first.kind).toBe("response");
    expect(first.response.status).toBe("starting");
    expect(early).not.toContain('"kind":"complete"');

    releaseHeldStream();
    const whole = await call.done;
    expect(whole).toBe(corpus("stream/authenticate-start.ndjson"));
  });

  it("sends no Accept upstream when the browser asked for none", async () => {
    accepts.length = 0;
    const call = await bridgePost("/control", '{"type":"machine/acp-authenticate"}', null);
    await call.done;
    // Not `undefined` by luck: `forward()` builds the upstream headers from a
    // fixed set, so anything here that is not the stream media type means a
    // browser header leaked onto the control socket.
    expect(accepts[0]).toBeUndefined();
    expect(call.contentType).toMatch(/^application\/json/u);
  });

  it("does not carry an Accept the daemon does not serve", async () => {
    accepts.length = 0;
    const call = await bridgePost("/control", '{"type":"machine/acp-authenticate"}', "text/event-stream");
    await call.done;
    expect(accepts[0]).toBeUndefined();
  });

  it("carries it out of a longer Accept list", async () => {
    accepts.length = 0;
    releaseStream = null;
    const call = await bridgePost(
      "/control",
      '{"type":"machine/acp-authenticate"}',
      `text/plain, ${STREAM_MEDIA_TYPE};q=0.9, */*`,
    );
    // Rewritten to the one constant, never forwarded verbatim.
    expect(accepts).toEqual([STREAM_MEDIA_TYPE]);
    await call.until((text) => text.includes('"status":"authorization"'), "the authorization frame");
    releaseHeldStream();
    await call.done;
  });

  it("leaves the other two planes' headers alone", async () => {
    accepts.length = 0;
    const rpc = await bridgePost("/rpc", '{"method":"session/terminate"}', STREAM_MEDIA_TYPE);
    await rpc.done;
    const project = await bridgePost("/project", '{"type":"local-project/list"}', STREAM_MEDIA_TYPE);
    await project.done;
    // `/machine-rpc` and `/project-control` have no streamed mode at all, so
    // asking for one there would be a header with no meaning.
    expect(accepts).toEqual([undefined, undefined]);
  });
});

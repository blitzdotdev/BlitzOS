/**
 * PHASE 6 — the bridge's half of the share contract
 * (`packages/schema/fixtures/lody-share-claim/`, `plans/LODY-SHARING.md` §4).
 *
 * The gateway decides WHERE a shared request may go; this decides what it may
 * SAY once it gets there. Both halves are hand-written readers of one wire
 * format, which is why the ACL is a fixture table rather than prose, and why
 * this drives the REAL `/usr/local/libexec/blitz-lody-bridge` as a child
 * process against a stand-in daemon rather than testing a copy of the rules.
 *
 * A connection with NO claim is the phase-2 bridge, unchanged, and that is
 * asserted here too: the owner of the box keeps the dumb-pipe path, and the
 * parsing cost is paid only by a share.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const BRIDGE = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-lody-bridge", import.meta.url),
);
const CORPUS = fileURLToPath(new URL("../../../schema/fixtures/lody-share-claim/", import.meta.url));
const REPO_NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

const SHARE_HEADER = "X-Blitz-Lody-Share";

function fixture<Value>(name: string): Value {
  return JSON.parse(readFileSync(join(CORPUS, name), "utf8")) as Value;
}

interface ClaimFixture {
  claim: { target: string; scope: string; read: string[]; write: string[] };
  header: string;
}

interface FrameDecision {
  claim: string;
  frame: Record<string, unknown>;
  verdict: "forward" | "drop" | "refuse";
  note: string;
}

interface RequestDecision {
  claim: string;
  door: string;
  body: Record<string, unknown>;
  allowed: boolean;
  note: string;
}

const claims = fixture<Record<string, ClaimFixture>>("claims.json");
const decisions = fixture<{ frames: FrameDecision[]; requests: RequestDecision[] }>("decisions.json");

function headerFor(name: string): string {
  const entry = claims[name];
  if (entry === undefined) throw new Error(`no claim fixture named ${name}`);
  return entry.header;
}

interface DaemonConnection {
  lines: string[];
}

describe("blitz-lody-bridge share ACL", () => {
  let dataDir: string;
  let bridgeSocket: string;
  let bridge: ChildProcess;
  const servers: Server[] = [];
  const dataPlaneConnections: DaemonConnection[] = [];
  const controlRequests: { path: string; body: string }[] = [];

  function serveLines(path: string): void {
    const server = createServer((socket: Socket) => {
      const connection: DaemonConnection = { lines: [] };
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.length > 0) connection.lines.push(line);
          index = buffer.indexOf("\n");
        }
      });
      dataPlaneConnections.push(connection);
    });
    server.listen(path);
    servers.push(server);
  }

  function serveControl(path: string): void {
    const httpServer = createHttpServer((incoming, response) => {
      let body = "";
      incoming.on("data", (chunk) => (body += String(chunk)));
      incoming.on("end", () => {
        controlRequests.push({ path: incoming.url ?? "", body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, seen: incoming.url }));
      });
    });
    httpServer.listen(path);
    servers.push(httpServer);
  }

  async function openShared(claimName: string | null): Promise<WebSocket> {
    const options = claimName === null
      ? {}
      : { headers: { [SHARE_HEADER]: headerFor(claimName) } };
    const socket = new WebSocket(`ws+unix://${bridgeSocket}:/sync`, options);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    // The bridge opens its daemon socket on connect; give it the turn.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return socket;
  }

  function bridgeHttp(
    method: string,
    path: string,
    body?: string,
    claimName?: string,
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (claimName !== undefined) headers[SHARE_HEADER] = headerFor(claimName);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        { socketPath: bridgeSocket, path, method, headers },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += String(chunk)));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
        },
      );
      outgoing.on("error", reject);
      if (body !== undefined) outgoing.write(body);
      outgoing.end();
    });
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ls-"));
    mkdirSync(join(dataDir, "run"), { recursive: true });
    bridgeSocket = join(dataDir, "b.sock");
    serveLines(join(dataDir, "run", "lody-oss-loro-data-plane.sock"));
    serveControl(join(dataDir, "run", "lody-oss-control.sock"));
    writeFileSync(
      join(dataDir, "workspace-catalog.json"),
      readFileSync(join(CORPUS, "catalog-full.json"), "utf8"),
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
      bridge.stderr?.on("data", (chunk) => reject(new Error(`bridge stderr: ${String(chunk)}`)));
      bridge.once("exit", (code) => reject(new Error(`bridge exited early with ${code}`)));
      setTimeout(() => reject(new Error("bridge did not report listening")), 8_000);
    });
  });

  afterAll(() => {
    bridge?.kill("SIGTERM");
    for (const server of servers) server.close();
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  });

  it("reaches every verdict the corpus names, on the real daemon socket", async () => {
    expect(decisions.frames.length).toBeGreaterThan(0);
    for (const decision of decisions.frames) {
      const socket = await openShared(decision.claim);
      const connection = dataPlaneConnections.at(-1);
      if (connection === undefined) throw new Error("the bridge opened no daemon socket");
      const back: string[] = [];
      socket.on("message", (data) => back.push(data.toString()));
      socket.send(JSON.stringify(decision.frame));
      await new Promise((resolve) => setTimeout(resolve, 150));

      const label = `${decision.claim}: ${decision.note}`;
      if (decision.verdict === "forward") {
        expect(connection.lines.map((line) => JSON.parse(line)), label).toEqual([decision.frame]);
        expect(back, label).toEqual([]);
      } else {
        // Nothing reaches the daemon either way — the difference between a drop
        // and a refusal is only what the client is told.
        expect(connection.lines, label).toEqual([]);
        if (decision.verdict === "refuse") {
          expect(back.length, label).toBe(1);
          expect(JSON.parse(back[0] ?? "{}"), label).toMatchObject({
            type: "error",
            protocolVersion: 7,
            code: "room_forbidden",
            terminal: true,
          });
        } else {
          expect(back, label).toEqual([]);
        }
      }
      socket.close();
    }
  }, 60_000);

  it("echoes what the client needs to settle its own request on a refusal", async () => {
    const socket = await openShared("ro");
    const back: string[] = [];
    socket.on("message", (data) => back.push(data.toString()));
    const join = {
      type: "join",
      protocolVersion: 7,
      requestId: "req-1",
      workspaceId: "lw_1",
      peerId: "renderer:peer-1",
      room: { scope: "doc", docId: "session-sess-zulu" },
    };
    socket.send(JSON.stringify(join));
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Without the echo the client cannot match the error to the join it is
    // still waiting on, and its room stays "connecting" forever.
    expect(JSON.parse(back[0] ?? "{}")).toMatchObject({
      requestId: "req-1",
      workspaceId: "lw_1",
      peerId: "renderer:peer-1",
      room: join.room,
    });
    socket.close();
  });

  it("leaves an unshared connection a dumb pipe", async () => {
    const socket = await openShared(null);
    const connection = dataPlaneConnections.at(-1);
    if (connection === undefined) throw new Error("the bridge opened no daemon socket");
    // Every frame the corpus refuses or drops for a share, forwarded untouched
    // for the member who owns the box.
    const frames = decisions.frames.filter((entry) => entry.verdict !== "forward");
    for (const entry of frames) socket.send(JSON.stringify(entry.frame));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(connection.lines.map((line) => JSON.parse(line))).toEqual(frames.map((entry) => entry.frame));
    socket.close();
  });

  it("scopes every HTTP door the corpus names", async () => {
    expect(decisions.requests.length).toBeGreaterThan(0);
    for (const decision of decisions.requests) {
      controlRequests.length = 0;
      const response = await bridgeHttp(
        "POST",
        decision.door,
        JSON.stringify(decision.body),
        decision.claim,
      );
      const label = `${decision.claim} ${decision.door}: ${decision.note}`;
      if (decision.allowed) {
        expect(response.status, label).toBe(200);
        expect(controlRequests.length, label).toBe(1);
      } else {
        expect(response.status, label).toBe(403);
        // Refused BEFORE the daemon, which is the whole point: the daemon has
        // no notion of a BlitzOS membership and would have run it.
        expect(controlRequests, label).toEqual([]);
        // The refusal parses as the shape each caller's own client expects, so
        // it surfaces as a refusal rather than as a transport error.
        expect(JSON.parse(response.body), label).toMatchObject({ ok: false });
      }
    }
  }, 60_000);

  it("narrows the catalog for a share and serves it whole to the owner", async () => {
    const shared = await bridgeHttp("GET", "/platform", undefined, "ro");
    expect(shared.status).toBe(200);
    expect(JSON.parse(shared.body)).toEqual(fixture("catalog-shared.json"));

    const owner = await bridgeHttp("GET", "/platform");
    expect(owner.status).toBe(200);
    expect(owner.body).toBe(readFileSync(join(CORPUS, "catalog-full.json"), "utf8"));
    // The one field the narrowing exists for: the catalog names every session
    // on the box, and "opt-in per session" means a grantee learns about the one
    // they were granted and no others.
    expect(Object.keys(JSON.parse(shared.body))).not.toContain("sessions");
    expect(Object.keys(JSON.parse(owner.body))).toContain("sessions");
  });

  it("refuses a body too large to judge rather than forwarding it unjudged", async () => {
    const oversized = JSON.stringify({
      machineId: "m",
      workspaceId: "lw_1",
      method: "code-collab/open-text",
      params: { sessionId: "sess-alpha", path: "x".repeat(2 * 1024 * 1024) },
    });
    const response = await bridgeHttp("POST", "/rpc", oversized, "ro");
    expect(response.status).toBe(413);
  });
});

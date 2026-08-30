/**
 * Bridge-side conformance for the Lody data-plane frame contract
 * (`packages/schema/fixtures/lody-data-plane/`, CLAUDE.md cross-runtime rule).
 *
 * This drives the REAL `/usr/local/libexec/blitz-lody-bridge` as a child
 * process, against a stand-in daemon that speaks the daemon's own
 * newline-delimited JSON on a real unix socket. What is under test is the one
 * thing the bridge does to a frame: translate framing. One line on the socket is
 * one WebSocket text message, and one WebSocket message is one line back —
 * across chunk boundaries the sender picks, which is where a naive
 * `chunk.toString()` splitter breaks.
 *
 * It also pins the three HTTP doors phase 2 added, because a path collapsed into
 * another would send a `session/create` to the machine-RPC plane and fail with a
 * 400 far from the cause.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const BRIDGE = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-lody-bridge", import.meta.url),
);
const CORPUS = fileURLToPath(new URL("../../../schema/fixtures/lody-data-plane/", import.meta.url));
const REPO_NODE_MODULES = fileURLToPath(new URL("../../../../node_modules", import.meta.url));

function fixture(relative: string): unknown {
  return JSON.parse(readFileSync(join(CORPUS, relative), "utf8"));
}

function fixtureNames(dir: string): string[] {
  return readdirSync(join(CORPUS, dir))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/** The daemon's side of one data-plane connection: newline-delimited JSON. */
interface DaemonConnection {
  lines: string[];
  write: (line: string) => void;
  writeRaw: (chunk: string) => void;
}

describe("blitz-lody-bridge framing", () => {
  let dataDir: string;
  let bridgeSocket: string;
  let bridge: ChildProcess;
  const servers: Server[] = [];
  const dataPlaneConnections: DaemonConnection[] = [];
  /** Every request the stand-in control socket saw, in order. */
  const controlRequests: { path: string; body: string }[] = [];

  /** `sun_path` caps a unix socket at 103 bytes and the daemon THROWS rather
   * than falling back, so the whole budget is spent on a short temp root. */
  const shortTmp = (): string => mkdtempSync(join(tmpdir(), "lb-"));

  function serveLines(path: string, onConnection: (connection: DaemonConnection) => void): void {
    const server = createServer((socket: Socket) => {
      const connection: DaemonConnection = {
        lines: [],
        write: (line) => socket.write(`${line}\n`),
        writeRaw: (chunk) => socket.write(chunk),
      };
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
      onConnection(connection);
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

  async function openBridgeSocket(): Promise<WebSocket> {
    const socket = new WebSocket(`ws+unix://${bridgeSocket}:/sync`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return socket;
  }

  function bridgeHttp(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        { socketPath: bridgeSocket, path, method, headers: { "content-type": "application/json" } },
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
    dataDir = shortTmp();
    mkdirSync(join(dataDir, "run"), { recursive: true });
    bridgeSocket = join(dataDir, "b.sock");
    serveLines(join(dataDir, "run", "lody-oss-loro-data-plane.sock"), (connection) =>
      dataPlaneConnections.push(connection),
    );
    serveControl(join(dataDir, "run", "lody-oss-control.sock"));
    writeFileSync(
      join(dataDir, "workspace-catalog.json"),
      JSON.stringify({
        version: 1,
        identity: { userId: "local:0123456789abcdef" },
        machine: { machineId: "11111111-2222-3333-4444-555555555555", machineName: "box" },
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

  it("carries every client frame to the daemon as exactly one line", async () => {
    const socket = await openBridgeSocket();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const connection = dataPlaneConnections.at(-1)!;
    const names = fixtureNames("client");
    for (const name of names) socket.send(JSON.stringify(fixture(`client/${name}`)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connection.lines.length).toBe(names.length);
    expect(connection.lines.map((line) => JSON.parse(line))).toEqual(
      names.map((name) => fixture(`client/${name}`)),
    );
    socket.close();
  });

  it("carries every daemon line back as exactly one WebSocket message", async () => {
    const socket = await openBridgeSocket();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const connection = dataPlaneConnections.at(-1)!;
    const received: string[] = [];
    socket.on("message", (data) => received.push(data.toString()));

    const names = fixtureNames("server").filter((name) => name !== "doc-update-chunked.json");
    for (const name of names) connection.write(JSON.stringify(fixture(`server/${name}`)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received.length).toBe(names.length);
    expect(received.map((raw) => JSON.parse(raw))).toEqual(
      names.map((name) => fixture(`server/${name}`)),
    );
    socket.close();
  });

  it("reframes regardless of where the daemon's chunk boundaries fall", async () => {
    const socket = await openBridgeSocket();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const connection = dataPlaneConnections.at(-1)!;
    const received: string[] = [];
    socket.on("message", (data) => received.push(data.toString()));

    const first = JSON.stringify(fixture("server/pong.json"));
    const second = JSON.stringify(fixture("server/presence.json"));
    // Two whole frames in one write, then one frame split mid-token across
    // three writes. A splitter that decoded per chunk would emit one message,
    // three, or a mangled one — never exactly these three.
    connection.writeRaw(`${first}\n${second}\n`);
    const third = JSON.stringify(fixture("server/joined-doc.json"));
    connection.writeRaw(third.slice(0, 17));
    await new Promise((resolve) => setTimeout(resolve, 60));
    connection.writeRaw(third.slice(17, 40));
    await new Promise((resolve) => setTimeout(resolve, 60));
    connection.writeRaw(`${third.slice(40)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toEqual([first, second, third]);
    socket.close();
  });

  it("routes the three POST planes to three distinct daemon paths", async () => {
    controlRequests.length = 0;
    const rpc = await bridgeHttp("POST", "/rpc", '{"method":"session/terminate"}');
    const control = await bridgeHttp("POST", "/control", '{"type":"machine/status"}');
    const project = await bridgeHttp("POST", "/project", '{"type":"local-project/list"}');
    expect([rpc.status, control.status, project.status]).toEqual([200, 200, 200]);
    expect(controlRequests).toEqual([
      { path: "/machine-rpc", body: '{"method":"session/terminate"}' },
      { path: "/session-control", body: '{"type":"machine/status"}' },
      { path: "/project-control", body: '{"type":"local-project/list"}' },
    ]);
  });

  it("serves the daemon's catalog byte-for-byte on /platform", async () => {
    const response = await bridgeHttp("GET", "/platform");
    expect(response.status).toBe(200);
    expect(response.body).toBe(readFileSync(join(dataDir, "workspace-catalog.json"), "utf8"));
  });

  it("answers 404 for anything else", async () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/control"],
      ["POST", "/platform"],
      ["POST", "/sync"],
    ] as const) {
      const response = await bridgeHttp(method, path);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

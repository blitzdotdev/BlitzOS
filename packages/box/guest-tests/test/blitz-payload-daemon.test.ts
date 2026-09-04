import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** End-to-end daemon activation tests. The real updater downloads real tar
 * archives from a stand-in control plane, asks a stand-in Lody daemon over a
 * unix socket, and drives fake s6 commands whose PID file makes restart
 * replacement observable. */

const updater = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-payload", import.meta.url),
);
const BAKED_PAYLOAD_VERSION = "baked-payload-v1";
const BAKED_DAEMON_VERSION = "0.88.1+blitz.3";

interface Archive {
  body: Buffer;
  sha256: string;
  bytes: number;
}

interface PayloadResult {
  version: string;
  daemonVersion: string;
  outcome: string;
  detail: string;
}

interface PayloadState {
  current: string;
  daemonVersion: string;
  daemonProtocolVersion: number | null;
  previousDaemonProtocolVersion?: number | null;
}

interface RunResult {
  status: number | null;
  stderr: string;
  elapsedMs: number;
}

interface DaemonOptions {
  activeCounts?: number[];
  controlSocket?: boolean;
  failNewDaemonHealth?: boolean;
}

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function archive(directory: string, outputName: string, entries: string[]): Archive {
  const output = path.join(directory, outputName);
  execFileSync("tar", ["-C", directory, "-czf", output, ...entries]);
  const body = readFileSync(output);
  return { body, sha256: sha256(body), bytes: body.length };
}

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function sendJson(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function listenTcp(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: the callback runs only after a TCP bind, so this is neither a
      // unix socket name nor null.
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function listenUnix(server: Server, socketPath: string): Promise<void> {
  servers.push(server);
  mkdirSync(path.dirname(socketPath), { recursive: true });
  return new Promise((resolve) => server.listen(socketPath, resolve));
}

class DaemonHarness {
  readonly root = temporaryDirectory("blitz-payload-daemon-");
  readonly payloadRoot = path.join(this.root, "opt/payload");
  readonly payloadState = path.join(this.root, "state/payload");
  readonly lodyRoot = path.join(this.root, "opt/lody");
  readonly originFile = path.join(this.root, "state/origin");
  readonly serviceRoot = path.join(this.root, "run/service");
  readonly bin = path.join(this.root, "bin");
  readonly s6Log = path.join(this.root, "s6.log");
  readonly pidFile = path.join(this.root, "daemon.pid");
  readonly daemonSocket = path.join(this.root, "run/lody-probe.sock");
  readonly missingControlSocket = path.join(this.root, "run/missing-control.sock");
  readonly results: PayloadResult[] = [];
  readonly stateRequestsAt: number[] = [];
  readonly payloadArchive: Archive;
  readonly daemonArchive: Archive;
  readonly options: DaemonOptions;
  origin = "";

  constructor(options: DaemonOptions = {}) {
    this.options = options;
    const bakedPayload = path.join(this.payloadRoot, "baked/rootfs/usr/local/bin");
    mkdirSync(bakedPayload, { recursive: true });
    writeFileSync(path.join(bakedPayload, "tool"), "old\n", { mode: 0o755 });
    writeFileSync(path.join(this.payloadRoot, "baked/payload-version"), `${BAKED_PAYLOAD_VERSION}\n`);
    const bakedDaemon = path.join(this.lodyRoot, "baked");
    mkdirSync(path.join(bakedDaemon, "bin"), { recursive: true });
    mkdirSync(path.join(bakedDaemon, "lib/node_modules/lody"), { recursive: true });
    writeFileSync(path.join(bakedDaemon, "bin/lody"), "baked\n", { mode: 0o755 });
    writeFileSync(path.join(bakedDaemon, "lib/node_modules/lody/package.json"), "{}\n");
    writeFileSync(path.join(bakedDaemon, "daemon-version"), `${BAKED_DAEMON_VERSION}\n`);
    writeFileSync(path.join(bakedDaemon, "daemon-protocol-version"), "7\n");
    symlinkSync("baked", path.join(this.payloadRoot, "current"));
    symlinkSync("baked", path.join(this.lodyRoot, "current"));
    mkdirSync(this.payloadState, { recursive: true });
    mkdirSync(this.serviceRoot, { recursive: true });
    mkdirSync(this.bin, { recursive: true });

    const payloadBuild = temporaryDirectory("blitz-payload-daemon-payload-");
    const payloadFile = path.join(payloadBuild, "rootfs/usr/local/bin/tool");
    mkdirSync(path.dirname(payloadFile), { recursive: true });
    writeFileSync(payloadFile, "new\n", { mode: 0o755 });
    writeFileSync(path.join(payloadBuild, "payload-version"), "v2\n");
    this.payloadArchive = archive(payloadBuild, "payload.tar.gz", ["payload-version", "rootfs"]);

    const daemonBuild = temporaryDirectory("blitz-payload-daemon-archive-");
    mkdirSync(path.join(daemonBuild, "bin"), { recursive: true });
    mkdirSync(path.join(daemonBuild, "lib/node_modules/lody"), { recursive: true });
    writeFileSync(path.join(daemonBuild, "bin/lody"), "new daemon\n", { mode: 0o755 });
    writeFileSync(path.join(daemonBuild, "lib/node_modules/lody/package.json"), "{}\n");
    writeFileSync(path.join(daemonBuild, "daemon-version"), "daemon-v2\n");
    writeFileSync(path.join(daemonBuild, "daemon-protocol-version"), "7\n");
    this.daemonArchive = archive(daemonBuild, "daemon.tar.gz", [
      "bin", "daemon-protocol-version", "daemon-version", "lib",
    ]);

    writeExecutable(path.join(this.bin, "blitz-cred"), "#!/bin/sh\nprintf 'machine-bearer\\n'\n");
    writeExecutable(
      path.join(this.bin, "s6-svstat"),
      "#!/bin/sh\ncat \"$BLITZ_TEST_DAEMON_PID\"\n",
    );
    writeExecutable(
      path.join(this.bin, "s6-svc"),
      "#!/bin/sh\n"
        + "printf '%s\\n' \"$*\" >>\"$BLITZ_TEST_S6_LOG\"\n"
        + "if [ \"$1\" = -r ] && [ \"${BLITZ_TEST_DAEMON_STUCK:-0}\" != 1 ]; then\n"
        + "  pid=$(cat \"$BLITZ_TEST_DAEMON_PID\")\n"
        + "  printf '%s\\n' \"$((pid + 1))\" >\"$BLITZ_TEST_DAEMON_PID\"\n"
        + "fi\n"
        + "if [ \"$1\" = -k ]; then printf '999\\n' >\"$BLITZ_TEST_DAEMON_PID\"; fi\n",
    );
    writeFileSync(this.pidFile, "100\n");
  }

  async start(): Promise<void> {
    this.origin = await listenTcp(createServer((request, response) => {
      this.handleControlPlane(request, response);
    }));
    mkdirSync(path.dirname(this.originFile), { recursive: true });
    writeFileSync(this.originFile, `${this.origin}\n`);
    const counts = this.options.activeCounts ?? [0];
    let requestIndex = 0;
    const daemon = createServer((request, response) => {
      if (request.url === "/state") {
        expect(request.headers["x-lody-local-control"]).toBe("1");
        this.stateRequestsAt.push(Date.now());
        const count = counts[Math.min(requestIndex, counts.length - 1)] ?? 0;
        requestIndex += 1;
        sendJson(response, 200, {
          activeSessionCount: count,
          sessions: Array.from({ length: count }, (_item, index) => ({
            sessionId: `session-${index}`,
            status: { type: "running" },
          })),
        });
        return;
      }
      if (request.url === "/healthz") {
        if (this.options.failNewDaemonHealth === true && this.currentDaemon() === "daemon-v2") {
          return;
        }
        response.writeHead(200);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await listenUnix(daemon, this.daemonSocket);
  }

  private handleControlPlane(request: IncomingMessage, response: ServerResponse): void {
    if (request.url === "/healthz") {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.url === "/workspaces/self/box-config") {
      sendJson(response, 200, {
        payload: { version: "v2", manifestUrl: `${this.origin}/manifest.json` },
      });
      return;
    }
    if (request.url === "/manifest.json") {
      sendJson(response, 200, {
        version: "v2",
        createdAt: 1,
        minUpdater: 1,
        files: [{
          path: "rootfs/usr/local/bin/tool",
          sha256: sha256("new\n"),
          mode: "0755",
        }],
        archive: {
          url: `${this.origin}/payload.tar.gz`,
          sha256: this.payloadArchive.sha256,
          bytes: this.payloadArchive.bytes,
        },
        daemon: {
          version: "daemon-v2",
          protocolVersion: 7,
          url: `${this.origin}/daemon.tar.gz`,
          sha256: this.daemonArchive.sha256,
          bytes: this.daemonArchive.bytes,
        },
        restart: {},
      });
      return;
    }
    if (request.url === "/payload.tar.gz") {
      response.writeHead(200);
      response.end(this.payloadArchive.body);
      return;
    }
    if (request.url === "/daemon.tar.gz") {
      response.writeHead(200);
      response.end(this.daemonArchive.body);
      return;
    }
    if (request.url === "/workspaces/self/payload-result" && request.method === "POST") {
      let source = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { source += chunk; });
      request.on("end", () => {
        // SAFETY: the real updater is the sole producer and the assertions on
        // every result below validate the fields consumed by this harness.
        this.results.push(JSON.parse(source) as PayloadResult);
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  }

  environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
      BLITZ_PAYLOAD_ROOT: this.payloadRoot,
      BLITZ_PAYLOAD_STATE: this.payloadState,
      BLITZ_PAYLOAD_LODY_ROOT: this.lodyRoot,
      BLITZ_PAYLOAD_ORIGIN_FILE: this.originFile,
      BLITZ_PAYLOAD_SERVICE_ROOT: this.serviceRoot,
      BLITZ_PAYLOAD_S6_SVC: path.join(this.bin, "s6-svc"),
      BLITZ_PAYLOAD_S6_SVSTAT: path.join(this.bin, "s6-svstat"),
      BLITZ_PAYLOAD_GATEWAY_HEALTH_URL: `${this.origin}/healthz`,
      BLITZ_PAYLOAD_DAEMON_SOCKET: this.daemonSocket,
      BLITZ_PAYLOAD_DAEMON_CONTROL_SOCKET: this.options.controlSocket === false
        ? this.missingControlSocket
        : this.daemonSocket,
      BLITZ_PAYLOAD_DAEMON_CGROUP_ROOT: path.join(this.root, "cgroups"),
      BLITZ_PAYLOAD_DAEMON_IDLE_WAIT: "0.12",
      BLITZ_PAYLOAD_DAEMON_IDLE_POLL: "0.015",
      BLITZ_PAYLOAD_DAEMON_IDLE_PROBE_TIMEOUT: "0.03",
      BLITZ_PAYLOAD_DAEMON_KILL_GRACE: "0.06",
      BLITZ_PAYLOAD_DAEMON_KILL_POLL: "0.01",
      BLITZ_PAYLOAD_HEALTH_TIMEOUT: "0.09",
      BLITZ_PAYLOAD_HEALTH_INTERVAL: "0.01",
      BLITZ_PAYLOAD_REQUEST_TIMEOUT: "0.25",
      BLITZ_PAYLOAD_ONCE: "1",
      BLITZ_TEST_DAEMON_PID: this.pidFile,
      BLITZ_TEST_S6_LOG: this.s6Log,
      ...overrides,
    };
  }

  currentDaemon(): string {
    return path.basename(realpathSync(path.join(this.lodyRoot, "current")));
  }

  state(): PayloadState {
    // SAFETY: blitz-payload writes this file before it posts the result that
    // each test awaits; PayloadState names exactly the asserted subset.
    return JSON.parse(
      readFileSync(path.join(this.payloadState, "state.json"), "utf8"),
    ) as PayloadState;
  }

  calls(): string[] {
    if (!existsSync(this.s6Log)) return [];
    return readFileSync(this.s6Log, "utf8").trim().split("\n").filter(Boolean);
  }
}

function runUpdater(harness: DaemonHarness, overrides: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [updater], { env: harness.environment(overrides) });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`blitz-payload timed out: ${stderr}`));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function apply(harness: DaemonHarness, overrides: NodeJS.ProcessEnv = {}): Promise<PayloadResult> {
  await harness.start();
  const run = await runUpdater(harness, overrides);
  expect(run.status, run.stderr).toBe(0);
  const result = harness.results.at(-1);
  if (result === undefined) throw new Error("updater did not report a payload result");
  return result;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blitz-payload daemon activation", () => {
  it("restarts immediately when every session is idle", async () => {
    const harness = new DaemonHarness({ activeCounts: [0] });

    const result = await apply(harness);

    expect(result).toMatchObject({ outcome: "applied", daemonVersion: "daemon-v2" });
    expect(result.detail).toContain("restarted with 0 sessions running after 0s wait");
    expect(result.detail).toContain("daemon protocol 7");
    expect(harness.state()).toMatchObject({ daemonProtocolVersion: 7 });
  });

  it("polls every interval and restarts when a busy session becomes idle", async () => {
    const harness = new DaemonHarness({ activeCounts: [1, 1, 1, 0] });

    const result = await apply(harness);

    expect(result.outcome).toBe("applied");
    expect(result.detail).toContain("restarted with 0 sessions running after 0.045s wait");
    expect(harness.stateRequestsAt).toHaveLength(4);
    const firstRequestAt = harness.stateRequestsAt[0];
    const lastRequestAt = harness.stateRequestsAt[3];
    if (firstRequestAt === undefined || lastRequestAt === undefined) {
      throw new Error("idle polling did not make four state requests");
    }
    expect(lastRequestAt - firstRequestAt).toBeGreaterThanOrEqual(35);
  });

  it("restarts with the running-session count when the idle cap expires", async () => {
    const harness = new DaemonHarness({ activeCounts: [2] });

    const result = await apply(harness, { BLITZ_PAYLOAD_DAEMON_IDLE_WAIT: "0.045" });

    expect(result.outcome).toBe("applied");
    expect(result.detail).toContain("restarted with 2 sessions running after 0.045s wait");
    expect(harness.stateRequestsAt).toHaveLength(4);
  });

  it("rolls back only the daemon when its replacement never answers the probe", async () => {
    const harness = new DaemonHarness({ activeCounts: [0], failNewDaemonHealth: true });

    const result = await apply(harness);

    expect(result.outcome).toBe("rolled-back");
    expect(result.detail).toContain("daemon health check failed");
    expect(result.detail).toContain("daemon protocol 7 rolled back; payload kept");
    expect(readFileSync(path.join(harness.payloadRoot, "current/rootfs/usr/local/bin/tool"), "utf8"))
      .toBe("new\n");
    expect(harness.currentDaemon()).toBe("baked");
    expect(harness.state()).toMatchObject({
      current: "v2",
      daemonVersion: BAKED_DAEMON_VERSION,
      daemonProtocolVersion: 7,
      previousDaemonProtocolVersion: 7,
    });
  });

  it("treats an absent control socket as idle", async () => {
    const harness = new DaemonHarness({ activeCounts: [3], controlSocket: false });

    const result = await apply(harness);

    expect(result.outcome).toBe("applied");
    expect(result.detail).toContain("restarted with 0 sessions running after 0s wait");
    expect(harness.stateRequestsAt).toEqual([]);
  });

  it("escalates to SIGKILL when the supervised daemon PID does not change", async () => {
    const harness = new DaemonHarness({ activeCounts: [0] });

    const result = await apply(harness, { BLITZ_TEST_DAEMON_STUCK: "1" });

    expect(result.outcome).toBe("applied");
    expect(harness.calls()).toEqual([
      `-r ${path.join(harness.serviceRoot, "lody-daemon")}`,
      `-k ${path.join(harness.serviceRoot, "lody-daemon")}`,
    ]);
  });
});

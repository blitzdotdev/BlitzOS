import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
const serviceTreeSource = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d", import.meta.url),
);
const deferredFixture = fileURLToPath(
  new URL(
    "../../../schema/fixtures/box-payload/payload-result/valid/deferred.json",
    import.meta.url,
  ),
);
const BAKED_PAYLOAD_VERSION = "baked-payload-v1";
const BAKED_DAEMON_VERSION = "0.88.1+blitz.3";

interface Archive {
  body: Buffer;
  sha256: string;
  bytes: number;
}

interface PayloadFile {
  path: string;
  sha256: string;
  mode: string;
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
  deferred?: { version: string; daemonVersion: string; readyAt: number };
  failed?: { version: string; outcome: string; at: number };
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

function regularFiles(root: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...regularFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
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
  readonly payloadState = path.join(this.payloadRoot, "state");
  readonly payloadVersions = path.join(this.payloadRoot, "versions");
  readonly lodyRoot = path.join(this.root, "opt/lody");
  readonly originFile = path.join(this.root, "state/origin");
  readonly featuresFile = path.join(this.payloadState, "features");
  readonly featuresAppliedFile = path.join(this.payloadState, "features.applied");
  readonly serviceRoot = path.join(this.root, "run/service");
  readonly bin = path.join(this.root, "bin");
  readonly s6Log = path.join(this.root, "s6.log");
  readonly pidFile = path.join(this.root, "daemon.pid");
  readonly daemonSocket = path.join(this.root, "run/lody-probe.sock");
  readonly missingControlSocket = path.join(this.root, "run/missing-control.sock");
  readonly s6DbRoot = path.join(this.root, "run/s6");
  readonly s6LiveCompiled = path.join(this.root, "run/s6-rc/compiled");
  readonly s6SourcesRoot = path.join(this.root, "package/admin");
  readonly lockPath = path.join(this.root, "run/blitz-payload.lock");
  readonly results: PayloadResult[] = [];
  readonly requests: string[] = [];
  readonly stateRequestsAt: number[] = [];
  readonly payloadArchive: Archive;
  readonly payloadFiles: PayloadFile[];
  readonly daemonArchive: Archive;
  readonly options: DaemonOptions;
  origin = "";
  pinVersion = "v2";

  constructor(options: DaemonOptions = {}) {
    this.options = options;
    const bakedRoot = path.join(this.payloadRoot, "baked");
    const bakedPayload = path.join(bakedRoot, "rootfs/usr/local/bin");
    mkdirSync(bakedPayload, { recursive: true });
    writeFileSync(path.join(bakedPayload, "tool"), "old\n", { mode: 0o755 });
    cpSync(
      serviceTreeSource,
      path.join(bakedRoot, "rootfs/etc/s6-overlay/s6-rc.d"),
      { recursive: true },
    );
    mkdirSync(
      path.join(bakedRoot, "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"),
      { recursive: true },
    );
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
    // Feature behavior has its own harness; keep daemon cases on unchanged defaults.
    writeFileSync(this.featuresFile, "BLITZ_LODY_SESSIONS=0\n", { mode: 0o644 });
    writeFileSync(this.featuresAppliedFile, "BLITZ_LODY_SESSIONS=0\n", { mode: 0o644 });
    mkdirSync(this.serviceRoot, { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(path.join(this.s6SourcesRoot, "s6-overlay-3.2.1.0/etc/s6-rc/sources"), {
      recursive: true,
    });
    mkdirSync(path.join(this.s6DbRoot, "db"), { recursive: true });
    mkdirSync(path.dirname(this.s6LiveCompiled), { recursive: true });
    symlinkSync(path.join(this.s6DbRoot, "db"), this.s6LiveCompiled);

    const payloadBuild = temporaryDirectory("blitz-payload-daemon-payload-");
    cpSync(
      serviceTreeSource,
      path.join(payloadBuild, "rootfs/etc/s6-overlay/s6-rc.d"),
      { recursive: true },
    );
    mkdirSync(
      path.join(payloadBuild, "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"),
      { recursive: true },
    );
    const payloadFile = path.join(payloadBuild, "rootfs/usr/local/bin/tool");
    mkdirSync(path.dirname(payloadFile), { recursive: true });
    writeFileSync(payloadFile, "new\n", { mode: 0o755 });
    writeFileSync(path.join(payloadBuild, "payload-version"), "v2\n");
    this.payloadFiles = regularFiles(path.join(payloadBuild, "rootfs")).sort().map((relative) => {
      const filePath = path.join(payloadBuild, "rootfs", relative);
      return {
        path: `rootfs/${relative}`,
        sha256: sha256(readFileSync(filePath)),
        mode: (statSync(filePath).mode & 0o7777).toString(8).padStart(4, "0"),
      };
    });
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
      "#!/bin/sh\nprintf 'true %s\\n' \"$(cat \"$BLITZ_TEST_DAEMON_PID\")\"\n",
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
    writeExecutable(
      path.join(this.bin, "s6-rc-compile"),
      "#!/bin/sh\nmkdir -p \"$2\"\n",
    );
    writeExecutable(
      path.join(this.bin, "s6-rc-update"),
      "#!/bin/sh\ndatabase=\nfor argument do database=$argument; done\n"
        + "[ -d \"$database\" ] || exit 1\n"
        + "temporary=\"$BLITZ_TEST_S6_LIVE_COMPILED.new-$$\"\n"
        + "rm -f \"$temporary\"\nln -s \"$database\" \"$temporary\"\n"
        + "rm -f \"$BLITZ_TEST_S6_LIVE_COMPILED\"\n"
        + "mv \"$temporary\" \"$BLITZ_TEST_S6_LIVE_COMPILED\"\n",
    );
    writeExecutable(path.join(this.bin, "s6-rc"), "#!/bin/sh\nexit 0\n");
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
    this.requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    if (request.url === "/healthz") {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.url === "/workspaces/self/box-config") {
      sendJson(response, 200, {
        payload: { version: this.pinVersion, manifestUrl: `${this.origin}/manifest.json` },
      });
      return;
    }
    if (request.url === "/manifest.json") {
      sendJson(response, 200, {
        version: "v2",
        createdAt: 1,
        minUpdater: 2,
        files: this.payloadFiles,
        directories: ["rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"],
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
    if (request.url === "/workspaces/self/machine-stats" && request.method === "POST") {
      request.resume();
      request.on("end", () => response.writeHead(204).end());
      return;
    }
    response.writeHead(404);
    response.end();
  }

  environment(
    testOverrides: Record<string, unknown> = {},
    environmentOverrides: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
      BLITZ_STATE_DIR: path.join(this.root, "state"),
      BLITZ_PAYLOAD_DAEMON_IDLE_WAIT: "0.12",
      BLITZ_PAYLOAD_TEST_CONFIG: JSON.stringify({
        payloadRoot: this.payloadRoot,
        lodyRoot: this.lodyRoot,
        serviceRoot: this.serviceRoot,
        s6Svc: path.join(this.bin, "s6-svc"),
        s6Svstat: path.join(this.bin, "s6-svstat"),
        s6RcCompile: path.join(this.bin, "s6-rc-compile"),
        s6RcUpdate: path.join(this.bin, "s6-rc-update"),
        s6Rc: path.join(this.bin, "s6-rc"),
        s6SourcesRoot: this.s6SourcesRoot,
        s6DbRoot: this.s6DbRoot,
        s6LiveCompiled: this.s6LiveCompiled,
        lockPath: this.lockPath,
        payloadState: this.payloadState,
        payloadVersions: this.payloadVersions,
        featuresFile: this.featuresFile,
        featuresAppliedFile: this.featuresAppliedFile,
        featuresOwnerUid: process.getuid?.() ?? 0,
        featuresOwnerGid: process.getgid?.() ?? 0,
        credentialCommand: [path.join(this.bin, "blitz-cred"), "api-token"],
        gatewayHealthUrl: `${this.origin}/healthz`,
        daemonSocket: this.daemonSocket,
        daemonControlSocket: this.options.controlSocket === false
          ? this.missingControlSocket
          : this.daemonSocket,
        daemonIdlePollMs: 15,
        daemonIdleProbeTimeoutMs: 30,
        daemonKillGraceMs: 60,
        daemonKillPollMs: 10,
        serviceRestartTimeoutMs: 100,
        serviceRestartPollMs: 10,
        healthTimeoutMs: 2000,
        healthIntervalMs: 10,
        requestTimeoutMs: 1000,
        ...testOverrides,
      }),
      BLITZ_PAYLOAD_ONCE: "1",
      BLITZ_TEST_DAEMON_PID: this.pidFile,
      BLITZ_TEST_S6_LOG: this.s6Log,
      BLITZ_TEST_S6_LIVE_COMPILED: this.s6LiveCompiled,
      ...environmentOverrides,
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

function runUpdater(
  harness: DaemonHarness,
  testOverrides: Record<string, string | number | null> = {},
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [updater], {
      env: harness.environment(testOverrides, environmentOverrides),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`blitz-payload timed out: ${stderr}`));
    }, 10_000);
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

async function apply(
  harness: DaemonHarness,
  testOverrides: Record<string, string | number | null> = {},
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<PayloadResult> {
  await harness.start();
  const run = await runUpdater(harness, testOverrides, environmentOverrides);
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
  it("activates an idle protocol 2 daemon release immediately", async () => {
    const harness = new DaemonHarness({ activeCounts: [0] });

    const result = await apply(harness);

    expect(result).toMatchObject({ outcome: "applied", daemonVersion: "daemon-v2" });
    expect(result.detail).toContain("daemon restarted at idle after");
    expect(result.detail).toContain("daemon protocol 7");
    expect(harness.state()).toMatchObject({ daemonProtocolVersion: 7 });
  });

  it("defers across three busy ticks and switches the whole release on the idle tick", async () => {
    const harness = new DaemonHarness({ activeCounts: [1, 1, 1, 0] });
    await harness.start();
    // SAFETY: this checked-in fixture is parsed only for the four string fields
    // asserted immediately below.
    const fixture = JSON.parse(readFileSync(deferredFixture, "utf8")) as PayloadResult;
    let readyAt: number | undefined;

    for (let tick = 0; tick < 3; tick += 1) {
      const run = await runUpdater(harness, { daemonIdleWaitMs: 60_000 });
      expect(run.status, run.stderr).toBe(0);
      const result = harness.results.at(-1);
      expect(result).toMatchObject({
        version: fixture.version,
        daemonVersion: fixture.daemonVersion,
        outcome: fixture.outcome,
      });
      expect(result?.detail).toContain("whole-release activation deferred with 1 active turn");
      expect(harness.currentDaemon()).toBe("baked");
      expect(readFileSync(
        path.join(harness.payloadRoot, "current/rootfs/usr/local/bin/tool"),
        "utf8",
      )).toBe("old\n");
      expect(harness.calls()).toEqual([]);
      const deferred = harness.state().deferred;
      expect(deferred).toMatchObject({ version: "v2", daemonVersion: "daemon-v2" });
      if (readyAt === undefined) readyAt = deferred?.readyAt;
      else expect(deferred?.readyAt).toBe(readyAt);
    }

    const idleRun = await runUpdater(harness, { daemonIdleWaitMs: 60_000 });
    expect(idleRun.status, idleRun.stderr).toBe(0);
    const result = harness.results.at(-1);

    expect(result?.outcome).toBe("applied");
    expect(result?.detail).toContain("daemon restarted at idle after");
    expect(harness.currentDaemon()).toBe("daemon-v2");
    expect(readFileSync(
      path.join(harness.payloadRoot, "current/rootfs/usr/local/bin/tool"),
      "utf8",
    )).toBe("new\n");
    expect(harness.state().deferred).toBeUndefined();
    expect(harness.stateRequestsAt).toHaveLength(4);
    expect(harness.requests.filter((entry) => entry === "GET /payload.tar.gz")).toHaveLength(1);
    expect(harness.requests.filter((entry) => entry === "GET /daemon.tar.gz")).toHaveLength(1);
  });

  it("forces activation with explicit detail when a busy release passes the cap", async () => {
    const harness = new DaemonHarness({ activeCounts: [2] });
    await harness.start();
    const deferredRun = await runUpdater(harness, { daemonIdleWaitMs: 60_000 });
    expect(deferredRun.status, deferredRun.stderr).toBe(0);
    expect(harness.results.at(-1)?.outcome).toBe("deferred");
    expect(harness.currentDaemon()).toBe("baked");
    const state = harness.state();
    if (state.deferred === undefined) throw new Error("release was not persisted as deferred");
    state.deferred.readyAt = Date.now() - 100;
    writeFileSync(
      path.join(harness.payloadState, "state.json"),
      `${JSON.stringify(state)}\n`,
    );

    const forcedRun = await runUpdater(harness, { daemonIdleWaitMs: 45 });
    expect(forcedRun.status, forcedRun.stderr).toBe(0);
    const result = harness.results.at(-1);

    expect(result?.outcome).toBe("applied");
    expect(result?.detail).toContain("forced daemon restart with 2 active turns");
    expect(result?.detail).toContain("idle-wait cap reached");
    expect(result?.detail).toContain("agent_disconnected");
    expect(forcedRun.elapsedMs).toBeLessThan(1000);
    expect(harness.currentDaemon()).toBe("daemon-v2");
    expect(harness.stateRequestsAt).toHaveLength(2);
  });

  it("drops a deferred release and evaluates a changed pin immediately", async () => {
    const harness = new DaemonHarness({ activeCounts: [1, 0] });
    await harness.start();
    const first = await runUpdater(harness, { daemonIdleWaitMs: 60_000 });
    expect(first.status, first.stderr).toBe(0);
    expect(harness.results.at(-1)?.outcome).toBe("deferred");
    expect(harness.state().deferred?.version).toBe("v2");

    harness.pinVersion = "v3";
    const changed = await runUpdater(harness, { daemonIdleWaitMs: 60_000 });
    expect(changed.status, changed.stderr).toBe(0);

    expect(harness.results.at(-1)).toMatchObject({
      version: BAKED_PAYLOAD_VERSION,
      daemonVersion: BAKED_DAEMON_VERSION,
      outcome: "verify-failed",
    });
    expect(harness.results.at(-1)?.detail).toContain("attempted v3; manifest version does not match pin");
    expect(harness.state().deferred).toBeUndefined();
    expect(harness.currentDaemon()).toBe("baked");
    expect(harness.calls()).toEqual([]);
    expect(harness.requests.filter((entry) => entry === "GET /manifest.json")).toHaveLength(2);
    expect(existsSync(path.join(harness.payloadVersions, "v2"))).toBe(false);
  });

  it("rolls payload and daemon back as one unit and suppresses the failed pin", async () => {
    const harness = new DaemonHarness({ activeCounts: [0], failNewDaemonHealth: true });

    const result = await apply(harness);

    expect(result).toMatchObject({
      version: BAKED_PAYLOAD_VERSION,
      daemonVersion: BAKED_DAEMON_VERSION,
      outcome: "rolled-back",
    });
    expect(result.detail).toContain("attempted v2; daemon health check failed");
    expect(result.detail).toContain("previous payload restored");
    expect(readFileSync(path.join(harness.payloadRoot, "current/rootfs/usr/local/bin/tool"), "utf8"))
      .toBe("old\n");
    expect(harness.currentDaemon()).toBe("baked");
    expect(harness.state()).toMatchObject({
      current: BAKED_PAYLOAD_VERSION,
      daemonVersion: BAKED_DAEMON_VERSION,
      daemonProtocolVersion: 7,
      failed: { version: "v2", outcome: "rolled-back" },
    });

    const failed = harness.state().failed;
    const manifestRequests = harness.requests.filter((entry) => entry === "GET /manifest.json");
    const second = await runUpdater(harness);
    expect(second.status, second.stderr).toBe(0);
    expect(harness.requests.filter((entry) => entry === "GET /manifest.json"))
      .toHaveLength(manifestRequests.length);
    expect(harness.results.filter((entry) => entry.outcome === "rolled-back")).toHaveLength(1);
    expect(harness.state().failed).toEqual(failed);
  });

  it("treats an absent control socket as idle", async () => {
    const harness = new DaemonHarness({ activeCounts: [3], controlSocket: false });

    const result = await apply(harness);

    expect(result.outcome).toBe("applied");
    expect(result.detail).toContain("daemon restarted at idle after");
    expect(harness.stateRequestsAt).toEqual([]);
  });

  it("escalates to SIGKILL when the supervised daemon PID does not change", async () => {
    const harness = new DaemonHarness({ activeCounts: [0] });

    const result = await apply(harness, {}, { BLITZ_TEST_DAEMON_STUCK: "1" });

    expect(result.outcome).toBe("applied");
    expect(harness.calls()).toEqual([
      `-r ${path.join(harness.serviceRoot, "lody-daemon")}`,
      `-k ${path.join(harness.serviceRoot, "lody-daemon")}`,
    ]);
  });
});

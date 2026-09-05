import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Drives the real updater against a stand-in plane and real tar archives. */
const updater = fileURLToPath(new URL("../../rootfs/usr/local/libexec/blitz-payload", import.meta.url));
const BAKED_PAYLOAD_VERSION = "baked-payload-v1", BAKED_DAEMON_VERSION = "0.88.1+blitz.3";

interface PayloadFile {
  path: string;
  sha256: string;
  mode: string;
}

interface ArchiveSpec {
  body: Buffer;
  sha256: string;
  bytes: number;
}

interface TestRelease {
  version: string;
  files: PayloadFile[];
  archive: ArchiveSpec;
  restart: Record<string, string[]>;
  minUpdater: number;
  daemon?: ArchiveSpec & { version: string; protocolVersion: number };
}

interface PayloadResult {
  version: string;
  daemonVersion: string;
  outcome: string;
  detail: string;
}

interface FailedPayloadState {
  version: string;
  outcome: string;
  at: number;
}

interface PayloadState {
  current: string;
  daemonVersion: string;
  failed?: FailedPayloadState;
  unsentResult?: PayloadResult;
}

interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  elapsedMs: number;
}

interface HarnessOptions {
  release?: TestRelease;
  pinVersion?: string | null;
  configStatus?: number;
  manifestStatus?: number;
  expectedToken?: string;
  health?: (currentTarget: string) => boolean;
  oversizedConfig?: boolean;
  resultStatus?: number;
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

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function makePayloadArchive(
  files: Array<{ path: string; content: string; mode?: number }>,
  version = "v2",
): TestRelease {
  const build = temporaryDirectory("blitz-payload-archive-");
  const manifestFiles: PayloadFile[] = [];
  for (const file of files) {
    const target = path.join(build, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, { mode: file.mode ?? 0o755 });
    chmodSync(target, file.mode ?? 0o755);
    manifestFiles.push({
      path: file.path,
      sha256: sha256(file.content),
      mode: (file.mode ?? 0o755).toString(8).padStart(4, "0"),
    });
  }
  writeFileSync(path.join(build, "payload-version"), `${version}\n`);
  const archivePath = path.join(build, "payload.tar.gz");
  execFileSync("tar", ["-C", build, "-czf", archivePath, "payload-version", "rootfs"]);
  const body = readFileSync(archivePath);
  return {
    version,
    files: manifestFiles,
    archive: { body, sha256: sha256(body), bytes: body.length },
    restart: { gateway: manifestFiles.map((file) => file.path) },
    minUpdater: 1,
  };
}

function addDaemon(release: TestRelease, daemonVersion = "daemon-v2"): TestRelease {
  const build = temporaryDirectory("blitz-daemon-archive-");
  mkdirSync(path.join(build, "bin"), { recursive: true });
  mkdirSync(path.join(build, "lib/node_modules/lody"), { recursive: true });
  writeFileSync(path.join(build, "bin/lody"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(build, "lib/node_modules/lody/package.json"), "{}\n");
  writeFileSync(path.join(build, "daemon-version"), `${daemonVersion}\n`);
  writeFileSync(path.join(build, "daemon-protocol-version"), "7\n");
  const archivePath = path.join(build, "daemon.tar.gz");
  execFileSync("tar", [
    "-C", build, "-czf", archivePath,
    "bin", "daemon-protocol-version", "daemon-version", "lib",
  ]);
  const body = readFileSync(archivePath);
  return {
    ...release,
    daemon: {
      version: daemonVersion,
      protocolVersion: 7,
      body,
      sha256: sha256(body),
      bytes: body.length,
    },
  };
}

function sendJson(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: this callback runs only after an explicit TCP bind, so the
      // address is an AddressInfo rather than null or a pipe name.
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

class Harness {
  readonly root = temporaryDirectory("blitz-payload-test-");
  readonly payloadRoot = path.join(this.root, "opt/payload");
  readonly payloadState = path.join(this.root, "state/payload");
  readonly lodyRoot = path.join(this.root, "opt/lody");
  readonly originFile = path.join(this.root, "state/origin");
  readonly serviceRoot = path.join(this.root, "run/service");
  readonly bin = path.join(this.root, "bin");
  readonly s6Log = path.join(this.root, "s6.log");
  readonly credentialLog = path.join(this.root, "credential.log");
  readonly s6Failure = path.join(this.root, "s6-fail");
  readonly results: PayloadResult[] = [];
  readonly requests: string[] = [];
  readonly options: HarnessOptions;
  origin = "";

  constructor(options: HarnessOptions = {}) {
    this.options = options;
    const bakedPayload = path.join(this.payloadRoot, "baked");
    const bakedDaemon = path.join(this.lodyRoot, "baked");
    mkdirSync(path.join(bakedPayload, "rootfs/usr/local/bin"), { recursive: true });
    writeFileSync(path.join(bakedPayload, "rootfs/usr/local/bin/tool"), "old\n", { mode: 0o755 });
    writeFileSync(path.join(bakedPayload, "payload-version"), `${BAKED_PAYLOAD_VERSION}\n`);
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
    writeExecutable(
      path.join(this.bin, "blitz-cred"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$BLITZ_TEST_CREDENTIAL_LOG\"\n"
        + "[ \"$#\" -eq 1 ] && [ \"$1\" = api-token ] || exit 2\n"
        + "printf 'machine-bearer\\n'\n",
    );
    writeExecutable(
      path.join(this.bin, "s6-svc"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$BLITZ_TEST_S6_LOG\"\n"
        + "[ ! -e \"$BLITZ_TEST_S6_FAILURE\" ]\n",
    );
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => this.handle(request, response));
    this.origin = await listen(server);
    mkdirSync(path.dirname(this.originFile), { recursive: true });
    writeFileSync(this.originFile, `${this.origin}\n`);
  }

  private authorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.options.expectedToken ?? "machine-bearer"}`;
  }

  private manifest(): object {
    const release = this.options.release;
    if (release === undefined) throw new Error("test requested a manifest without a release");
    const manifest: Record<string, object | string | number | PayloadFile[]> = {
      version: release.version,
      createdAt: 1,
      minUpdater: release.minUpdater,
      files: release.files,
      archive: {
        url: `${this.origin}/payload.tar.gz`,
        sha256: release.archive.sha256,
        bytes: release.archive.bytes,
      },
      restart: release.restart,
    };
    if (release.daemon !== undefined) {
      manifest.daemon = {
        version: release.daemon.version,
        protocolVersion: release.daemon.protocolVersion,
        url: `${this.origin}/daemon.tar.gz`,
        sha256: release.daemon.sha256,
        bytes: release.daemon.bytes,
      };
    }
    return manifest;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    if (request.url === "/healthz") {
      const healthy = this.options.health?.(this.currentTarget()) ?? true;
      response.writeHead(healthy ? 200 : 503);
      response.end();
      return;
    }
    if (request.url === "/workspaces/self/box-config" && request.method === "GET") {
      if (!this.authorized(request)) {
        response.writeHead(401);
        response.end();
        return;
      }
      const status = this.options.configStatus ?? 200;
      if (status !== 200) {
        response.writeHead(status);
        response.end();
        return;
      }
      if (this.options.oversizedConfig === true) {
        response.writeHead(200, { "Content-Type": "application/json" });
        for (let index = 0; index < 17; index += 1) response.write(Buffer.alloc(64 * 1024));
        return;
      }
      const pinVersion = this.options.pinVersion === undefined
        ? this.options.release?.version ?? null
        : this.options.pinVersion;
      sendJson(response, 200, {
        boxImageRef: "base",
        controlPlaneOrigin: this.origin,
        updateRequested: false,
        payload: pinVersion === null
          ? null
          : { version: pinVersion, manifestUrl: `${this.origin}/manifest.json` },
      });
      return;
    }
    if (request.url === "/manifest.json" && request.method === "GET") {
      const status = this.options.manifestStatus ?? 200;
      if (status === 200) sendJson(response, status, this.manifest());
      else {
        response.writeHead(status);
        response.end();
      }
      return;
    }
    if (request.url === "/payload.tar.gz" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/gzip" });
      response.end(this.options.release?.archive.body);
      return;
    }
    if (request.url === "/daemon.tar.gz" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/gzip" });
      response.end(this.options.release?.daemon?.body);
      return;
    }
    if (request.url === "/workspaces/self/payload-result" && request.method === "POST") {
      if (!this.authorized(request)) {
        response.writeHead(401);
        response.end();
        return;
      }
      let source = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { source += chunk; });
      request.on("end", () => {
        // SAFETY: the real updater is the only request producer in this test;
        // each assertion below validates the contract fields it relies on.
        this.results.push(JSON.parse(source) as PayloadResult);
        response.writeHead(this.options.resultStatus ?? 204);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  }

  environment(once = true): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
      BLITZ_PAYLOAD_ROOT: this.payloadRoot,
      BLITZ_PAYLOAD_STATE: this.payloadState,
      BLITZ_PAYLOAD_LODY_ROOT: this.lodyRoot,
      BLITZ_PAYLOAD_ORIGIN_FILE: this.originFile,
      BLITZ_PAYLOAD_SERVICE_ROOT: this.serviceRoot,
      BLITZ_PAYLOAD_S6_SVC: path.join(this.bin, "s6-svc"),
      BLITZ_PAYLOAD_GATEWAY_HEALTH_URL: `${this.origin}/healthz`,
      BLITZ_PAYLOAD_HEALTH_TIMEOUT: "0.12",
      BLITZ_PAYLOAD_HEALTH_INTERVAL: "0.01",
      BLITZ_PAYLOAD_REQUEST_TIMEOUT: "0.25",
      BLITZ_PAYLOAD_INTERVAL: "0.1",
      BLITZ_PAYLOAD_FIRST_DELAY: "0.01",
      BLITZ_TEST_CREDENTIAL_LOG: this.credentialLog,
      BLITZ_TEST_S6_LOG: this.s6Log,
      BLITZ_TEST_S6_FAILURE: this.s6Failure,
      ...(once ? { BLITZ_PAYLOAD_ONCE: "1" } : { BLITZ_PAYLOAD_ONCE: "0" }),
    };
  }

  currentTarget(): string {
    return realpathSync(path.join(this.payloadRoot, "current"));
  }

  currentContent(): string {
    return readFileSync(
      path.join(this.payloadRoot, "current/rootfs/usr/local/bin/tool"),
      "utf8",
    );
  }

  calls(logPath: string): string[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8").trim().split("\n").filter((line) => line !== "");
  }

  state(): PayloadState {
    // SAFETY: the real updater is the sole writer; every field used by the
    // tests is asserted immediately after parsing.
    return JSON.parse(
      readFileSync(path.join(this.payloadState, "state.json"), "utf8"),
    ) as PayloadState;
  }
}

function runUpdater(
  harness: Harness,
  timeoutMs = 3000,
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [updater], {
      env: { ...harness.environment(), ...environmentOverrides },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`blitz-payload exceeded ${timeoutMs}ms: ${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function expectOneOutcome(
  harness: Harness,
  outcome: string,
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<PayloadResult> {
  const run = await runUpdater(harness, 3000, environmentOverrides);
  expect(run.status, run.stderr).toBe(0);
  expect(harness.results.length).toBeGreaterThanOrEqual(1);
  const result = harness.results.at(-1);
  if (result === undefined) throw new Error("updater did not report a result");
  expect(result.outcome).toBe(outcome);
  expect(result.version).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
  expect(result.daemonVersion).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
  expect(typeof result.detail).toBe("string");
  if (harness.results.length > 1) {
    expect(harness.results[0]).toMatchObject({
      outcome: "booted",
    });
    expect(harness.results[0]?.detail).toMatch(/^boot report;/u);
  }
  return result;
}

async function startUnixHealth(socketPath: string): Promise<void> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blitz-payload", () => {
  it("never flips current until every extracted file has verified", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
      { path: "rootfs/usr/local/libexec/second", content: "second\n" },
    ]);
    const second = release.files[1];
    if (second === undefined) throw new Error("test release is missing its second file");
    second.sha256 = "0".repeat(64);
    const harness = new Harness({ release });
    await harness.start();

    await expectOneOutcome(harness, "verify-failed");

    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.currentContent()).toBe("old\n");
    expect(harness.calls(harness.s6Log)).toEqual([]);
  });

  it("never executes an archive whose sha256 does not match", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]);
    release.archive.sha256 = "0".repeat(64);
    const harness = new Harness({ release });
    await harness.start();

    const result = await expectOneOutcome(harness, "verify-failed");

    expect(result.detail).toContain("archive sha256 mismatch");
    expect(harness.currentContent()).toBe("old\n");
    expect(harness.calls(harness.s6Log)).toEqual([]);
  });

  it("rejects path traversal in manifest files before downloading", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]);
    const first = release.files[0];
    if (first === undefined) throw new Error("test release is missing its file");
    first.path = "rootfs/usr/local/../../../etc/shadow";
    const harness = new Harness({ release });
    await harness.start();

    const result = await expectOneOutcome(harness, "verify-failed");

    expect(result.detail).toContain("manifest.files[0].path");
    expect(harness.requests).not.toContain("GET /payload.tar.gz");
    expect(harness.currentContent()).toBe("old\n");
  });

  it("reports unsupported without applying when minUpdater is too high", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]);
    release.minUpdater = 2;
    const harness = new Harness({ release });
    await harness.start();

    const result = await expectOneOutcome(harness, "unsupported");

    expect(result.detail).toContain("protocol 2");
    expect(harness.requests).not.toContain("GET /payload.tar.gz");
    expect(harness.currentContent()).toBe("old\n");
  });

  it("recovers a crash with staging debris and a broken current link", async () => {
    const harness = new Harness({ pinVersion: null });
    await harness.start();
    const staging = path.join(harness.payloadState, "versions/interrupted.staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "partial"), "never complete\n");
    unlinkSync(path.join(harness.payloadRoot, "current"));
    const missing = path.join(harness.payloadState, "versions/missing-v2");
    symlinkSync(missing, path.join(harness.payloadRoot, "current"));
    writeFileSync(path.join(harness.payloadState, "state.json"), `${JSON.stringify({
      current: "missing-v2",
      currentTarget: missing,
      previous: "baked",
      previousTarget: path.join(harness.payloadRoot, "baked"),
      daemonVersion: "baked",
      daemonTarget: path.join(harness.lodyRoot, "baked"),
    })}\n`);

    await expectOneOutcome(harness, "booted");

    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(existsSync(staging)).toBe(false);
    expect(harness.currentContent()).toBe("old\n");
  });

  it("rolls back a release that fails health and serves the previous payload", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "unhealthy\n" },
    ]);
    const harness = new Harness({
      release,
      health: (target) => !target.endsWith(`versions${path.sep}${release.version}`),
    });
    await harness.start();

    const result = await expectOneOutcome(harness, "rolled-back");

    expect(result.detail).toContain("previous payload restored");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.currentContent()).toBe("old\n");
    expect(harness.calls(harness.s6Log)).toEqual([
      `-r ${path.join(harness.serviceRoot, "gateway")}`,
      `-r ${path.join(harness.serviceRoot, "gateway")}`,
    ]);
  });

  it("reports start-failed when neither new nor previous becomes healthy", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "unhealthy\n" },
    ]);
    const harness = new Harness({ release, health: () => false });
    await harness.start();

    const result = await expectOneOutcome(harness, "start-failed");

    expect(result.detail).toContain("rollback failed");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
  });

  it.each([
    {
      name: "verify-failed",
      expected: "verify-failed",
      setup: () => {
        const release = makePayloadArchive([
          { path: "rootfs/usr/local/bin/tool", content: "new\n" },
        ]);
        release.archive.sha256 = "0".repeat(64);
        return new Harness({ release });
      },
    },
    {
      name: "rolled-back",
      expected: "rolled-back",
      setup: () => {
        const release = makePayloadArchive([
          { path: "rootfs/usr/local/bin/tool", content: "unhealthy\n" },
        ]);
        return new Harness({
          release,
          health: (target) => !target.endsWith(`versions${path.sep}${release.version}`),
        });
      },
    },
    {
      name: "start-failed",
      expected: "start-failed",
      setup: () => new Harness({
        release: makePayloadArchive([
          { path: "rootfs/usr/local/bin/tool", content: "unhealthy\n" },
        ]),
        health: () => false,
      }),
    },
    {
      name: "unsupported",
      expected: "unsupported",
      setup: () => {
        const release = makePayloadArchive([
          { path: "rootfs/usr/local/bin/tool", content: "new\n" },
        ]);
        release.minUpdater = 2;
        return new Harness({ release });
      },
    },
  ])("remembers $name and does not retry or report it on the next tick", async ({
    expected,
    setup,
  }) => {
    const harness = setup();
    await harness.start();

    const result = await expectOneOutcome(harness, expected);
    expect(result.version).toBe(BAKED_PAYLOAD_VERSION);
    expect(result.detail).toContain(`attempted ${harness.options.release?.version};`);
    const failedAfterAttempt = harness.state().failed;
    expect(failedAfterAttempt).toMatchObject({
      version: harness.options.release?.version,
      outcome: expected,
    });
    expect(failedAfterAttempt?.at).toEqual(expect.any(Number));
    const manifestRequests = harness.requests.filter((request) => request === "GET /manifest.json");

    await expectOneOutcome(harness, "booted");

    expect(harness.requests.filter((request) => request === "GET /manifest.json"))
      .toHaveLength(manifestRequests.length);
    expect(harness.results.filter((result) => result.outcome === expected)).toHaveLength(1);
    expect(harness.state().failed).toEqual(failedAfterAttempt);
  });

  it("allows one more failed-version attempt after six hours", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]);
    release.archive.sha256 = "0".repeat(64);
    const harness = new Harness({ release });
    await harness.start();
    await expectOneOutcome(harness, "verify-failed");
    const state = harness.state();
    if (state.failed === undefined) throw new Error("failed release was not persisted");
    state.failed.at = Date.now() - (6 * 60 * 60 * 1000);
    writeFileSync(
      path.join(harness.payloadState, "state.json"),
      `${JSON.stringify(state)}\n`,
    );

    await expectOneOutcome(harness, "verify-failed");

    expect(harness.results.filter((result) => result.outcome === "verify-failed")).toHaveLength(2);
    expect(harness.state().failed).toMatchObject({ outcome: "verify-failed" });
    expect(harness.state().failed?.at).toBeGreaterThan(state.failed.at);
  });

  it("a different pin is attempted immediately after a failed version", async () => {
    const failedRelease = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "bad\n" },
    ], "bad-v2");
    failedRelease.archive.sha256 = "0".repeat(64);
    const harness = new Harness({ release: failedRelease });
    await harness.start();
    await expectOneOutcome(harness, "verify-failed");

    const nextRelease = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "good\n" },
    ], "good-v3");
    harness.options.release = nextRelease;
    harness.options.pinVersion = nextRelease.version;
    await expectOneOutcome(harness, "applied");
    expect(harness.currentContent()).toBe("good\n");
    expect(harness.state().failed).toBeUndefined();
  });

  it("a pin back to the running version clears the failed version", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "bad\n" },
    ]);
    release.archive.sha256 = "0".repeat(64);
    const harness = new Harness({ release });
    await harness.start();
    await expectOneOutcome(harness, "verify-failed");

    harness.options.pinVersion = BAKED_PAYLOAD_VERSION;
    await expectOneOutcome(harness, "booted");

    expect(harness.state().failed).toBeUndefined();
  });

  it("bounds 401, 5xx, and unreachable control-plane ticks without changing current", async () => {
    const cases: Array<{ name: string; harness: Harness; makeUnreachable?: boolean }> = [
      { name: "401", harness: new Harness({ expectedToken: "different-bearer" }) },
      { name: "5xx", harness: new Harness({ configStatus: 503 }) },
      { name: "unreachable", harness: new Harness(), makeUnreachable: true },
    ];
    for (const item of cases) {
      await item.harness.start();
      if (item.makeUnreachable === true) {
        writeFileSync(item.harness.originFile, "http://127.0.0.1:1\n");
      }
      const run = await runUpdater(item.harness);
      expect(run.status, `${item.name}: ${run.stderr}`).toBe(0);
      expect(run.elapsedMs, item.name).toBeLessThan(1000);
      expect(item.harness.currentTarget(), item.name)
        .toBe(path.join(item.harness.payloadRoot, "baked"));
      expect(item.harness.calls(item.harness.s6Log), item.name).toEqual([]);
      if (item.name === "5xx") {
        expect(item.harness.results.map((result) => result.outcome)).toEqual(["fetch-failed"]);
      }
    }
  });

  it("aborts a JSON response as soon as it exceeds the one MiB cap", async () => {
    const harness = new Harness({ oversizedConfig: true });
    await harness.start();

    const run = await runUpdater(harness, 3000, { BLITZ_PAYLOAD_REQUEST_TIMEOUT: "2" });

    expect(run.status, run.stderr).toBe(0);
    expect(run.elapsedMs).toBeLessThan(1000);
    expect(harness.results.at(-1)).toMatchObject({
      version: BAKED_PAYLOAD_VERSION,
      outcome: "fetch-failed",
      detail: "box-config body is too large",
    });
  });

  it("retries the last unsent result before doing new work", async () => {
    const harness = new Harness({
      pinVersion: BAKED_PAYLOAD_VERSION,
      resultStatus: 503,
    });
    await harness.start();

    await expectOneOutcome(harness, "booted");
    const queued = harness.state().unsentResult;
    expect(queued).toMatchObject({
      version: BAKED_PAYLOAD_VERSION,
      outcome: "booted",
    });
    const requestCount = harness.requests.length;

    harness.options.resultStatus = 204;
    const retry = await runUpdater(harness);
    expect(retry.status, retry.stderr).toBe(0);

    expect(harness.requests.slice(requestCount, requestCount + 2)).toEqual([
      "POST /workspaces/self/payload-result",
      "GET /workspaces/self/box-config",
    ]);
    expect(harness.results[1]).toEqual(queued);
    expect(harness.state().unsentResult).toBeUndefined();
  });

  it("does no download or restart when the pin is up to date", async () => {
    const harness = new Harness({ pinVersion: BAKED_PAYLOAD_VERSION });
    await harness.start();

    const result = await expectOneOutcome(harness, "booted");

    expect(result.detail).toContain("boot report");
    expect(harness.requests).not.toContain("GET /manifest.json");
    expect(harness.calls(harness.s6Log)).toEqual([]);
  });

  it("logs one boot line and one rate-limited quiet-tick line", async () => {
    const harness = new Harness({ pinVersion: BAKED_PAYLOAD_VERSION });
    await harness.start();
    const child = spawn(process.execPath, [updater], { env: harness.environment(false) });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    expect(harness.results.map((result) => result.outcome), stderr).toContain("booted");
    expect(harness.results.map((result) => result.outcome), stderr).toContain("up-to-date");
    expect(harness.calls(path.join(harness.payloadState, "log"))).toEqual([
      `blitz-payload: booted ${BAKED_PAYLOAD_VERSION} daemon ${BAKED_DAEMON_VERSION}`,
      `blitz-payload: tick: up-to-date ${BAKED_PAYLOAD_VERSION}`,
    ]);
  });

  it("garbage-collects payload versions down to current and previous", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "three\n" },
    ], "v3");
    const harness = new Harness({ release });
    await harness.start();
    const versions = path.join(harness.payloadState, "versions");
    const v1 = path.join(versions, "v1");
    const v2 = path.join(versions, "v2");
    const seededVersions: Array<[string, string]> = [[v1, "one\n"], [v2, "two\n"]];
    for (const [directory, content] of seededVersions) {
      mkdirSync(path.join(directory, "rootfs/usr/local/bin"), { recursive: true });
      writeFileSync(path.join(directory, "rootfs/usr/local/bin/tool"), content, { mode: 0o755 });
      writeFileSync(path.join(directory, "payload-version"), `${path.basename(directory)}\n`);
      chmodSync(path.join(directory, "rootfs/usr/local/bin/tool"), 0o755);
    }
    unlinkSync(path.join(harness.payloadRoot, "current"));
    symlinkSync(v2, path.join(harness.payloadRoot, "current"));
    writeFileSync(path.join(harness.payloadState, "state.json"), `${JSON.stringify({
      current: "v2",
      currentTarget: v2,
      previous: "v1",
      previousTarget: v1,
      daemonVersion: "baked",
      daemonTarget: path.join(harness.lodyRoot, "baked"),
    })}\n`);

    await expectOneOutcome(harness, "applied");

    expect(readdirSync(versions).sort()).toEqual(["v2", "v3"]);
    expect(harness.currentTarget()).toBe(path.join(versions, "v3"));
  });

  it("sends a boot-time report for a baked box with no payload pin", async () => {
    const harness = new Harness({ pinVersion: null });
    await harness.start();

    const result = await expectOneOutcome(harness, "booted");

    expect(result).toMatchObject({
      version: BAKED_PAYLOAD_VERSION,
      daemonVersion: BAKED_DAEMON_VERSION,
      outcome: "booted",
      detail: "boot report; no payload pin",
    });
    const state = readFileSync(path.join(harness.payloadState, "state.json"), "utf8");
    expect(state).not.toContain('"current":"baked"');
    expect(state).not.toContain('"daemonVersion":"baked"');
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
  });

  it("obtains the bearer only by spawning blitz-cred api-token", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]);
    const harness = new Harness({ release });
    await harness.start();

    await expectOneOutcome(harness, "applied");

    expect(harness.calls(harness.credentialLog)).toEqual(["api-token"]);
    expect(harness.requests).toContain("POST /workspaces/self/payload-result");
    expect(existsSync(path.join(harness.root, "box-credential.json"))).toBe(false);
  });

  it.each([
    { stage: "after-switch", label: "between the symlink switch and service restart" },
    { stage: "before-health", label: "after restart and before health verification" },
  ])("restores the recorded release after a kill $label", async ({ stage }) => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]);
    const harness = new Harness({ release });
    await harness.start();

    const killed = await runUpdater(harness, 3000, { BLITZ_PAYLOAD_TEST_KILL_AT: stage });
    expect(killed.signal).toBe("SIGKILL");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadState, "versions/v2"));

    harness.options.pinVersion = null;
    await expectOneOutcome(harness, "booted");

    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.currentContent()).toBe("old\n");
    expect(harness.state()).toMatchObject({ current: BAKED_PAYLOAD_VERSION });
  });

  it("installs and switches a daemon archive before restarting lody-daemon", async () => {
    const release = addDaemon(makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]));
    const harness = new Harness({ release });
    await harness.start();
    const daemonSocket = path.join(harness.root, "run/lody-probe.sock");
    await startUnixHealth(daemonSocket);

    const result = await expectOneOutcome(harness, "applied", {
      BLITZ_PAYLOAD_DAEMON_SOCKET: daemonSocket,
    });

    expect(result.daemonVersion).toBe("daemon-v2");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadState, "versions/v2"));
    expect(realpathSync(path.join(harness.lodyRoot, "current")))
      .toBe(path.join(harness.lodyRoot, "daemon-v2"));
    expect(readFileSync(path.join(harness.lodyRoot, "current/bin/lody"), "utf8"))
      .toContain("exit 0");
    expect(harness.calls(harness.s6Log)).toContain(
      `-r ${path.join(harness.serviceRoot, "lody-daemon")}`,
    );
  });

  it("keeps its supervised loop alive and rate-limited across poll errors", async () => {
    const harness = new Harness({ configStatus: 503 });
    await harness.start();
    const child = spawn(process.execPath, [updater], { env: harness.environment(false) });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 360));
    expect(child.exitCode, stderr).toBeNull();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const polls = harness.requests.filter((request) =>
      request === "GET /workspaces/self/box-config").length;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(4);
  });

  it("idles on baked without a control-plane origin", async () => {
    const harness = new Harness();
    await harness.start();
    unlinkSync(harness.originFile);

    const run = await runUpdater(harness);

    expect(run.status, run.stderr).toBe(0);
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.requests).toEqual([]);
    expect(harness.calls(harness.credentialLog)).toEqual([]);
    expect(harness.calls(harness.s6Log)).toEqual([]);
  });
});

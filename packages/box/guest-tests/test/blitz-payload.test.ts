import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Drives the real updater against a stand-in plane and real tar archives. */
const updater = fileURLToPath(new URL("../../rootfs/usr/local/libexec/blitz-payload", import.meta.url));
const payloadLauncher = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d/payload/run", import.meta.url),
);
const serviceTreeSource = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d", import.meta.url),
);
const BAKED_PAYLOAD_VERSION = "baked-payload-v1", BAKED_DAEMON_VERSION = "0.88.1+blitz.3";
const LOCK_REFUSAL = "another updater holds /run/blitz-payload.lock; stop the payload service "
  + "(s6-svc -d /run/service/payload) or wait for the running tick\n";
const linuxFlockIt = process.platform === "linux" ? it : it.skip;

function linuxProcessStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
  const startTime = fields[19];
  if (startTime === undefined) throw new Error(`cannot read start time for process ${pid}`);
  return startTime;
}

function linuxProcessMatches(pid: number, startTime: string, command: string): boolean {
  try {
    return linuxProcessStartTime(pid) === startTime
      && readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(command);
  } catch {
    return false;
  }
}

function linuxChildProcesses(pid: number): number[] {
  try {
    const source = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (source === "") return [];
    return source.split(" ").map(Number).filter((childPid) => Number.isSafeInteger(childPid));
  } catch {
    return [];
  }
}

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
  directories?: string[];
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
  currentTarget?: string;
  previous?: string | null;
  previousTarget?: string | null;
  daemonVersion: string;
  daemonTarget?: string;
  daemonProtocolVersion?: number;
  instanceId?: string;
  pending?: Record<string, object | string | string[] | boolean>;
  lastCommittedUpdateDatabase?: string;
  previousDbPath?: string;
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
  configDelayMs?: number;
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
  return makeV2PayloadArchive(files, version, {
    restart: { gateway: files.map((file) => file.path) },
  });
}

const PROTOCOL_1_RESTART_SERVICES = [
  "cloudflared", "dockerd", "dufs", "gateway", "lody-bridge", "lody-daemon",
  "lody-projects", "lody-watchdog", "machine-stats", "remote-control", "sshd", "ttyd", "watch",
];

function makeProtocol1PayloadArchive(version = "protocol-1-release"): TestRelease {
  const files: Array<{ path: string; content: string; mode?: number }> =
    PROTOCOL_1_RESTART_SERVICES.map((service) => ({
    path: `rootfs/etc/s6-overlay/s6-rc.d/${service}/run`,
    content: `#!/bin/sh\nexec ${service}\n`,
    }));
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
    restart: Object.fromEntries(PROTOCOL_1_RESTART_SERVICES.map((service, index) => [
      service,
      [manifestFiles[index]?.path ?? "missing"],
    ])),
    minUpdater: 1,
  };
}

interface V2ArchiveOptions {
  remove?: string[];
  restart?: Record<string, string[]>;
  omitDeclaredDirectory?: boolean;
  declaredDirectoryMode?: number;
}

function regularFiles(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...regularFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function makeV2PayloadArchive(
  files: Array<{ path: string; content: string; mode?: number }>,
  version = "v2",
  options: V2ArchiveOptions = {},
): TestRelease {
  const build = temporaryDirectory("blitz-payload-v2-archive-");
  const serviceTree = path.join(build, "rootfs/etc/s6-overlay/s6-rc.d");
  cpSync(serviceTreeSource, serviceTree, { recursive: true });
  mkdirSync(path.join(serviceTree, "user2/contents.d"), { recursive: true, mode: 0o755 });
  chmodSync(path.join(serviceTree, "user2/contents.d"), 0o755);
  for (const relative of options.remove ?? []) {
    rmSync(path.join(build, relative), { recursive: true, force: true });
  }
  for (const file of files) {
    const target = path.join(build, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, { mode: file.mode ?? 0o755 });
    chmodSync(target, file.mode ?? 0o755);
  }
  const declaredDirectory = path.join(serviceTree, "user2/contents.d");
  if (options.omitDeclaredDirectory === true) {
    rmSync(declaredDirectory, { recursive: true, force: true });
  } else if (options.declaredDirectoryMode !== undefined) {
    chmodSync(declaredDirectory, options.declaredDirectoryMode);
  }
  const manifestFiles = regularFiles(path.join(build, "rootfs")).sort().map((relative) => {
    const filePath = path.join(build, "rootfs", relative);
    return {
      path: `rootfs/${relative}`,
      sha256: sha256(readFileSync(filePath)),
      mode: (statSync(filePath).mode & 0o7777).toString(8).padStart(4, "0"),
    };
  });
  writeFileSync(path.join(build, "payload-version"), `${version}\n`);
  const archivePath = path.join(build, "payload.tar.gz");
  execFileSync("tar", ["-C", build, "-czf", archivePath, "payload-version", "rootfs"]);
  const body = readFileSync(archivePath);
  return {
    version,
    files: manifestFiles,
    directories: ["rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"],
    archive: { body, sha256: sha256(body), bytes: body.length },
    restart: options.restart ?? {},
    minUpdater: 2,
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
  readonly s6CompileLog = path.join(this.root, "s6-compile.log");
  readonly s6CompileFailure = path.join(this.root, "s6-compile-fail");
  readonly s6UpdateLog = path.join(this.root, "s6-update.log");
  readonly s6UpdateFailure = path.join(this.root, "s6-update-fail");
  readonly s6RcLog = path.join(this.root, "s6-rc.log");
  readonly s6RcFailure = path.join(this.root, "s6-rc-fail");
  readonly s6DbRoot = path.join(this.root, "run/s6");
  readonly s6LiveCompiled = path.join(this.root, "run/s6-rc/compiled");
  readonly s6SourcesRoot = path.join(this.root, "package/admin");
  readonly lockPath = path.join(this.root, "run/blitz-payload.lock");
  readonly instancePath = path.join(this.payloadRoot, ".instance");
  readonly eventLog = path.join(this.root, "events.log");
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
    cpSync(
      serviceTreeSource,
      path.join(bakedPayload, "rootfs/etc/s6-overlay/s6-rc.d"),
      { recursive: true },
    );
    mkdirSync(
      path.join(bakedPayload, "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"),
      { recursive: true, mode: 0o755 },
    );
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
    mkdirSync(
      path.join(this.s6SourcesRoot, "s6-overlay-3.2.1.0/etc/s6-rc/sources"),
      { recursive: true },
    );
    mkdirSync(this.s6DbRoot, { recursive: true });
    mkdirSync(path.join(this.s6DbRoot, "db"));
    mkdirSync(path.dirname(this.s6LiveCompiled), { recursive: true });
    symlinkSync(path.join(this.s6DbRoot, "db"), this.s6LiveCompiled);
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
    writeExecutable(
      path.join(this.bin, "s6-rc-compile"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$BLITZ_TEST_S6_COMPILE_LOG\"\n"
        + "if [ -e \"$BLITZ_TEST_S6_COMPILE_FAILURE\" ]; then echo compile-sentinel >&2; exit 1; fi\n"
        + "mkdir -p \"$2\"\n",
    );
    writeExecutable(
      path.join(this.bin, "s6-rc-update"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$BLITZ_TEST_S6_UPDATE_LOG\"\n"
        + "database=\nfor argument do database=$argument; done\n"
        + "[ -d \"$database\" ] || { echo missing-database >&2; exit 1; }\n"
        + "temporary=\"$BLITZ_TEST_S6_LIVE_COMPILED.new-$$\"\n"
        + "rm -f \"$temporary\"\nln -s \"$database\" \"$temporary\"\n"
        + "rm -f \"$BLITZ_TEST_S6_LIVE_COMPILED\"\n"
        + "mv \"$temporary\" \"$BLITZ_TEST_S6_LIVE_COMPILED\"\n"
        + "if [ -e \"$BLITZ_TEST_S6_UPDATE_FAILURE\" ]; then "
        + "rm -f \"$BLITZ_TEST_S6_UPDATE_FAILURE\"; echo update-sentinel >&2; exit 1; fi\n",
    );
    writeExecutable(
      path.join(this.bin, "s6-rc"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$BLITZ_TEST_S6_RC_LOG\"\n"
        + "[ ! -e \"$BLITZ_TEST_S6_RC_FAILURE\" ]\n",
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
    if (release.directories !== undefined) manifest.directories = release.directories;
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
      const reply = () => {
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
      };
      if ((this.options.configDelayMs ?? 0) > 0) setTimeout(reply, this.options.configDelayMs);
      else reply();
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

  environment(once = true, testOverrides: Record<string, string | number | null> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
      BLITZ_STATE_DIR: path.join(this.root, "state"),
      BLITZ_PAYLOAD_INTERVAL: "0.1",
      BLITZ_PAYLOAD_TEST_CONFIG: JSON.stringify({
        payloadRoot: this.payloadRoot,
        lodyRoot: this.lodyRoot,
        serviceRoot: this.serviceRoot,
        s6Svc: path.join(this.bin, "s6-svc"),
        s6RcCompile: path.join(this.bin, "s6-rc-compile"),
        s6RcUpdate: path.join(this.bin, "s6-rc-update"),
        s6Rc: path.join(this.bin, "s6-rc"),
        s6SourcesRoot: this.s6SourcesRoot,
        s6DbRoot: this.s6DbRoot,
        s6LiveCompiled: this.s6LiveCompiled,
        lockPath: this.lockPath,
        instancePath: this.instancePath,
        s6TransitionTimeoutMs: 1000,
        eventLog: this.eventLog,
        gatewayHealthUrl: `${this.origin}/healthz`,
        healthTimeoutMs: 2500,
        healthIntervalMs: 10,
        requestTimeoutMs: 3000,
        firstDelayMs: 10,
        ...testOverrides,
      }),
      BLITZ_TEST_CREDENTIAL_LOG: this.credentialLog,
      BLITZ_TEST_S6_LOG: this.s6Log,
      BLITZ_TEST_S6_FAILURE: this.s6Failure,
      BLITZ_TEST_S6_COMPILE_LOG: this.s6CompileLog,
      BLITZ_TEST_S6_COMPILE_FAILURE: this.s6CompileFailure,
      BLITZ_TEST_S6_UPDATE_LOG: this.s6UpdateLog,
      BLITZ_TEST_S6_UPDATE_FAILURE: this.s6UpdateFailure,
      BLITZ_TEST_S6_LIVE_COMPILED: this.s6LiveCompiled,
      BLITZ_TEST_S6_RC_LOG: this.s6RcLog,
      BLITZ_TEST_S6_RC_FAILURE: this.s6RcFailure,
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

  liveDatabase(): string {
    return realpathSync(this.s6LiveCompiled);
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
  environmentOverrides: Record<string, string | number | null> = {},
  updaterArguments: string[] = ["tick-locked"],
): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const environment = harness.environment(true, environmentOverrides);
    const child = spawn(process.execPath, [updater, ...updaterArguments], {
      env: environment,
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
  environmentOverrides: Record<string, string | number | null> = {},
): Promise<PayloadResult> {
  const run = await runUpdater(harness, 15_000, environmentOverrides);
  expect(run.status, run.stderr).toBe(0);
  expect(harness.results.length, run.stderr).toBeGreaterThanOrEqual(1);
  const result = harness.results.at(-1);
  if (result === undefined) throw new Error("updater did not report a result");
  expect(result.outcome, `${result.detail}\n${run.stderr}`).toBe(outcome);
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

async function startUnixHealth(
  socketPath: string,
  onRequest: () => void = () => {},
): Promise<void> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = createServer((_request, response) => {
    onRequest();
    response.writeHead(200);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

async function startDaemonState(socketPath: string, activeSessionCount: number): Promise<void> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = createServer((request, response) => {
    if (request.url === "/state") sendJson(response, 200, { activeSessionCount });
    else {
      response.writeHead(200);
      response.end();
    }
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
  it("pins the bash payload launcher and its three flock/exec lines", () => {
    execFileSync("bash", ["-n", payloadLauncher]);
    const executableLines = [
      "exec 9>/run/blitz-payload.lock",
      "flock -w 300 9 || exit 1",
      "exec /usr/local/libexec/blitz-payload",
    ];
    expect(readFileSync(payloadLauncher, "utf8").split("\n")[0])
      .toBe("#!/command/with-contenv bash");
    for (const line of executableLines) {
      expect(execFileSync("grep", ["-Fx", line, payloadLauncher], { encoding: "utf8" }))
        .toBe(`${line}\n`);
    }
  });

  it("v2 apply order is compile -> pending -> links -> s6-rc-update -> map restarts -> health -> commit", async () => {
    const toolPath = "rootfs/usr/local/bin/tool";
    const release = makeV2PayloadArchive(
      [{ path: toolPath, content: "new\n" }],
      "ordered-v2",
      { restart: { gateway: [toolPath] } },
    );
    const harness = new Harness({ release });
    await harness.start();

    await expectOneOutcome(harness, "applied");

    expect(harness.calls(harness.eventLog)).toEqual([
      "compile",
      "pending",
      "links",
      "s6-rc-update",
      "map-restarts",
      "health",
      "commit",
    ]);
    expect(harness.calls(harness.s6Log)).toEqual([
      `-r ${path.join(harness.serviceRoot, "gateway")}`,
    ]);
    expect(harness.calls(harness.s6CompileLog)[0]).toMatch(new RegExp(
      `^-v1 ${path.join(harness.s6DbRoot, "\\.blitz-db-staging-[0-9]+-[a-f0-9]+")} `,
      "u",
    ));
    expect(harness.calls(harness.s6UpdateLog)).toEqual([
      `-v1 -t 60000 ${path.join(harness.s6DbRoot, `db-${release.version}`)}`,
    ]);
    expect(readdirSync(harness.s6DbRoot).some((entry) => entry.includes(".staging-")))
      .toBe(false);
    expect(harness.currentContent()).toBe("new\n");
  });

  it("compile failure changes nothing and reports verify-failed", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "compile-failure-v2");
    const harness = new Harness({ release });
    await harness.start();
    writeFileSync(harness.s6CompileFailure, "fail\n");

    const result = await expectOneOutcome(harness, "verify-failed");

    expect(result.detail).toContain("compile-sentinel");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.currentContent()).toBe("old\n");
    expect(harness.calls(harness.s6UpdateLog)).toEqual([]);
    expect(harness.calls(harness.s6Log)).toEqual([]);
    expect(existsSync(path.join(harness.s6DbRoot, `db-${release.version}`))).toBe(false);
  });

  it.each([
    {
      name: "missing payload/type",
      remove: ["rootfs/etc/s6-overlay/s6-rc.d/payload/type"],
      files: [],
      detail: "payload/type",
    },
    {
      name: "missing user/contents.d/payload",
      remove: ["rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/payload"],
      files: [],
      detail: "user/contents.d/payload",
    },
    {
      name: "changed init-state/up",
      remove: [],
      files: [{
        path: "rootfs/etc/s6-overlay/s6-rc.d/init-state/up",
        content: "/command/execlineb -P /usr/local/libexec/blitz-init-state\n# changed\n",
        mode: 0o644,
      }],
      detail: "init-state/up",
    },
    {
      name: "mode-only init-state/up change",
      remove: [],
      files: [{
        path: "rootfs/etc/s6-overlay/s6-rc.d/init-state/up",
        content: readFileSync(path.join(serviceTreeSource, "init-state/up"), "utf8"),
        mode: 0o755,
      }],
      detail: "init-state/up",
    },
    {
      name: "changed payload/run",
      remove: [],
      files: [{
        path: "rootfs/etc/s6-overlay/s6-rc.d/payload/run",
        content: `${readFileSync(payloadLauncher, "utf8")}# changed\n`,
      }],
      detail: "payload/run",
    },
    {
      name: "payload/run that does not exec the updater",
      remove: [],
      files: [{
        path: "rootfs/etc/s6-overlay/s6-rc.d/payload/run",
        content: "#!/command/with-contenv bash\n"
          + "exec {lock_fd}>/run/blitz-payload.lock\n"
          + "flock -w 300 \"$lock_fd\" || exit 1\n"
          + "exec sleep infinity\n",
      }],
      detail: "payload/run must exec",
    },
  ])("floor guard refuses $name", async ({ remove, files, detail }) => {
    const release = makeV2PayloadArchive(files, "floor-refusal-v2", { remove });
    const harness = new Harness({ release });
    await harness.start();

    const result = await expectOneOutcome(harness, "verify-failed");

    expect(result.detail).toContain(detail);
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.calls(harness.s6CompileLog)).toEqual([]);
    expect(harness.calls(harness.s6UpdateLog)).toEqual([]);
  });

  it("s6-rc-update failure rolls back through the previous database and re-converges user", async () => {
    const toolPath = "rootfs/usr/local/bin/tool";
    const release = makeV2PayloadArchive(
      [{ path: toolPath, content: "new\n" }],
      "update-failure-v2",
      { restart: { gateway: [toolPath] } },
    );
    const harness = new Harness({ release });
    await harness.start();
    const partialPreviousDatabase = path.join(
      harness.s6DbRoot,
      `db-${BAKED_PAYLOAD_VERSION}`,
    );
    mkdirSync(partialPreviousDatabase);
    writeFileSync(path.join(partialPreviousDatabase, "partial"), "incomplete\n");
    writeFileSync(harness.s6UpdateFailure, "fail once\n");

    const result = await expectOneOutcome(harness, "rolled-back");

    expect(result.detail).toContain("update-sentinel");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.calls(harness.s6UpdateLog)).toEqual([
      `-v1 -t 60000 ${path.join(harness.s6DbRoot, `db-${release.version}`)}`,
      `-v1 -t 60000 ${path.join(harness.s6DbRoot, `db-${BAKED_PAYLOAD_VERSION}`)}`,
    ]);
    expect(harness.calls(harness.s6RcLog)).toEqual([
      "-v1 -u -t 60000 change user",
    ]);
    expect(harness.calls(harness.s6CompileLog)).toHaveLength(2);
    expect(harness.calls(harness.s6CompileLog)[1]).toMatch(new RegExp(
      `^-v1 ${path.join(harness.s6DbRoot, "\\.blitz-db-staging-[0-9]+-[a-f0-9]+")} `,
      "u",
    ));
    expect(harness.liveDatabase())
      .toBe(path.join(harness.s6DbRoot, `db-${BAKED_PAYLOAD_VERSION}`));
    expect(existsSync(path.join(partialPreviousDatabase, "partial"))).toBe(false);
  });

  it("reports every persistent pending rollback failure and retains selected releases", async () => {
    const release = addDaemon(makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "persistent-rollback-v2"));
    const harness = new Harness({ release });
    await harness.start();
    const killed = await runUpdater(harness, 3000, { killAt: "after-switch" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const selectedPayload = path.join(harness.payloadState, `versions/${release.version}`);
    const selectedDaemon = path.join(harness.lodyRoot, release.daemon?.version ?? "missing");
    const liveDatabase = harness.liveDatabase();
    expect(harness.currentTarget()).toBe(selectedPayload);
    expect(realpathSync(path.join(harness.lodyRoot, "current"))).toBe(selectedDaemon);
    writeFileSync(harness.s6CompileFailure, "persistent rollback failure\n");
    const manifestRequests = harness.requests.filter((request) =>
      request === "GET /manifest.json").length;

    const first = await runUpdater(harness, 15_000);
    const second = await runUpdater(harness, 15_000);

    for (const run of [first, second]) {
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("pending rollback failed: service tree compile failed");
      expect(run.stderr).toContain("compile-sentinel");
    }
    expect(harness.results.filter((result) => result.outcome === "start-failed"))
      .toHaveLength(2);
    for (const result of harness.results.filter((item) => item.outcome === "start-failed")) {
      expect(result).toMatchObject({
        version: release.version,
        daemonVersion: release.daemon?.version,
      });
    }
    expect(harness.state().pending).toBeDefined();
    expect(harness.state().failed).toBeUndefined();
    expect(harness.state()).toMatchObject({
      current: BAKED_PAYLOAD_VERSION,
      daemonVersion: BAKED_DAEMON_VERSION,
    });
    expect(harness.currentTarget()).toBe(selectedPayload);
    expect(realpathSync(path.join(harness.lodyRoot, "current"))).toBe(selectedDaemon);
    expect(harness.liveDatabase()).toBe(liveDatabase);
    expect(existsSync(selectedPayload)).toBe(true);
    expect(existsSync(selectedDaemon)).toBe(true);
    expect(harness.requests.filter((request) => request === "GET /manifest.json"))
      .toHaveLength(manifestRequests);

    writeFileSync(harness.originFile, "http://127.0.0.1:1\n");
    const unreachable = await runUpdater(harness, 15_000);
    expect(unreachable.status).toBe(1);
    expect(harness.state().unsentResult).toMatchObject({
      version: release.version,
      daemonVersion: release.daemon?.version,
      outcome: "start-failed",
      detail: expect.stringContaining("compile-sentinel"),
    });
    expect(harness.state().pending).toBeDefined();
    expect(harness.state().failed).toBeUndefined();
  });

  it("reports a dangling candidate payload independently from the readable daemon", async () => {
    const release = addDaemon(makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "dangling-payload-v2"), "readable-daemon-v2");
    const harness = new Harness({ release });
    await harness.start();
    const killed = await runUpdater(harness, 3000, { killAt: "after-switch" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    rmSync(path.join(harness.payloadState, `versions/${release.version}`), {
      recursive: true,
      force: true,
    });
    writeFileSync(harness.s6CompileFailure, "stop before restore\n");
    expect(existsSync(path.join(harness.payloadRoot, "current"))).toBe(false);
    expect(readFileSync(path.join(harness.lodyRoot, "current/daemon-version"), "utf8"))
      .toBe(`${release.daemon?.version}\n`);

    const recovery = await runUpdater(harness, 15_000);

    expect(recovery.status, recovery.stderr).toBe(1);
    expect(harness.results.at(-1)).toMatchObject({
      version: release.version,
      daemonVersion: release.daemon?.version,
      outcome: "start-failed",
    });
  });

  it("reports readable component versions without reading the daemon protocol stamp", async () => {
    const release = addDaemon(makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "readable-payload-v2"), "daemon-without-protocol-v2");
    const harness = new Harness({ release });
    await harness.start();
    const killed = await runUpdater(harness, 3000, { killAt: "after-switch" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    rmSync(path.join(harness.lodyRoot, "current/daemon-protocol-version"));
    writeFileSync(harness.s6CompileFailure, "stop before restore\n");
    expect(readFileSync(path.join(harness.payloadRoot, "current/payload-version"), "utf8"))
      .toBe(`${release.version}\n`);

    const recovery = await runUpdater(harness, 15_000);

    expect(recovery.status, recovery.stderr).toBe(1);
    expect(harness.results.at(-1)).toMatchObject({
      version: release.version,
      daemonVersion: release.daemon?.version,
      outcome: "start-failed",
    });
  });

  it("retries the unchanged pin immediately after two recovery failures converge", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "retry-same-pin-v2");
    const harness = new Harness({ release });
    await harness.start();
    const killed = await runUpdater(harness, 3000, { killAt: "after-switch" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    writeFileSync(harness.s6CompileFailure, "persistent rollback failure\n");
    const manifestRequests = harness.requests.filter((request) =>
      request === "GET /manifest.json").length;

    const first = await runUpdater(harness, 15_000);
    const second = await runUpdater(harness, 15_000);

    expect([first.status, second.status]).toEqual([1, 1]);
    expect(harness.results.filter((result) => result.outcome === "start-failed"))
      .toHaveLength(2);
    expect(harness.state().pending).toBeDefined();
    expect(harness.state().failed).toBeUndefined();
    expect(harness.requests.filter((request) => request === "GET /manifest.json"))
      .toHaveLength(manifestRequests);

    rmSync(harness.s6CompileFailure);
    await expectOneOutcome(harness, "applied");

    expect(harness.currentContent()).toBe("new\n");
    expect(harness.state().pending).toBeUndefined();
    expect(harness.state().failed).toBeUndefined();
    expect(harness.requests.filter((request) => request === "GET /manifest.json"))
      .toHaveLength(manifestRequests + 1);
  });

  it("reports restored live identities after a later-stage recovery failure", async () => {
    const release = addDaemon(makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "later-recovery-v2"), "later-daemon-v2");
    const harness = new Harness({ release });
    await harness.start();
    const killed = await runUpdater(harness, 3000, { killAt: "after-switch" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    writeFileSync(harness.s6RcFailure, "fail restored convergence\n");

    const recovery = await runUpdater(harness, 15_000);

    expect(recovery.status, recovery.stderr).toBe(1);
    expect(harness.results.at(-1)).toMatchObject({
      version: BAKED_PAYLOAD_VERSION,
      daemonVersion: BAKED_DAEMON_VERSION,
      outcome: "start-failed",
    });
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(realpathSync(path.join(harness.lodyRoot, "current")))
      .toBe(path.join(harness.lodyRoot, "baked"));
    expect(harness.state().pending).toBeDefined();
    expect(harness.state().failed).toBeUndefined();
  });

  it("keeps pending state until a failed rollback later converges", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "retry-rollback-v2");
    const harness = new Harness({ release });
    await harness.start();
    writeFileSync(harness.s6UpdateFailure, "fail after switch\n");
    writeFileSync(harness.s6RcFailure, "fail rollback convergence\n");

    const failed = await expectOneOutcome(harness, "start-failed");

    expect(failed.detail).toContain("rollback failed");
    expect(harness.state().pending).toBeDefined();
    expect(harness.state().failed).toBeUndefined();
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.liveDatabase())
      .toBe(path.join(harness.s6DbRoot, `db-${BAKED_PAYLOAD_VERSION}`));

    rmSync(harness.s6RcFailure);
    harness.options.pinVersion = null;
    await expectOneOutcome(harness, "booted");

    expect(harness.state().pending).toBeUndefined();
    expect(harness.state()).toMatchObject({
      current: BAKED_PAYLOAD_VERSION,
      currentTarget: path.join(harness.payloadRoot, "baked"),
    });
    expect(harness.liveDatabase())
      .toBe(path.join(harness.s6DbRoot, `db-${BAKED_PAYLOAD_VERSION}`));
  });

  it.each([
    { stage: "after-first-restored-link", mixedLinks: true },
    { stage: "after-restored-links", mixedLinks: false },
    { stage: "before-rollback-database-update", mixedLinks: false },
    { stage: "after-rollback-database-update", mixedLinks: false },
  ])("resumes rollback after a kill at $stage and clears pending only after health", async ({
    stage,
    mixedLinks,
  }) => {
    const toolPath = "rootfs/usr/local/bin/tool";
    const release = addDaemon(makeV2PayloadArchive(
      [{ path: toolPath, content: "new\n" }],
      `rollback-${stage}-v2`,
      { restart: { gateway: [toolPath] } },
    ), `daemon-${stage}-v2`);
    const harness = new Harness({ release });
    await harness.start();
    const daemonSocket = path.join(harness.root, "rollback-daemon-health.sock");
    let healthRequests = 0;
    let pendingPresentAtHealth = true;
    await startUnixHealth(daemonSocket, () => {
      healthRequests += 1;
      pendingPresentAtHealth = pendingPresentAtHealth && harness.state().pending !== undefined;
    });
    writeFileSync(harness.s6UpdateFailure, "fail forward update\n");

    const killed = await runUpdater(harness, 5000, { killAt: stage, daemonSocket });

    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect(harness.state().pending).toBeDefined();
    expect(realpathSync(path.join(harness.lodyRoot, "current")))
      .toBe(path.join(harness.lodyRoot, "baked"));
    expect(harness.currentTarget()).toBe(mixedLinks
      ? path.join(harness.payloadState, `versions/${release.version}`)
      : path.join(harness.payloadRoot, "baked"));
    expect(healthRequests).toBe(0);
    const compileCalls = harness.calls(harness.s6CompileLog).length;
    const updateCalls = harness.calls(harness.s6UpdateLog).length;
    const convergenceCalls = harness.calls(harness.s6RcLog).length;
    const restartCalls = harness.calls(harness.s6Log).length;
    harness.options.pinVersion = null;

    await expectOneOutcome(harness, "booted", { daemonSocket });

    expect(harness.state().pending).toBeUndefined();
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(realpathSync(path.join(harness.lodyRoot, "current")))
      .toBe(path.join(harness.lodyRoot, "baked"));
    expect(harness.calls(harness.s6CompileLog)).toHaveLength(compileCalls);
    expect(harness.calls(harness.s6UpdateLog)).toHaveLength(updateCalls + 1);
    expect(harness.calls(harness.s6RcLog)).toHaveLength(convergenceCalls + 1);
    expect(harness.calls(harness.s6Log)).toHaveLength(restartCalls + 2);
    expect(healthRequests).toBeGreaterThan(0);
    expect(pendingPresentAtHealth).toBe(true);
  });

  it("filters newly added longruns from rollback restarts", async () => {
    const helloRun = "rootfs/etc/s6-overlay/s6-rc.d/hello/run";
    const toolPath = "rootfs/usr/local/bin/hello-tool";
    const release = makeV2PayloadArchive([
      { path: helloRun, content: "#!/bin/sh\nexec sleep infinity\n" },
      { path: "rootfs/etc/s6-overlay/s6-rc.d/hello/type", content: "longrun\n", mode: 0o644 },
      { path: "rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/hello", content: "", mode: 0o644 },
      { path: toolPath, content: "new\n" },
    ], "added-longrun-rollback-v2", { restart: { hello: [toolPath] } });
    const harness = new Harness({ release });
    await harness.start();
    writeFileSync(harness.s6UpdateFailure, "fail after switch\n");

    await expectOneOutcome(harness, "rolled-back");

    expect(harness.calls(harness.s6Log)).not.toContain(
      `-r ${path.join(harness.serviceRoot, "hello")}`,
    );
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.liveDatabase())
      .toBe(path.join(harness.s6DbRoot, `db-${BAKED_PAYLOAD_VERSION}`));
  });

  it("a changed definition outside the restart map is reported through s6-rc-update", async () => {
    const ttydRun = readFileSync(path.join(serviceTreeSource, "ttyd/run"), "utf8");
    const release = makeV2PayloadArchive([{
      path: "rootfs/etc/s6-overlay/s6-rc.d/ttyd/run",
      content: `${ttydRun}# definition changed\n`,
    }], "changed-definition-v2");
    const harness = new Harness({ release });
    await harness.start();

    const result = await expectOneOutcome(harness, "applied");

    expect(harness.calls(harness.s6Log)).toEqual([]);
    expect(harness.calls(harness.s6UpdateLog)).toHaveLength(1);
    expect(result.detail).toContain("s6-rc updated ttyd");
  });

  it("checks daemon health when definition-only lody activation rolls back", async () => {
    const lodyRun = readFileSync(path.join(serviceTreeSource, "lody-daemon/run"), "utf8");
    const release = makeV2PayloadArchive([{
      path: "rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run",
      content: `${lodyRun}# definition changed\n`,
    }], "lody-definition-rollback-v2");
    const harness = new Harness({ release });
    await harness.start();
    const daemonSocket = path.join(harness.root, "run/lody-health.sock");
    let daemonHealthRequests = 0;
    await startUnixHealth(daemonSocket, () => { daemonHealthRequests += 1; });
    writeFileSync(harness.s6UpdateFailure, "fail after switch\n");

    await expectOneOutcome(harness, "rolled-back", { daemonSocket });

    expect(daemonHealthRequests).toBeGreaterThan(0);
    expect(harness.state().pending).toBeUndefined();
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
  });

  it("a changed definition selected by the restart map is not restarted twice", async () => {
    const gatewayRunPath = "rootfs/etc/s6-overlay/s6-rc.d/gateway/run";
    const gatewayRun = readFileSync(path.join(serviceTreeSource, "gateway/run"), "utf8");
    const release = makeV2PayloadArchive(
      [{ path: gatewayRunPath, content: `${gatewayRun}# definition changed\n` }],
      "no-double-restart-v2",
      { restart: { gateway: [gatewayRunPath] } },
    );
    const harness = new Harness({ release });
    await harness.start();

    await expectOneOutcome(harness, "applied");

    expect(harness.calls(harness.s6Log)).toEqual([]);
    expect(harness.calls(harness.s6UpdateLog)).toHaveLength(1);
  });

  it.each([
    { name: "missing", options: { omitDeclaredDirectory: true } },
    { name: "wrong-mode", options: { declaredDirectoryMode: 0o700 } },
  ])("creates $name declared directories with mode 0755", async ({ name, options }) => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], `directories-${name}-v2`, options);
    const harness = new Harness({ release });
    await harness.start();

    await expectOneOutcome(harness, "applied");

    const directory = path.join(
      harness.payloadState,
      `versions/${release.version}/rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d`,
    );
    expect(lstatSync(directory).isDirectory()).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o755);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("database GC removes obsolete state and retains current, previous, and live targets", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "database-gc-v2");
    const harness = new Harness({ release });
    await harness.start();
    mkdirSync(path.join(harness.s6DbRoot, "db-obsolete"));
    mkdirSync(path.join(harness.s6DbRoot, `db-${BAKED_PAYLOAD_VERSION}`));

    await expectOneOutcome(harness, "applied");

    expect(readdirSync(harness.s6DbRoot).sort()).toEqual([
      "db",
      `db-${BAKED_PAYLOAD_VERSION}`,
      "db-database-gc-v2",
    ]);
  });

  it("database GC preserves the live compiled target outside committed state", async () => {
    const harness = new Harness({ pinVersion: BAKED_PAYLOAD_VERSION });
    await harness.start();
    const live = path.join(harness.s6DbRoot, "db-live-uncommitted");
    const obsolete = path.join(harness.s6DbRoot, "db-obsolete");
    mkdirSync(live);
    mkdirSync(obsolete);
    unlinkSync(harness.s6LiveCompiled);
    symlinkSync(live, harness.s6LiveCompiled);

    await expectOneOutcome(harness, "booted");

    expect(harness.liveDatabase()).toBe(live);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(obsolete)).toBe(false);
  });

  it("retains a live database whose accepted version contains staging text", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "release.staging-7");
    const harness = new Harness({ release });
    await harness.start();

    await expectOneOutcome(harness, "applied");
    const database = path.join(harness.s6DbRoot, `db-${release.version}`);
    expect(harness.liveDatabase()).toBe(database);

    await expectOneOutcome(harness, "booted");

    expect(harness.liveDatabase()).toBe(database);
    expect(existsSync(database)).toBe(true);
  });

  it("lody-daemon in changedDefinitions triggers deferral", async () => {
    const lodyRun = readFileSync(path.join(serviceTreeSource, "lody-daemon/run"), "utf8");
    const release = makeV2PayloadArchive([{
      path: "rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run",
      content: `${lodyRun}# definition changed\n`,
    }], "lody-definition-v2");
    const harness = new Harness({ release });
    await harness.start();
    const daemonSocket = path.join(harness.root, "run/lody-state.sock");
    const controlSocket = path.join(harness.root, "run/lody-control.sock");
    writeFileSync(controlSocket, "present\n");
    await startDaemonState(daemonSocket, 1);

    const result = await expectOneOutcome(harness, "deferred", {
      daemonSocket,
      daemonControlSocket: controlSocket,
    });

    expect(result.detail).toContain("1 active turn");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.calls(harness.s6UpdateLog)).toEqual([]);
    expect(existsSync(path.join(harness.s6DbRoot, `db-${release.version}`))).toBe(false);
  });

  it("tick runs exactly one poll and exits successfully", async () => {
    const harness = new Harness({ pinVersion: BAKED_PAYLOAD_VERSION });
    await harness.start();
    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, [updater, "tick-locked"], {
        env: harness.environment(false),
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (status, signal) => {
        resolve({ status, signal, stderr, elapsedMs: 0 });
      });
    });

    expect(result.status, result.stderr).toBe(0);
    expect(harness.requests.filter((request) =>
      request === "GET /workspaces/self/box-config")).toHaveLength(1);
  });

  linuxFlockIt("allows exactly one of two concurrent ticks to apply "
    + "[Linux only: exercises util-linux flock]", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "concurrent-tick-v2");
    const harness = new Harness({ release, configDelayMs: 250 });
    await harness.start();

    const runs = await Promise.all([
      runUpdater(harness, 15_000, {}, ["tick"]),
      runUpdater(harness, 15_000, {}, ["tick"]),
    ]);

    expect(runs.map((run) => run.status).sort()).toEqual([0, 75]);
    const refused = runs.find((run) => run.status === 75);
    expect(refused?.stderr).toBe(LOCK_REFUSAL);
    expect(harness.results.filter((result) => result.outcome === "applied")).toHaveLength(1);
    expect(harness.requests.filter((request) =>
      request === "GET /workspaces/self/box-config")).toHaveLength(1);
    expect(harness.currentContent()).toBe("new\n");
  });

  linuxFlockIt("refuses a tick held by a helper without touching state "
    + "[Linux only: exercises util-linux flock]", async () => {
    const harness = new Harness({ pinVersion: BAKED_PAYLOAD_VERSION });
    await harness.start();
    const ready = path.join(harness.root, "flock-holder-ready");
    const release = path.join(harness.root, "flock-holder-release");
    const holder = spawn("flock", [
      harness.lockPath,
      process.execPath,
      "-e",
      "const fs = require('node:fs'); "
        + "fs.writeFileSync(process.argv[1], 'ready\\n'); "
        + "const timer = setInterval(() => { "
        + "if (fs.existsSync(process.argv[2])) { clearInterval(timer); } }, 10);",
      ready,
      release,
    ]);
    let holderError = "";
    holder.stderr.setEncoding("utf8");
    holder.stderr.on("data", (chunk) => { holderError += chunk; });
    const holderClosed = new Promise<number | null>((resolve) => {
      holder.once("close", (status) => resolve(status));
    });
    const readyDeadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(ready), holderError).toBe(true);
    try {
      const refused = await runUpdater(harness, 3000, {}, ["tick"]);
      expect(refused.status, refused.stderr).toBe(75);
      expect(refused.stderr).toBe(LOCK_REFUSAL);
      expect(existsSync(path.join(harness.payloadState, "state.json"))).toBe(false);
      expect(existsSync(harness.instancePath)).toBe(false);
      expect(harness.requests).toEqual([]);
    } finally {
      writeFileSync(release, "release\n");
      const holderStatus = await holderClosed;
      expect(holderStatus, holderError).toBe(0);
    }
  });

  linuxFlockIt("keeps fd 9 locked after updater SIGKILL until its s6 child exits "
    + "[skipped off Linux: requires Linux /proc and flock descriptor inheritance]", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "inherited-lock-v2");
    const harness = new Harness({ release });
    await harness.start();
    const helperPath = path.join(harness.bin, "s6-rc-update");
    const helperPidPath = path.join(harness.root, "s6-update.pid");
    const helperReleasePath = path.join(harness.root, "s6-update.release");
    const helperRanPath = path.join(harness.root, "s6-update-ran");
    writeExecutable(
      helperPath,
      "#!/bin/sh\n"
        + "database=\nfor argument do database=$argument; done\n"
        + "[ -d \"$database\" ] || { echo missing-database >&2; exit 1; }\n"
        + `if [ ! -e ${JSON.stringify(helperRanPath)} ]; then\n`
        + `  : >${JSON.stringify(helperRanPath)}\n`
        + `  printf '%s\\n' "$$" >${JSON.stringify(helperPidPath)}\n`
        + `  while [ ! -e ${JSON.stringify(helperReleasePath)} ]; do sleep 0.01; done\n`
        + "fi\n"
        + "temporary=\"$BLITZ_TEST_S6_LIVE_COMPILED.new-$$\"\n"
        + "rm -f \"$temporary\"\nln -s \"$database\" \"$temporary\"\n"
        + "rm -f \"$BLITZ_TEST_S6_LIVE_COMPILED\"\n"
        + "mv \"$temporary\" \"$BLITZ_TEST_S6_LIVE_COMPILED\"\n",
    );
    const startedAt = Date.now();
    const first = spawn(process.execPath, [updater, "tick"], {
      env: harness.environment(false, { s6TransitionTimeoutMs: 15_000 }),
    });
    if (first.pid === undefined) throw new Error("public tick did not start");
    const wrapperPid = first.pid;
    let firstStderr = "";
    let helperPid: number | null = null;
    let helperStartTime: string | null = null;
    let updaterPid: number | null = null;
    let updaterStartTime: string | null = null;
    first.stderr.setEncoding("utf8");
    first.stderr.on("data", (chunk) => { firstStderr += chunk; });
    const firstClosed = new Promise<RunResult>((resolve, reject) => {
      first.once("error", reject);
      first.once("close", (status, signal) => {
        resolve({ status, signal, stderr: firstStderr, elapsedMs: Date.now() - startedAt });
      });
    });

    try {
      const updaterDeadline = Date.now() + 5000;
      while (updaterPid === null && Date.now() < updaterDeadline) {
        for (const childPid of linuxChildProcesses(wrapperPid)) {
          const command = readFileSync(`/proc/${childPid}/cmdline`, "utf8").split("\0");
          if (
            command[0] === process.execPath
            && command[1] === updater
            && command[2] === "tick-locked"
          ) {
            updaterPid = childPid;
            updaterStartTime = linuxProcessStartTime(childPid);
          }
        }
        if (updaterPid === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (updaterPid === null || updaterStartTime === null) {
        throw new Error(`cannot find private updater process: ${firstStderr}`);
      }

      const readyDeadline = Date.now() + 10_000;
      while (!existsSync(helperPidPath) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(helperPidPath), firstStderr).toBe(true);
      helperPid = Number(readFileSync(helperPidPath, "utf8").trim());
      expect(Number.isSafeInteger(helperPid) && helperPid > 0).toBe(true);
      helperStartTime = linuxProcessStartTime(helperPid);
      expect(linuxProcessMatches(helperPid, helperStartTime, helperPath)).toBe(true);
      const helperStatus = readFileSync(`/proc/${helperPid}/status`, "utf8");
      const parentLine = helperStatus.split("\n").find((line) => line.startsWith("PPid:"));
      expect(Number(parentLine?.slice("PPid:".length).trim())).toBe(updaterPid);
      expect(linuxProcessMatches(updaterPid, updaterStartTime, updater)).toBe(true);

      process.kill(updaterPid, "SIGKILL");
      const killed = await firstClosed;
      expect(killed.status, killed.stderr).toBe(1);
      expect(killed.stderr).toContain("locked tick terminated by SIGKILL");
      expect(existsSync(`/proc/${helperPid}/fd/9`)).toBe(true);
      expect(realpathSync(`/proc/${helperPid}/fd/9`)).toBe(realpathSync(harness.lockPath));

      const refused = await runUpdater(harness, 3000, {}, ["tick"]);
      expect(refused.status, refused.stderr).toBe(75);
      expect(refused.stderr).toBe(LOCK_REFUSAL);

      harness.options.pinVersion = null;
      writeFileSync(helperReleasePath, "release\n");
      const exitDeadline = Date.now() + 5000;
      while (existsSync(`/proc/${helperPid}/fd/9`) && Date.now() < exitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(`/proc/${helperPid}/fd/9`)).toBe(false);

      const succeeded = await runUpdater(harness, 15_000, {}, ["tick"]);
      expect(succeeded.status, succeeded.stderr).toBe(0);
    } finally {
      writeFileSync(helperReleasePath, "release\n");
      first.kill("SIGKILL");
      const remainingProcesses = [
        { pid: updaterPid, startTime: updaterStartTime, command: updater },
        { pid: helperPid, startTime: helperStartTime, command: helperPath },
      ];
      for (const processInfo of remainingProcesses) {
        const { pid, startTime, command } = processInfo;
        if (pid === null || startTime === null) continue;
        if (!linuxProcessMatches(pid, startTime, command)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The orphan may exit between the /proc check and kill.
        }
      }
    }
  });

  it("tick exits nonzero for an internal initialization error", async () => {
    const harness = new Harness({ pinVersion: BAKED_PAYLOAD_VERSION });
    await harness.start();
    rmSync(path.join(harness.payloadRoot, "baked/payload-version"));

    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, [updater, "tick-locked"], {
        env: harness.environment(false),
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (status, signal) => {
        resolve({ status, signal, stderr, elapsedMs: 0 });
      });
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("payload version stamp is unreadable");
    expect(harness.requests).toEqual([]);
  });

  it("never flips current until every extracted file has verified", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
      { path: "rootfs/usr/local/libexec/second", content: "second\n" },
    ]);
    const second = release.files.find((entry) =>
      entry.path === "rootfs/usr/local/libexec/second");
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
    const first = release.files.find((entry) =>
      entry.path === "rootfs/usr/local/bin/tool");
    if (first === undefined) throw new Error("test release is missing its file");
    first.path = "rootfs/usr/local/../../../etc/shadow";
    const harness = new Harness({ release });
    await harness.start();

    const result = await expectOneOutcome(harness, "verify-failed");

    expect(result.detail).toMatch(/manifest\.files\[[0-9]+\]\.path/u);
    expect(harness.requests).not.toContain("GET /payload.tar.gz");
    expect(harness.currentContent()).toBe("old\n");
  });

  it("refuses a protocol 1 rollback pin before download and remembers the failure", async () => {
    const release = makeProtocol1PayloadArchive();
    const harness = new Harness({ release });
    await harness.start();
    const payloadTarget = harness.currentTarget();
    const daemonTarget = realpathSync(path.join(harness.lodyRoot, "current"));
    const liveDatabase = harness.liveDatabase();

    const result = await expectOneOutcome(harness, "unsupported");

    expect(result.detail).toContain(
      "manifest protocol 1 predates this box's service tree; pin a protocol 2 release",
    );
    expect(harness.requests).not.toContain("GET /payload.tar.gz");
    expect(harness.currentTarget()).toBe(payloadTarget);
    expect(realpathSync(path.join(harness.lodyRoot, "current"))).toBe(daemonTarget);
    expect(harness.liveDatabase()).toBe(liveDatabase);
    expect(harness.state().failed).toMatchObject({
      version: release.version,
      outcome: "unsupported",
    });
    const manifestRequests = harness.requests.filter((request) => request === "GET /manifest.json");

    await expectOneOutcome(harness, "booted");

    expect(harness.requests.filter((request) => request === "GET /manifest.json"))
      .toHaveLength(manifestRequests.length);
  });

  it("reports unsupported without applying when minUpdater is above protocol 2", async () => {
    const release = makePayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ]);
    release.minUpdater = 3;
    release.restart = {};
    const harness = new Harness({ release });
    await harness.start();

    const result = await expectOneOutcome(harness, "unsupported");

    expect(result.detail).toContain("protocol 3");
    expect(harness.requests).not.toContain("GET /payload.tar.gz");
    expect(harness.currentContent()).toBe("old\n");
  });

  it("recovers a crash with staging debris and a broken current link", async () => {
    const harness = new Harness({ pinVersion: null });
    await harness.start();
    const staging = path.join(harness.payloadState, "versions/interrupted.staging");
    const databaseStaging = path.join(harness.s6DbRoot, ".blitz-db-staging-999-deadbeef");
    mkdirSync(staging, { recursive: true });
    mkdirSync(databaseStaging);
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
    expect(existsSync(databaseStaging)).toBe(false);
    expect(harness.currentContent()).toBe("old\n");
  });

  it("drops legacy-shaped pending state without touching recreated links", async () => {
    const harness = new Harness({ pinVersion: null });
    await harness.start();
    const legacyTarget = path.join(harness.payloadState, "versions/legacy-v1");
    mkdirSync(path.join(legacyTarget, "rootfs/etc/s6-overlay/s6-rc.d/gateway"), {
      recursive: true,
    });
    writeFileSync(path.join(legacyTarget, "payload-version"), "legacy-v1\n");
    writeFileSync(
      path.join(legacyTarget, "rootfs/etc/s6-overlay/s6-rc.d/gateway/run"),
      "#!/bin/sh\nexit 0\n",
    );
    writeFileSync(path.join(harness.payloadState, "state.json"), `${JSON.stringify({
      current: "legacy-v1",
      currentTarget: legacyTarget,
      previous: BAKED_PAYLOAD_VERSION,
      previousTarget: path.join(harness.payloadRoot, "baked"),
      daemonVersion: BAKED_DAEMON_VERSION,
      daemonTarget: path.join(harness.lodyRoot, "baked"),
      daemonProtocolVersion: 7,
      pending: {
        payload: { version: "interrupted-v1", target: legacyTarget },
        daemon: {
          version: BAKED_DAEMON_VERSION,
          target: path.join(harness.lodyRoot, "baked"),
          protocolVersion: 7,
        },
      },
    })}\n`);
    const payloadTarget = harness.currentTarget();
    const daemonTarget = realpathSync(path.join(harness.lodyRoot, "current"));
    const liveDatabase = harness.liveDatabase();

    await expectOneOutcome(harness, "booted");

    expect(harness.currentTarget()).toBe(payloadTarget);
    expect(realpathSync(path.join(harness.lodyRoot, "current"))).toBe(daemonTarget);
    expect(harness.liveDatabase()).toBe(liveDatabase);
    expect(harness.state().pending).toBeUndefined();
    expect(harness.state()).toMatchObject({
      current: BAKED_PAYLOAD_VERSION,
      currentTarget: path.join(harness.payloadRoot, "baked"),
      previous: null,
      previousTarget: null,
    });
    expect(existsSync(legacyTarget)).toBe(false);

    unlinkSync(path.join(harness.payloadRoot, "current"));
    await expectOneOutcome(harness, "booted");

    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.state().previousTarget).toBeNull();
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
    expect(harness.state().pending).toBeDefined();
    expect(harness.state().failed).toBeUndefined();
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
      name: "unsupported",
      expected: "unsupported",
      setup: () => {
        const release = makePayloadArchive([
          { path: "rootfs/usr/local/bin/tool", content: "new\n" },
        ]);
        release.minUpdater = 3;
        release.restart = {};
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

    const run = await runUpdater(harness, 3000, { requestTimeoutMs: 2000 });

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
    const deadline = Date.now() + 3000;
    while (
      !harness.results.some((result) => result.outcome === "up-to-date")
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
      cpSync(
        serviceTreeSource,
        path.join(directory, "rootfs/etc/s6-overlay/s6-rc.d"),
        { recursive: true },
      );
      mkdirSync(
        path.join(directory, "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"),
        { recursive: true },
      );
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

    const killed = await runUpdater(harness, 3000, { killAt: stage });
    expect(killed.signal).toBe("SIGKILL");
    expect(harness.currentTarget()).toBe(path.join(harness.payloadState, "versions/v2"));

    harness.options.pinVersion = null;
    await expectOneOutcome(harness, "booted");

    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.currentContent()).toBe("old\n");
    expect(harness.state()).toMatchObject({ current: BAKED_PAYLOAD_VERSION });
  });

  it("rolls back candidate links after a plain restart with a fresh runtime directory", async () => {
    const release = makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "new\n" },
    ], "plain-restart-v2");
    const harness = new Harness({ release });
    await harness.start();
    const killed = await runUpdater(harness, 3000, { killAt: "after-switch" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const instanceId = readFileSync(harness.instancePath, "utf8");
    expect(instanceId).toMatch(/^[a-f0-9]{32}\n$/u);
    expect(harness.state().instanceId).toBe(instanceId.trim());
    expect(harness.currentTarget())
      .toBe(path.join(harness.payloadState, `versions/${release.version}`));

    rmSync(path.join(harness.root, "run"), { recursive: true, force: true });
    mkdirSync(harness.serviceRoot, { recursive: true });
    mkdirSync(path.join(harness.s6DbRoot, "db"), { recursive: true });
    mkdirSync(path.dirname(harness.s6LiveCompiled), { recursive: true });
    symlinkSync(path.join(harness.s6DbRoot, "db"), harness.s6LiveCompiled);
    harness.options.pinVersion = null;

    await expectOneOutcome(harness, "booted");

    expect(readFileSync(harness.instancePath, "utf8")).toBe(instanceId);
    expect(harness.state().pending).toBeUndefined();
    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(harness.liveDatabase())
      .toBe(path.join(harness.s6DbRoot, `db-${BAKED_PAYLOAD_VERSION}`));
  });

  it("drops pending and stays baked when recreated links no longer select the candidate", async () => {
    const committed = addDaemon(makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "committed\n" },
    ], "downloaded-committed-v2"), "downloaded-committed-daemon-v2");
    const harness = new Harness({ release: committed });
    await harness.start();
    const daemonSocket = path.join(harness.root, "recreate-daemon-health.sock");
    await startUnixHealth(daemonSocket);
    await expectOneOutcome(harness, "applied", { daemonSocket });
    const committedTarget = path.join(harness.payloadState, `versions/${committed.version}`);
    expect(harness.currentTarget()).toBe(committedTarget);
    expect(realpathSync(path.join(harness.lodyRoot, "current")))
      .toBe(path.join(harness.lodyRoot, committed.daemon?.version ?? "missing"));

    const candidate = addDaemon(makeV2PayloadArchive([
      { path: "rootfs/usr/local/bin/tool", content: "candidate\n" },
    ], "interrupted-candidate-v2"), "interrupted-candidate-daemon-v2");
    harness.options.release = candidate;
    harness.options.pinVersion = candidate.version;
    const killed = await runUpdater(harness, 3000, { killAt: "after-switch", daemonSocket });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect(harness.state().pending).toBeDefined();
    const previousInstanceId = readFileSync(harness.instancePath, "utf8");

    rmSync(path.join(harness.payloadRoot, "current"), { force: true });
    symlinkSync("baked", path.join(harness.payloadRoot, "current"));
    rmSync(path.join(harness.lodyRoot, "current"), { force: true });
    symlinkSync("baked", path.join(harness.lodyRoot, "current"));
    rmSync(harness.instancePath);
    rmSync(path.join(harness.root, "run"), { recursive: true, force: true });
    mkdirSync(harness.serviceRoot, { recursive: true });
    mkdirSync(path.join(harness.s6DbRoot, "db"), { recursive: true });
    mkdirSync(path.dirname(harness.s6LiveCompiled), { recursive: true });
    symlinkSync(path.join(harness.s6DbRoot, "db"), harness.s6LiveCompiled);
    harness.options.pinVersion = null;
    const compileCalls = harness.calls(harness.s6CompileLog).length;

    await expectOneOutcome(harness, "booted");

    expect(harness.currentTarget()).toBe(path.join(harness.payloadRoot, "baked"));
    expect(realpathSync(path.join(harness.lodyRoot, "current")))
      .toBe(path.join(harness.lodyRoot, "baked"));
    expect(harness.currentContent()).toBe("old\n");
    expect(harness.state()).toMatchObject({
      current: BAKED_PAYLOAD_VERSION,
      currentTarget: path.join(harness.payloadRoot, "baked"),
      daemonVersion: BAKED_DAEMON_VERSION,
      previous: committed.version,
      previousTarget: committedTarget,
    });
    expect(harness.state().pending).toBeUndefined();
    const recreatedInstanceId = readFileSync(harness.instancePath, "utf8");
    expect(recreatedInstanceId).toMatch(/^[a-f0-9]{32}\n$/u);
    expect(recreatedInstanceId).not.toBe(previousInstanceId);
    expect(harness.state().instanceId).toBe(recreatedInstanceId.trim());
    expect(harness.calls(harness.s6CompileLog)).toHaveLength(compileCalls);
    expect(existsSync(committedTarget)).toBe(true);
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
      daemonSocket,
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
    // Busy macOS runners can schedule the child after a fixed 360 ms window.
    const deadline = Date.now() + 3000;
    while (
      harness.requests.filter((request) => request === "GET /workspaces/self/box-config").length < 2
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

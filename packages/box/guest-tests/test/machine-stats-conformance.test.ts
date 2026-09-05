import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Producer side of the machine-stats cross-runtime contract. The real
 * dependency-free updater runs its public `tick` command against a local
 * origin. The unchanged control-plane conformance test exercises every
 * accepted and rejected fixture in packages/schema/fixtures/machine-stats. */

const updater = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-payload", import.meta.url),
);
const serviceTree = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d", import.meta.url),
);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

interface TickResult {
  status: number | null;
  stderr: string;
}

interface PostedStats {
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "machine-stats-updater-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

class TickHarness {
  readonly root = temporaryDirectory();
  readonly stateDir = path.join(this.root, "state");
  readonly originFile = path.join(this.stateDir, "origin");
  readonly payloadRoot = path.join(this.root, "payload");
  readonly payloadState = path.join(this.payloadRoot, "state");
  readonly payloadVersions = path.join(this.payloadRoot, "versions");
  readonly lodyRoot = path.join(this.root, "lody");
  readonly serviceRoot = path.join(this.root, "run/service");
  readonly s6DbRoot = path.join(this.root, "run/s6");
  readonly s6LiveCompiled = path.join(this.root, "run/s6-rc/compiled");
  readonly s6SourcesRoot = path.join(this.root, "package/admin");
  readonly lockPath = path.join(this.root, "run/blitz-payload.lock");
  readonly bin = path.join(this.root, "bin");

  constructor(token: string | null) {
    const bakedPayload = path.join(this.payloadRoot, "baked");
    const bakedDaemon = path.join(this.lodyRoot, "baked");
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(path.join(bakedPayload, "rootfs/etc/s6-overlay"), { recursive: true });
    cpSync(serviceTree, path.join(bakedPayload, "rootfs/etc/s6-overlay/s6-rc.d"), {
      recursive: true,
    });
    mkdirSync(
      path.join(bakedPayload, "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"),
      { recursive: true, mode: 0o755 },
    );
    writeFileSync(path.join(bakedPayload, "payload-version"), "machine-stats-baked\n");
    mkdirSync(bakedDaemon, { recursive: true });
    writeFileSync(path.join(bakedDaemon, "daemon-version"), "machine-stats-daemon\n");
    writeFileSync(path.join(bakedDaemon, "daemon-protocol-version"), "7\n");
    symlinkSync("baked", path.join(this.payloadRoot, "current"));
    symlinkSync("baked", path.join(this.lodyRoot, "current"));

    mkdirSync(this.payloadState, { recursive: true });
    writeFileSync(path.join(this.payloadState, "features"), "BLITZ_LODY_SESSIONS=0\n", {
      mode: 0o644,
    });
    writeFileSync(path.join(this.payloadState, "features.applied"), "BLITZ_LODY_SESSIONS=0\n", {
      mode: 0o644,
    });
    mkdirSync(this.serviceRoot, { recursive: true });
    mkdirSync(
      path.join(this.s6SourcesRoot, "s6-overlay-test/etc/s6-rc/sources"),
      { recursive: true },
    );
    mkdirSync(path.join(this.s6DbRoot, "db"), { recursive: true });
    mkdirSync(path.dirname(this.s6LiveCompiled), { recursive: true });
    symlinkSync(path.join(this.s6DbRoot, "db"), this.s6LiveCompiled);
    mkdirSync(this.bin, { recursive: true });
    if (process.platform === "darwin") {
      // macOS has no flock(1). Lock semantics have dedicated Linux tests; this
      // stand-in lets the public tick wrapper reach the updater on macOS.
      writeExecutable(path.join(this.bin, "flock"), "#!/bin/sh\nexit 0\n");
    }
    writeExecutable(
      path.join(this.bin, "blitz-cred"),
      token === null
        ? "#!/bin/sh\nexit 1\n"
        : `#!/bin/sh\n[ "$*" = api-token ] || exit 2\nprintf '%s\\n' '${token}'\n`,
    );
  }

  setOrigin(origin: string): void {
    writeFileSync(this.originFile, `${origin}\n`);
  }

  run(): Promise<TickResult> {
    const testConfig = {
      payloadRoot: this.payloadRoot,
      payloadState: this.payloadState,
      payloadVersions: this.payloadVersions,
      lodyRoot: this.lodyRoot,
      originFile: this.originFile,
      serviceRoot: this.serviceRoot,
      s6SourcesRoot: this.s6SourcesRoot,
      s6DbRoot: this.s6DbRoot,
      s6LiveCompiled: this.s6LiveCompiled,
      lockPath: this.lockPath,
      featuresFile: path.join(this.payloadState, "features"),
      featuresAppliedFile: path.join(this.payloadState, "features.applied"),
      featuresOwnerUid: process.getuid?.() ?? 0,
      featuresOwnerGid: process.getgid?.() ?? 0,
      requestTimeoutMs: 3000,
    };
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [updater, "tick"], {
        env: {
          ...process.env,
          PATH: `${this.bin}:${process.env.PATH ?? ""}`,
          BLITZ_STATE_DIR: this.stateDir,
          BLITZ_PAYLOAD_TEST_CONFIG: JSON.stringify(testConfig),
        },
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`blitz-payload tick timed out: ${stderr}`));
      }, 9000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stderr });
      });
    });
  }
}

function consumeJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { source += String(chunk); });
    request.on("end", () => {
      try {
        resolve(JSON.parse(source));
      } catch {
        resolve(source);
      }
    });
  });
}

async function localOrigin(machineResponse: number | "destroy" = 204): Promise<{
  origin: string;
  posted: PostedStats[];
  requests: string[];
}> {
  const posted: PostedStats[] = [];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.url === "/workspaces/self/box-config" && request.method === "GET") {
        if (request.headers.authorization !== "Bearer good-token") {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ payload: null, features: { lodySessions: false } }));
        return;
      }
      if (request.url === "/workspaces/self/payload-result" && request.method === "POST") {
        await consumeJson(request);
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/workspaces/self/machine-stats" && request.method === "POST") {
        if (machineResponse === "destroy") {
          request.socket.destroy();
          return;
        }
        posted.push({
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body: await consumeJson(request),
        });
        response.writeHead(machineResponse).end();
        return;
      }
      response.writeHead(404).end();
    })().catch((error) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  servers.push(server);
  const origin = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: this callback follows a successful TCP bind on an explicit host.
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { origin, posted, requests };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blitz-payload machine-stats producer contract", () => {
  it("posts exactly the statfs percentage with JSON and the updater bearer", async () => {
    const collector = await localOrigin();
    const harness = new TickHarness("good-token");
    harness.setOrigin(collector.origin);

    const result = await harness.run();

    expect(result.status, result.stderr).toBe(0);
    expect(collector.posted, result.stderr).toHaveLength(1);
    expect(collector.posted[0]?.authorization).toBe("Bearer good-token");
    expect(collector.posted[0]?.contentType).toBe("application/json");
    expect(collector.posted[0]?.body).toEqual({
      diskUsedPercent: expect.any(Number),
    });
    // SAFETY: the exact object assertion immediately above proves this field.
    const body = collector.posted[0]?.body as { diskUsedPercent: number };
    const stats = statfsSync(harness.stateDir);
    const used = stats.blocks - stats.bfree;
    const expected = Math.ceil((used * 100) / (used + stats.bavail));
    expect(body.diskUsedPercent).toBe(expected);
    expect(Number.isInteger(body.diskUsedPercent)).toBe(true);
    expect(body.diskUsedPercent).toBeGreaterThanOrEqual(0);
    expect(body.diskUsedPercent).toBeLessThanOrEqual(100);
  });

  it("posts nothing without an origin or bearer", async () => {
    const collector = await localOrigin();
    const withoutOrigin = new TickHarness("good-token");
    const withoutBearer = new TickHarness(null);
    withoutBearer.setOrigin(collector.origin);

    const first = await withoutOrigin.run();
    const second = await withoutBearer.run();

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(collector.posted).toHaveLength(0);
    expect(collector.requests).toHaveLength(0);
  });

  it.each([401, 500])("does not fail the tick when the report returns HTTP %i", async (status) => {
    const collector = await localOrigin(status);
    const harness = new TickHarness("good-token");
    harness.setOrigin(collector.origin);

    const result = await harness.run();

    expect(result.status, result.stderr).toBe(0);
    expect(collector.posted).toHaveLength(1);
  });

  it("does not fail the tick when the machine-stats response socket is destroyed", async () => {
    const collector = await localOrigin("destroy");
    const harness = new TickHarness("good-token");
    harness.setOrigin(collector.origin);

    const result = await harness.run();

    expect(result.status, result.stderr).toBe(0);
    expect(collector.requests).toContain("POST /workspaces/self/machine-stats");
    const skippedReports = result.stderr.split("\n")
      .filter((line) => line.startsWith("blitz-payload: machine-stats report skipped"));
    expect(skippedReports).toEqual([
      "blitz-payload: machine-stats report skipped (fetch failed)",
    ]);
  });
});

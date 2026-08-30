/**
 * A real Lody daemon, the real box bridge, and a gateway-shaped front door.
 *
 * The phase-2 exit test drives the browser runtime against an actual
 * `lody@0.88.1` daemon rather than a mock, because every failure phase 1 found
 * lived in the difference between the two (`plans/evidence/lody-phase1.md` §0).
 * This module stands up the same three processes a box runs, in the same order:
 *
 * 1. the patched daemon — `packages/box/patches/lody-local-platform.mjs` applied
 *    to a COPY of the installed npm bundle, exactly as the image build does;
 * 2. `packages/box/rootfs/usr/local/libexec/blitz-lody-bridge`, unmodified;
 * 3. a TCP front door that maps `/lody/*` onto the bridge's unix socket, which
 *    is what `packages/box/gateway/main.go` does. The Go gateway itself cannot
 *    run here (no toolchain), and a browser cannot dial a unix socket, so this
 *    is the one stand-in — and it is deliberately the smallest possible one:
 *    strip the prefix, proxy, splice the upgrade.
 *
 * SHORT PATHS ARE MANDATORY. `sun_path` caps a unix socket at 103 bytes and the
 * daemon THROWS `local_ipc_socket_path_too_long` rather than falling back
 * (`vendor/lody/packages/shared/src/node/local-ipc.ts`). The agent scratchpad on
 * this box is 75 bytes, and `<scratchpad>/lody-data/run/lody-oss-loro-data-plane.sock`
 * is 118. So the data dir is a short `os.tmpdir()` path, not the scratchpad.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Repo root, found by walking up from the working directory.
 *
 * NOT `import.meta.url`: under the jsdom environment Vitest serves test modules
 * over its own dev server, so `import.meta.url` is an `http:` URL and
 * `fileURLToPath` throws "The URL must be of scheme file". The same expression
 * works in a `node`-environment test file, which is exactly the trap.
 */
function repoRoot(): string {
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "lint-baseline.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repo root not found above " + process.cwd());
    directory = parent;
  }
}

/** Where the box image installs the daemon, and where this box has it too. */
export const LODY_BUNDLE = "/opt/blitz/npm/lib/node_modules/lody";
const PATCH_SCRIPT = join(repoRoot(), "packages/box/patches/lody-local-platform.mjs");
const BRIDGE_SCRIPT = join(repoRoot(), "packages/box/rootfs/usr/local/libexec/blitz-lody-bridge");
const REPO_NODE_MODULES = join(repoRoot(), "node_modules");

/** `true` when this machine can run the exit test at all. CI has no `lody`
 * installed, so the test skips there rather than failing. */
export function lodyDaemonAvailable(): boolean {
  return existsSync(join(LODY_BUNDLE, "dist", "index.js"));
}

export interface LodyHarness {
  /** `local:<uuid>`, `lw_<uuid>` and the machineId the daemon minted. */
  dataDir: string;
  /** The origin the browser-side resolver URLs are built on. */
  origin: string;
  endpoints: {
    syncUrl: string;
    rpcUrl: string;
    controlUrl: string;
    projectUrl: string;
    platformUrl: string;
  };
  daemonLog: () => string;
  stop: () => Promise<void>;
}

function waitFor(what: string, check: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no numeric port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The gateway stand-in. `packages/box/gateway/main.go` strips `/lody` and
 * proxies to the bridge socket; so does this, in both the plain-HTTP and the
 * WebSocket-upgrade direction. It carries NO auth: ticket verification and the
 * viewer refusal are the Go gateway's, tested in `gateway/main_test.go`.
 */
function startGatewayShim(socketPath: string, port: number): Server {
  const server = createHttpServer((incoming, response) => {
    const path = (incoming.url ?? "/").replace(/^\/lody/u, "");
    const upstream = httpRequest(
      { socketPath, path, method: incoming.method, headers: incoming.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    const path = (incoming.url ?? "/").replace(/^\/lody/u, "");
    const upstream = createConnection(socketPath, () => {
      const headers = Object.entries(incoming.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
        .join("\r\n");
      upstream.write(`GET ${path} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/** Boots all three, and resolves once the daemon has written its catalog. */
export async function startLodyHarness(): Promise<LodyHarness> {
  const root = mkdtempSync(join(tmpdir(), "lp-"));
  const dataDir = join(root, "d");
  mkdirSync(dataDir, { recursive: true });

  // A COPY, patched. Never the installed bundle: the image build patches its own
  // copy too, and mutating the box's `lody` from a test would leave it patched.
  const bundle = join(root, "lody");
  cpSync(LODY_BUNDLE, bundle, { recursive: true });
  const patch = spawn(process.execPath, [PATCH_SCRIPT, join(bundle, "dist", "index.js")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const patchResult = await new Promise<number>((resolve) => patch.once("exit", (code) => resolve(code ?? 1)));
  if (patchResult !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error("lody-local-platform patch refused the installed bundle");
  }

  let daemonLog = "";
  const daemon = spawn(process.execPath, [join(bundle, "dist", "index.js"), "start"], {
    cwd: root,
    env: {
      ...process.env,
      LODY_PLATFORM: "local",
      LODY_DATA_DIR: dataDir,
      LODY_MCP_HTTP_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (chunk) => (daemonLog += String(chunk)));
  daemon.stderr?.on("data", (chunk) => (daemonLog += String(chunk)));

  const catalog = join(dataDir, "workspace-catalog.json");
  const dataPlane = join(dataDir, "run", "lody-oss-loro-data-plane.sock");
  await waitFor(
    "the daemon to provision its implicit workspace",
    () => existsSync(catalog) && existsSync(dataPlane),
    60_000,
  ).catch((cause: unknown) => {
    daemon.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    throw new Error(`${String(cause)}\n--- daemon log ---\n${daemonLog}`);
  });

  const bridgeSocket = join(root, "b.sock");
  const bridge = spawn(process.execPath, [BRIDGE_SCRIPT], {
    env: {
      ...process.env,
      LODY_PLATFORM: "local",
      LODY_DATA_DIR: dataDir,
      BLITZ_LODY_BRIDGE_SOCKET: bridgeSocket,
      NODE_PATH: REPO_NODE_MODULES,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    bridge.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) resolve();
    });
    bridge.once("exit", (code) => reject(new Error(`bridge exited with ${code}`)));
    setTimeout(() => reject(new Error("bridge did not report listening")), 10_000);
  });

  const port = await freePort();
  const gateway = startGatewayShim(bridgeSocket, port);
  const origin = `http://127.0.0.1:${port}`;

  return {
    dataDir,
    origin,
    endpoints: {
      syncUrl: `ws://127.0.0.1:${port}/lody/sync`,
      rpcUrl: `${origin}/lody/rpc`,
      controlUrl: `${origin}/lody/control`,
      projectUrl: `${origin}/lody/project`,
      platformUrl: `${origin}/lody/platform`,
    },
    daemonLog: () => daemonLog,
    stop: async () => {
      gateway.close();
      bridge.kill("SIGTERM");
      daemon.kill("SIGTERM");
      // The daemon holds SQLite handles and a host lease on 17789; give it the
      // moment it needs to release them before the directory disappears.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      daemon.kill("SIGKILL");
      bridge.kill("SIGKILL");
      rmSync(dirname(dataDir), { recursive: true, force: true });
    },
  };
}

/** Whether a live agent turn can be attempted on this machine. */
export function claudeCredentialAvailable(): boolean {
  const home = process.env.HOME;
  if (home === undefined) return false;
  const path = join(home, ".claude", ".credentials.json");
  if (!existsSync(path)) return false;
  try {
    const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof decoded !== "object" || decoded === null) return false;
    // SAFETY: narrowed to a non-null object; every field below is re-checked.
    const oauth = (decoded as { claudeAiOauth?: unknown }).claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) return false;
    const expiresAt = (oauth as { expiresAt?: unknown }).expiresAt;
    return typeof expiresAt === "number" && expiresAt > Date.now();
  } catch {
    return false;
  }
}

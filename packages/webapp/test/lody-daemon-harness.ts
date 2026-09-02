/**
 * A real Lody daemon, the real box bridge, and a gateway-shaped front door.
 *
 * The phase-2 exit test drives the browser runtime against an actual
 * `lody@0.88.1` daemon rather than a mock, because every failure phase 1 found
 * lived in the difference between the two (`plans/evidence/lody-phase1.md` §0).
 * This module stands up the same three processes a box runs, in the same order:
 *
 * 1. the patched daemon — every script in `packages/box/patches/` applied to a
 *    COPY of the installed npm bundle, in the image build's own order;
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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
export function repoRoot(): string {
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
/** Every patch the image build applies to the published bundle, IN THE ORDER the
 * Dockerfile applies them. `lody-local-platform` guards on a sha256 of the file
 * as published, so it has to run before anything else rewrites it. */
const PATCH_SCRIPTS = [
  join(repoRoot(), "packages/box/patches/lody-local-platform.mjs"),
  join(repoRoot(), "packages/box/patches/lody-acp-auth-queue.mjs"),
  join(repoRoot(), "packages/box/patches/lody-code-collab-worktree-root.mjs"),
  join(repoRoot(), "packages/box/patches/lody-builtin-mcp-off.mjs"),
  join(repoRoot(), "packages/box/patches/lody-session-sandbox.mjs"),
];
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
    /** The dufs stand-in's base URL, and the box path it serves. */
    filesBase: string;
    filesRoot: string;
  };
  /**
   * The same box, addressed the way a GRANTEE addresses it
   * (plans/LODY-SHARING.md §2.2).
   *
   * In production the control plane mints a ticket carrying the `share` claim
   * and the Go gateway verifies it, strips the `/shared/:membershipId` prefix
   * and sets `X-Blitz-Lody-Share` on the way to the bridge. A browser cannot set
   * that header itself — a WebSocket upgrade from a page carries no custom
   * headers at all, which is §2.2's own argument for a path prefix — so the shim
   * does the gateway's half here, and only that half: verification is
   * `gateway/main_test.go`'s.
   */
  sharedEndpoints: (claim: LodyShareClaim) => LodyHarness["endpoints"];
  daemonLog: () => string;
  stop: () => Promise<void>;
}

/** The verified claim the gateway forwards. Same four keys as the wire type. */
export interface LodyShareClaim {
  target: string;
  scope: "sessions" | "all";
  read: string[];
  write: string[];
}

/**
 * The launch markers that tell `lody start` it is being SUPERVISED, so it does
 * not take the single-instance host lease on port 17789.
 *
 * Not a trick: this is Lody's own Supervisor<->Worker contract
 * (`packages/shared/src/node/local-cli-supervisor.ts`), the same four variables
 * `lody daemon start` sets for the worker it forks, and this harness is exactly
 * such a supervisor — it spawns the process, owns its lifetime and kills it.
 *
 * WHY IT IS REQUIRED. The lease is one TCP port for the whole `lody-oss`
 * installation profile, with no override, and a BOX RUNS ITS OWN DAEMON on it
 * (`s6-rc.d/lody-daemon`). Every daemon-backed suite here runs on a box. Before
 * the image shipped `lody-local-platform.mjs`, the box's daemon could not reach
 * local mode and never took the lease, so an unsupervised harness worked by
 * accident; on a current image it exits with "Cannot start: foreground process
 * N already owns the local agent runtime" and the harness reports a 60 s
 * provisioning timeout that names the wrong cause.
 *
 * Everything else stays isolated by `LODY_DATA_DIR`: sockets, catalog and
 * SQLite all live under the harness's own temp dir, so the box's daemon and
 * this one never share state. The lease was the only contended resource.
 *
 * The token is 32+ characters because their schema requires it. It authenticates
 * a `lody/supervisor-shutdown` message over the IPC channel below, which this
 * harness never sends — it kills the process directly — so the value only has to
 * be well-formed and unguessable, not remembered.
 */
function supervisorLaunchEnv(): Record<string, string> {
  return {
    LODY_DAEMON_SUPERVISED: "1",
    LODY_SUPERVISOR_CONTRACT: "1",
    LODY_SUPERVISOR_INSTANCE_ID: randomUUID(),
    LODY_SUPERVISOR_PID: String(process.pid),
    LODY_SUPERVISOR_TOKEN: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
  };
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
 * The dufs stand-in, on the same front door.
 *
 * A box serves `/workspace` from dufs behind the same gateway port as `/lody/*`,
 * and the `+` attachment handoff needs both: the bytes go over WebDAV and the
 * paths they land at go to the daemon (`webapp/src/lody/session-attachments.ts`).
 * Three methods is the whole of what that path uses — MKCOL, PUT, DELETE — so
 * that is the whole of what this answers, with dufs's own rule that MKCOL does
 * NOT create missing intermediates.
 */
function serveWorkspaceDav(
  filesRoot: string,
  method: string,
  relative: string,
  response: ServerResponse,
  incoming: IncomingMessage,
): void {
  const segments = relative.split("/").filter((segment) => segment !== "").map(decodeURIComponent);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    response.writeHead(400).end();
    return;
  }
  const target = join(filesRoot, ...segments);
  if (method === "MKCOL") {
    if (existsSync(target)) {
      response.writeHead(405).end();
      return;
    }
    if (!existsSync(dirname(target))) {
      response.writeHead(409).end();
      return;
    }
    mkdirSync(target);
    response.writeHead(201).end();
    return;
  }
  if (method === "DELETE") {
    rmSync(target, { force: true, recursive: true });
    response.writeHead(204).end();
    return;
  }
  if (method !== "PUT") {
    response.writeHead(405).end();
    return;
  }
  if (!existsSync(dirname(target))) {
    response.writeHead(409).end();
    return;
  }
  const chunks: Buffer[] = [];
  incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
  incoming.on("end", () => {
    writeFileSync(target, Buffer.concat(chunks));
    response.writeHead(201).end();
  });
}

/**
 * The gateway stand-in. `packages/box/gateway/main.go` strips `/lody` and
 * proxies to the bridge socket; so does this, in both the plain-HTTP and the
 * WebSocket-upgrade direction. It carries NO auth: ticket verification and the
 * viewer refusal are the Go gateway's, tested in `gateway/main_test.go`.
 */
const SHARE_HEADER = "x-blitz-lody-share";
/** `/shared/<id>/lody/...` → the claim registered under `<id>`, and the box path
 * without the prefix. `null` for an ordinary request. */
function sharedRequest(
  url: string,
  claims: Map<string, LodyShareClaim>,
): { path: string; claim: LodyShareClaim } | null {
  const match = /^\/shared\/([^/]+)(\/.*)$/u.exec(url);
  if (match === null) return null;
  const claim = claims.get(match[1] ?? "");
  if (claim === undefined) return null;
  return { path: (match[2] ?? "/").replace(/^\/lody/u, ""), claim };
}

function startGatewayShim(
  socketPath: string,
  port: number,
  filesRoot: string,
  claims: Map<string, LodyShareClaim>,
  log: (line: string) => void,
): Server {
  const server = createHttpServer((incoming, response) => {
    const url = incoming.url ?? "/";
    if (url.startsWith("/workspace/")) {
      serveWorkspaceDav(filesRoot, incoming.method ?? "GET", url.slice("/workspace/".length), response, incoming);
      return;
    }
    const shared = sharedRequest(url, claims);
    const path = shared === null ? url.replace(/^\/lody/u, "") : shared.path;
    // Set, never merged: the real gateway strips any inbound copy first, so a
    // browser's own header can never reach the bridge.
    const headers = { ...incoming.headers };
    delete headers[SHARE_HEADER];
    if (shared !== null) headers[SHARE_HEADER] = JSON.stringify(shared.claim);
    const upstream = httpRequest(
      { socketPath, path, method: incoming.method, headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        // A refusal is the interesting case and its body is the diagnosis, so
        // it is copied into the log on the way through. 2xx bodies are session
        // documents and are left alone.
        const failed = (upstreamResponse.statusCode ?? 502) >= 400;
        let body = "";
        upstreamResponse.on("data", (chunk: Buffer) => {
          if (failed && body.length < 400) body += String(chunk);
        });
        upstreamResponse.on("end", () => {
          if (failed) log(`[shim] ${incoming.method ?? "?"} ${path} -> ${upstreamResponse.statusCode ?? 502} ${body}\n`);
        });
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error: Error) => {
      log(`[shim] ${incoming.method ?? "?"} ${path} upstream failed: ${error.message}\n`);
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"ok":false,"error":"lody_gateway_shim_upstream_failed"}');
    });
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    const shared = sharedRequest(incoming.url ?? "/", claims);
    const path = shared === null ? (incoming.url ?? "/").replace(/^\/lody/u, "") : shared.path;
    const upstream = createConnection(socketPath, () => {
      const inbound = { ...incoming.headers };
      delete inbound[SHARE_HEADER];
      if (shared !== null) inbound[SHARE_HEADER] = JSON.stringify(shared.claim);
      const headers = Object.entries(inbound)
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

/**
 * ONE DAEMON PER MACHINE, enforced across test FILES.
 *
 * The local installation profile takes a host lease on port 17789
 * (`vendor/lody/BLITZ-PATCHES.md`), so a second `lody start` on the same box
 * never finishes provisioning its implicit workspace — it waits for a lease it
 * cannot have, and the harness times out 60 s later with a log that says
 * nothing. Vitest runs test FILES in parallel by default, and two suites both
 * needing a daemon is exactly the shape phase 4 introduced.
 *
 * A directory is the lock because `mkdir` is atomic on every filesystem this
 * runs on, and it holds the OWNER'S PID. Staleness is then "that process is
 * gone", not a timer: a vitest worker killed by the OOM reaper — which is how
 * this was found — leaves both the lock and a daemon still holding 17789, and a
 * ten-minute timer would wedge every later run for ten minutes. A timer is kept
 * only as the backstop for a lock whose pid file never got written.
 */
const HARNESS_LOCK = join(tmpdir(), "blitz-lody-harness.lock");
const HARNESS_LOCK_STALE_MS = 60_000;

function harnessLockIsStale(): boolean {
  const ownerFile = join(HARNESS_LOCK, "pid");
  let owner = 0;
  try {
    owner = Number.parseInt(readFileSync(ownerFile, "utf8"), 10);
  } catch {
    // No pid yet: fall back to the age of the directory itself.
    const heldSince = statSync(HARNESS_LOCK, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    return Date.now() - heldSince > HARNESS_LOCK_STALE_MS;
  }
  if (!Number.isInteger(owner) || owner <= 0) return true;
  try {
    process.kill(owner, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * How long a suite waits for its turn at the daemon.
 *
 * The lock SERIALIZES every daemon-backed suite in the run, so this bound has to
 * cover all the others put together, not one of them. Phase 5 shipped four such
 * suites at 300 s; phase 6 adds the sharing relay's, and the slowest of them
 * spends most of a minute on provisioning alone before it asserts anything. At
 * five suites the old bound is the same order as the work it is supposed to
 * outlast, which turns an ordinary slow machine into "another lody harness held
 * the lock too long" — a message that names the wrong cause.
 *
 * Staleness is still the owner PID being gone (below), so a crashed holder is
 * reaped in the next poll and this timer only ever bounds honest waiting.
 */
const HARNESS_LOCK_WAIT_MS = 900_000;

/**
 * What a daemon-backed suite's boot hook must allow.
 *
 * The lock SERIALIZES those suites, so a hook that times out sooner than the
 * lock waits fires on QUEUEING rather than on anything being wrong — which is
 * how phase 6's relay suite first failed, with a 180 s hook and a 900 s lock.
 * The two numbers are one number, and this is it: the wait, plus a suite's own
 * boot (a patched bundle copy, a daemon provisioning its implicit workspace, a
 * bridge, a runtime).
 */
export const HARNESS_BOOT_TIMEOUT_MS = HARNESS_LOCK_WAIT_MS + 120_000;

async function acquireHarnessLock(): Promise<() => void> {
  const deadline = Date.now() + HARNESS_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(HARNESS_LOCK);
      writeFileSync(join(HARNESS_LOCK, "pid"), String(process.pid));
      return () => rmSync(HARNESS_LOCK, { recursive: true, force: true });
    } catch {
      if (harnessLockIsStale()) {
        rmSync(HARNESS_LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("another lody harness held the lock too long");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Boots all three, and resolves once the daemon has written its catalog. */
export async function startLodyHarness(): Promise<LodyHarness> {
  const releaseLock = await acquireHarnessLock();
  const root = mkdtempSync(join(tmpdir(), "lp-"));
  const dataDir = join(root, "d");
  mkdirSync(dataDir, { recursive: true });

  // A COPY, patched. Never the installed bundle: the image build patches its own
  // copy too, and mutating the box's `lody` from a test would leave it patched.
  const bundle = join(root, "lody");
  cpSync(LODY_BUNDLE, bundle, { recursive: true });
  for (const script of PATCH_SCRIPTS) {
    const patch = spawn(process.execPath, [script, join(bundle, "dist", "index.js")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const patchResult = await new Promise<number>((resolve) => patch.once("exit", (code) => resolve(code ?? 1)));
    if (patchResult !== 0) {
      rmSync(root, { recursive: true, force: true });
      releaseLock();
      throw new Error(`${script} refused the installed bundle`);
    }
  }

  let daemonLog = "";
  const daemon = spawn(process.execPath, [join(bundle, "dist", "index.js"), "start"], {
    cwd: root,
    env: {
      ...process.env,
      LODY_PLATFORM: "local",
      LODY_DATA_DIR: dataDir,
      LODY_MCP_HTTP_DISABLED: "1",
      ...supervisorLaunchEnv(),
    },
    // The fourth entry is the supervisor's half of the contract above: a worker
    // launched with the markers but no IPC channel decides it is an orphan
    // ("Supervisor IPC channel disconnected; stopping orphaned worker") and
    // exits before it provisions anything. It also buys the property this
    // module's header wants and could not have: a vitest worker killed by the
    // OOM reaper drops the channel, and the daemon stops itself.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
    releaseLock();
    // The daemon log is silent in the one failure mode that actually happens
    // here, so the hint is part of the message: something else already holds
    // the local profile's host lease. In practice that is a daemon orphaned by
    // a worker the OOM reaper killed, which no in-process cleanup can prevent.
    throw new Error(
      `${String(cause)}\nIf the log below is empty, check for an orphaned daemon: ` +
        `ss -lntp | grep 17789\n--- daemon log ---\n${daemonLog}`,
    );
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
  // The bridge's own log is part of the daemon log: when a control call fails
  // the useful sentence ("upstream failed: …") is written here, not by the
  // daemon, and a test that only printed the daemon's half diagnosed nothing.
  bridge.stdout?.on("data", (chunk) => (daemonLog += `[bridge] ${String(chunk)}`));
  bridge.stderr?.on("data", (chunk) => (daemonLog += `[bridge] ${String(chunk)}`));
  await new Promise<void>((resolve, reject) => {
    bridge.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) resolve();
    });
    bridge.once("exit", (code) => reject(new Error(`bridge exited with ${code}`)));
    setTimeout(() => reject(new Error("bridge did not report listening")), 10_000);
  });

  const port = await freePort();
  // dufs's document root on a box is `/workspace`; here it is a directory beside
  // the daemon's, and `filesRoot` below is what keeps the URL and the path the
  // daemon reads naming the same place.
  const filesRoot = join(root, "w");
  mkdirSync(filesRoot, { recursive: true });
  const shareClaims = new Map<string, LodyShareClaim>();
  const gateway = startGatewayShim(bridgeSocket, port, filesRoot, shareClaims, (line) => (daemonLog += line));
  const origin = `http://127.0.0.1:${port}`;

  // An ordinary crash or a failed assertion must not leave a daemon holding the
  // lease for the next run. A SIGKILLed worker still can, and nothing here can
  // change that — see the provisioning error above.
  const killOnExit = (): void => {
    daemon.kill("SIGKILL");
    bridge.kill("SIGKILL");
  };
  process.once("exit", killOnExit);

  return {
    dataDir,
    origin,
    endpoints: {
      syncUrl: `ws://127.0.0.1:${port}/lody/sync`,
      rpcUrl: `${origin}/lody/rpc`,
      controlUrl: `${origin}/lody/control`,
      projectUrl: `${origin}/lody/project`,
      platformUrl: `${origin}/lody/platform`,
      filesBase: `${origin}/workspace/`,
      filesRoot,
    },
    sharedEndpoints: (claim) => {
      const membershipId = `mem-${shareClaims.size + 1}`;
      shareClaims.set(membershipId, claim);
      const prefix = `${origin}/shared/${membershipId}`;
      return {
        syncUrl: `ws://127.0.0.1:${port}/shared/${membershipId}/lody/sync`,
        rpcUrl: `${prefix}/lody/rpc`,
        controlUrl: `${prefix}/lody/control`,
        projectUrl: `${prefix}/lody/project`,
        platformUrl: `${prefix}/lody/platform`,
        // dufs is not reachable with a share claim at all — the gateway's path
        // allowlist refuses everything but `/lody/*` — so this is the shape and
        // not a door. A shared surface never stages an attachment.
        filesBase: `${prefix}/workspace/`,
        filesRoot,
      };
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
      process.off("exit", killOnExit);
      releaseLock();
    },
  };
}

/**
 * Whether a live agent turn can be attempted on this machine, by EITHER of the
 * two paths a Claude Code process can be signed in on.
 *
 * The box path is the shim: `/usr/local/bin/claude` asks `blitz-cred-claude`
 * for a fresh OAuth token on every process start, and that token comes from the
 * workspace's connected Claude account through the broker. A box has no
 * `~/.claude/.credentials.json` at all, so the file check below answers `false`
 * on exactly the machine the product runs on — which is how the phase-2 exit
 * test came to report "the daemon accepted the dispatch" as a pass on a box
 * that could not have run a turn.
 *
 * The mint is checked by EXIT STATUS, never by reading what it prints: a
 * credential that reaches a variable in this process is a credential that can
 * reach a log.
 */
export function claudeCredentialAvailable(): boolean {
  if (claudeTokenMintable()) return true;
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

/** The box shim's own source of truth: `blitz-cred-claude` exits non-zero and
 * prints nothing when the workspace has no Claude connection behind it. Absent
 * on a developer laptop, where the file path above is the answer instead. */
export function claudeTokenMintable(): boolean {
  const minter = "/usr/local/bin/blitz-cred-claude";
  if (!existsSync(minter)) return false;
  // Never `stdio: 'pipe'`: the token must not enter this process at all.
  const probe = spawnSync(minter, [], { stdio: "ignore", timeout: 20_000 });
  return probe.status === 0;
}

#!/usr/bin/env node

/**
 * Headless driver for the real Lody runtime on a remote BlitzOS box.
 *
 * The SSH tunnel terminates at the box's existing bridge socket. A tiny local
 * TCP shim then gives the browser runtime the same `/lody/*` URLs it receives
 * from the Go gateway. Session writes and dispatches deliberately go through
 * the webapp's own helpers; this file owns transport and CLI plumbing only.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { createStore } from "jotai";
import { JSDOM } from "jsdom";
import { createServer as createViteServer } from "vite";
import { WebSocket as NodeWebSocket } from "ws";
import {
  answerSessionPermissions,
  parsePermissionMode,
  pendingPermissionRequests,
} from "./permission-response.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_FILE), "../../../../..");
const WEBAPP_ROOT = join(REPO_ROOT, "packages/webapp");
const STATE_NAMESPACE = createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 10);
const STATE_DIR = `/tmp/blitz-session-driver-${process.getuid()}-${STATE_NAMESPACE}`;
const STATE_FILE = join(STATE_DIR, "state.json");
const BRIDGE_SOCKET = join(STATE_DIR, "bridge.sock");
const REMOTE_BRIDGE_SOCKET = "/var/lib/blitz/lody-bridge.sock";
const CONNECT_TIMEOUT_MS = 30_000;
const SESSION_SYNC_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 350;

const originalConsoleError = console.error.bind(console);
const stderrLog = (...values) => originalConsoleError(format(...values));
// Lody's development diagnostics must not corrupt stdout, which is a scripting
// interface (`session create` prints only the id).
console.log = stderrLog;
console.info = stderrLog;
console.debug = stderrLog;
console.warn = stderrLog;

const HELP = `Usage:
  drive.mjs open --ssh <user@host[:port]> --key <private-key>
  drive.mjs session create --agent <claude|codex> [--project /workspace/path] [--prompt <text>] [--permissions <allow|deny|ask>]
  drive.mjs session prompt <session-id> <text> [--permissions <allow|deny|ask>]
  drive.mjs session status <session-id>
  drive.mjs session wait <session-id> --timeout <seconds>
  drive.mjs session cancel <session-id>
  drive.mjs session list

The driver keeps only its SSH tunnel metadata under /tmp. It never reads the
operator's HOME or SSH configuration. Progress is written to stderr; command
results are written to stdout.`;

function fail(message) {
  throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function ensureStateDirectory() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
}

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function parseState() {
  let decoded;
  try {
    decoded = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    fail(`no open box tunnel; run '${SCRIPT_FILE} open --ssh ... --key ...' first`);
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !Number.isInteger(decoded.pid) ||
    decoded.pid <= 0 ||
    typeof decoded.socketPath !== "string" ||
    decoded.socketPath !== BRIDGE_SOCKET ||
    typeof decoded.target !== "string" ||
    (decoded.sessions !== undefined &&
      (typeof decoded.sessions !== "object" || decoded.sessions === null || Array.isArray(decoded.sessions)))
  ) {
    fail(`invalid session-driver state at ${STATE_FILE}; run 'open' again`);
  }
  return decoded;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOwnedTunnel(state) {
  if (!processExists(state.pid)) return false;
  try {
    const commandLine = readFileSync(`/proc/${state.pid}/cmdline`, "utf8").split("\0");
    return commandLine[0]?.endsWith("ssh") === true && commandLine.some(
      (argument) => argument === BRIDGE_SOCKET || argument.startsWith(`${BRIDGE_SOCKET}:`),
    );
  } catch {
    return false;
  }
}

async function stopOwnedTunnel() {
  if (!existsSync(STATE_FILE)) return;
  let state;
  try {
    state = parseState();
  } catch {
    rmSync(STATE_FILE, { force: true });
    return;
  }
  if (isOwnedTunnel(state)) {
    process.kill(state.pid, "SIGTERM");
    for (let attempt = 0; attempt < 20 && processExists(state.pid); attempt += 1) {
      await sleep(50);
    }
    if (processExists(state.pid) && isOwnedTunnel(state)) process.kill(state.pid, "SIGKILL");
  }
  rmSync(STATE_FILE, { force: true });
}

function requireTunnel() {
  const state = parseState();
  if (!isOwnedTunnel(state) || !existsSync(BRIDGE_SOCKET)) {
    fail("the saved SSH tunnel is not running; run 'open' again");
  }
  return state;
}

function ownedSession(sessionId) {
  const state = parseState();
  const record = state.sessions?.[sessionId];
  if (
    typeof record !== "object" || record === null ||
    !["allow", "deny", "ask"].includes(record.permissions)
  ) return null;
  return record;
}

function rememberSession(sessionId, permissions) {
  const state = parseState();
  atomicWriteJson(STATE_FILE, {
    ...state,
    sessions: {
      ...(state.sessions ?? {}),
      [sessionId]: {
        permissions,
        createdAt: state.sessions?.[sessionId]?.createdAt ?? new Date().toISOString(),
      },
    },
  });
}

function requireOwnedSession(sessionId) {
  const record = ownedSession(sessionId);
  if (record === null) {
    fail(`session ${sessionId} was not created through this driver tunnel`);
  }
  return record;
}

function parseSshTarget(raw) {
  const match = /^(?<user>[^@\s]+)@(?<host>\[[^\]]+\]|[^:\s]+)(?::(?<port>[0-9]+))?$/u.exec(raw);
  if (match?.groups === undefined) fail("--ssh must be user@host or user@host:port");
  const port = match.groups.port === undefined ? 22 : Number.parseInt(match.groups.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("SSH port must be between 1 and 65535");
  if (match.groups.user.startsWith("-") || match.groups.host.startsWith("-")) {
    fail("SSH user and host must not begin with '-'");
  }
  return {
    destination: `${match.groups.user}@${match.groups.host}`,
    port,
    display: raw,
  };
}

function requestUnixJson(socketPath, path) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { socketPath, path, method: "GET", headers: { host: "localhost" }, timeout: 5_000 },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) !== 200) {
            reject(new Error(`bridge ${path} returned HTTP ${response.statusCode ?? 500}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(body));
          } catch (cause) {
            reject(new Error(`bridge ${path} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`));
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error(`bridge ${path} timed out`)));
    request.once("error", reject);
    request.end();
  });
}

async function waitForPlatform(socketPath, pid) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError = "bridge socket did not appear";
  while (Date.now() < deadline) {
    if (!processExists(pid)) fail(`SSH tunnel exited before ${REMOTE_BRIDGE_SOCKET} became reachable`);
    try {
      return await requestUnixJson(socketPath, "/platform");
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    await sleep(200);
  }
  fail(`timed out opening Lody bridge: ${lastError}`);
}

function viteAliases() {
  const components = join(REPO_ROOT, "vendor/lody/packages/components/src");
  return [
    {
      find: "acp-extension-dsh/capabilities",
      replacement: join(WEBAPP_ROOT, "src/lody/stubs/acp-extension-dsh-capabilities.ts"),
    },
    { find: "@lody/components", replacement: components },
    { find: "@lody/shared", replacement: join(REPO_ROOT, "vendor/lody/packages/shared/src") },
    { find: "@lody/platform", replacement: join(REPO_ROOT, "vendor/lody/packages/platform/src") },
    { find: "@lody/cloud-api", replacement: join(REPO_ROOT, "vendor/lody/packages/cloud-api/src") },
    {
      find: "@lody/loro-streams-rpc",
      replacement: join(REPO_ROOT, "vendor/lody/packages/loro-streams-rpc/src"),
    },
    { find: "@/", replacement: `${components}/` },
  ];
}

async function createModuleLoader() {
  ensureStateDirectory();
  return await createViteServer({
    root: REPO_ROOT,
    configFile: false,
    cacheDir: join(STATE_DIR, "vite-cache"),
    appType: "custom",
    logLevel: "silent",
    mode: "test",
    resolve: { alias: viteAliases(), dedupe: ["react", "react-dom", "jotai"] },
    server: { middlewareMode: true },
  });
}

async function parsePlatformCatalog(catalog) {
  const loader = await createModuleLoader();
  try {
    const platform = await loader.ssrLoadModule("/packages/webapp/src/lody/platform-snapshot.ts");
    return platform.parseLodyPlatformSnapshot(catalog);
  } finally {
    await loader.close();
  }
}

async function openTunnel(argumentsList) {
  let sshTarget;
  let keyArgument;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--ssh") sshTarget = argumentsList[++index];
    else if (argument === "--key") keyArgument = argumentsList[++index];
    else fail(`unknown open argument: ${argument ?? "<missing>"}`);
  }
  if (sshTarget === undefined || keyArgument === undefined) fail("open requires --ssh and --key");
  const target = parseSshTarget(sshTarget);
  const keyPath = resolve(process.cwd(), keyArgument);
  let keyStats;
  try {
    keyStats = statSync(keyPath);
  } catch {
    fail(`SSH private key is not readable: ${keyPath}`);
  }
  if (!keyStats.isFile()) fail(`SSH private key is not a file: ${keyPath}`);

  ensureStateDirectory();
  await stopOwnedTunnel();
  rmSync(BRIDGE_SOCKET, { force: true });

  const sshArguments = [
    "-F", "/dev/null",
    "-N",
    "-L", `${BRIDGE_SOCKET}:${REMOTE_BRIDGE_SOCKET}`,
    "-i", keyPath,
    "-p", String(target.port),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "IdentityAgent=none",
    "-o", "IdentitiesOnly=yes",
    "-o", "LogLevel=ERROR",
    target.destination,
  ];
  const tunnel = spawn("ssh", sshArguments, { detached: true, stdio: "ignore" });
  await new Promise((resolvePromise, reject) => {
    tunnel.once("spawn", resolvePromise);
    tunnel.once("error", reject);
  });
  if (!Number.isInteger(tunnel.pid) || tunnel.pid <= 0) fail("SSH started without a process id");
  tunnel.unref();

  try {
    const catalog = await waitForPlatform(BRIDGE_SOCKET, tunnel.pid);
    const snapshot = await parsePlatformCatalog(catalog);
    const state = {
      version: 1,
      pid: tunnel.pid,
      socketPath: BRIDGE_SOCKET,
      target: target.display,
      openedAt: new Date().toISOString(),
      userId: snapshot.userId,
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
      sessions: {},
    };
    atomicWriteJson(STATE_FILE, state);
    process.stdout.write(`${JSON.stringify({
      target: state.target,
      userId: state.userId,
      machineId: state.machineId,
      workspaceId: state.workspaceId,
    })}\n`);
  } catch (cause) {
    if (processExists(tunnel.pid)) process.kill(tunnel.pid, "SIGTERM");
    rmSync(BRIDGE_SOCKET, { force: true });
    throw cause;
  }
}

async function startGateway(socketPath) {
  const connections = new Set();
  const server = createHttpServer((incoming, response) => {
    const path = (incoming.url ?? "/").replace(/^\/lody/u, "");
    const upstream = httpRequest(
      { socketPath, path, method: incoming.method, headers: incoming.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("error", (cause) => {
      if (response.headersSent) response.destroy(cause);
      else response.writeHead(502, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: false, error: "lody_gateway_shim_upstream_failed" }),
      );
    });
    incoming.pipe(upstream);
  });
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
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
    connections.add(upstream);
    upstream.once("close", () => connections.delete(upstream));
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") fail("gateway shim did not get a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

async function installDom() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
  });
  const { window } = dom;
  const skip = new Set([
    "window", "self", "top", "parent", "globalThis", "performance", "navigator",
    "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval",
    "clearImmediate", "queueMicrotask",
  ]);
  for (const key of Object.getOwnPropertyNames(window)) {
    if (skip.has(key)) continue;
    const value = window[key];
    if (value === undefined) continue;
    try {
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    } catch {
      // Node owns this global. The DOM does not need it copied back.
    }
  }
  for (const [key, value] of [["window", window], ["self", window], ["navigator", window.navigator]]) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  window.matchMedia = (media) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  globalThis.matchMedia = window.matchMedia;

  await import("fake-indexeddb/auto");
  for (const key of [
    "indexedDB", "IDBCursor", "IDBCursorWithValue", "IDBDatabase", "IDBFactory",
    "IDBIndex", "IDBKeyRange", "IDBObjectStore", "IDBOpenDBRequest", "IDBRecord",
    "IDBRequest", "IDBTransaction", "IDBVersionChangeEvent",
  ]) {
    const value = globalThis[key] ?? window[key];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    Object.defineProperty(window, key, { value, configurable: true });
  }
  return dom;
}

async function waitUntil(what, read, timeoutMs = SESSION_SYNC_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch (cause) {
      lastError = cause;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const suffix = lastError === undefined ? "" : `: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  fail(`timed out waiting for ${what}${suffix}`);
}

async function withRuntime(operation) {
  const state = requireTunnel();
  const gateway = await startGateway(state.socketPath);
  const dom = await installDom();
  const loader = await createModuleLoader();
  let handle;
  let runtimeModule;
  let store;
  try {
    const [platformModule, loadedRuntimeModule, agentModule, sessionModule, workdirModule, sharedModule, bootstrapModule] =
      await Promise.all([
        loader.ssrLoadModule("/packages/webapp/src/lody/platform-snapshot.ts"),
        loader.ssrLoadModule("/packages/webapp/src/lody/runtime.ts"),
        loader.ssrLoadModule("/packages/webapp/src/lody/agent-configs.ts"),
        loader.ssrLoadModule("/packages/webapp/src/lody/session.ts"),
        loader.ssrLoadModule("/packages/webapp/src/lody/workdir-default.ts"),
        loader.ssrLoadModule("/vendor/lody/packages/shared/src/index.ts"),
        loader.ssrLoadModule("/vendor/lody/packages/shared/src/session-bootstrap.ts"),
      ]);
    runtimeModule = loadedRuntimeModule;
    const endpoints = {
      syncUrl: `${gateway.origin.replace(/^http/u, "ws")}/lody/sync`,
      rpcUrl: `${gateway.origin}/lody/rpc`,
      controlUrl: `${gateway.origin}/lody/control`,
      projectUrl: `${gateway.origin}/lody/project`,
      platformUrl: `${gateway.origin}/lody/platform`,
      filesBase: `${gateway.origin}/workspace/`,
      filesRoot: "/workspace",
      fetchImpl: globalThis.fetch,
      webSocketConstructor: NodeWebSocket,
    };
    const snapshot = await waitUntil("the daemon platform catalog", async () => {
      const read = await platformModule.fetchLodyPlatformSnapshot(endpoints.platformUrl);
      return read === null ? undefined : read;
    });
    handle = await runtimeModule.createLodyRuntime({ endpoints, snapshot });
    store = createStore();
    runtimeModule.mountLodyRuntimeAtoms(store, handle.runtime);
    await waitUntil("the Lody data plane to connect", async () =>
      (await globalThis.window.ipc.invoke("loro.isConnected")) === true ? true : undefined,
    );
    return await operation({
      endpoints,
      snapshot,
      runtime: handle.runtime,
      store,
      modules: {
        agent: agentModule,
        session: sessionModule,
        workdir: workdirModule,
        shared: sharedModule,
        bootstrap: bootstrapModule,
      },
    });
  } finally {
    if (store !== undefined && runtimeModule !== undefined) runtimeModule.unmountLodyRuntimeAtoms(store);
    if (handle !== undefined) await handle.dispose();
    await loader.close();
    dom.window.close();
    await gateway.close();
  }
}

function parseCreateArguments(argumentsList) {
  let agent;
  let project;
  let prompt;
  let permissions = "allow";
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--agent") agent = argumentsList[++index];
    else if (argument === "--project") project = argumentsList[++index];
    else if (argument === "--prompt") prompt = argumentsList[++index];
    else if (argument === "--permissions") permissions = parsePermissionMode(argumentsList[++index]);
    else fail(`unknown session create argument: ${argument ?? "<missing>"}`);
  }
  if (agent !== "claude" && agent !== "codex") fail("session create requires --agent claude or --agent codex");
  if (project !== undefined && project !== "/workspace" && !project.startsWith("/workspace/")) {
    fail("--project must be /workspace or a path beneath it");
  }
  if (prompt !== undefined && prompt.trim() === "") fail("--prompt must not be empty");
  return { agent, project, prompt, permissions };
}

function parsePromptArguments(argumentsList) {
  if (argumentsList.length < 1) fail("session prompt requires <session-id> <text>");
  const prompt = argumentsList[0];
  let permissions = "allow";
  for (let index = 1; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--permissions") permissions = parsePermissionMode(argumentsList[++index]);
    else fail(`unknown session prompt argument: ${argument ?? "<missing>"}`);
  }
  if (typeof prompt !== "string" || prompt.trim() === "") fail("session prompt text must not be empty");
  return { prompt, permissions };
}

async function resolveProject(context, path) {
  if (path === undefined) return undefined;
  const project = await context.modules.workdir.createDefaultSessionProjectResolver(
    context.endpoints,
    context.snapshot.machineId,
    path,
  )();
  if (project === null) fail(`the daemon refused local project ${path}`);
  return project;
}

function assertDispatchAccepted(response) {
  if (response === null || typeof response !== "object" || response.accepted !== true) {
    const detail = response !== null && typeof response === "object" && typeof response.error === "string"
      ? `: ${response.error}`
      : "";
    fail(`the daemon did not accept the turn${detail}`);
  }
}

async function createDraftSession(context, input) {
  const createdAt = new Date().toISOString();
  const patch = context.modules.bootstrap.buildInitialSessionMetaPatch({
    sessionId: input.sessionId,
    machineId: context.snapshot.machineId,
    userId: context.snapshot.userId,
    cliType: "builtin",
    agentType: input.agent,
    createdAt,
    project: input.project,
  });
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    fail("Lody produced no session metadata");
  }
  const roomId = context.modules.shared.getSessionRoomId(input.sessionId);
  await context.runtime.ensureDocStream(roomId);
  await context.runtime.writer.upsertDocMeta(roomId, {
    ...patch,
    agentConfigId: input.agent === "claude" ? "blitz-claude" : "blitz-codex",
  });
}

async function syncSessionDocument(context, sessionId) {
  await context.runtime.withSessionStore(sessionId, async (sessionStore) => {
    await sessionStore.waitUntilSynced();
  });
}

async function createSession(argumentsList) {
  const options = parseCreateArguments(argumentsList);
  await withRuntime(async (context) => {
    stderrLog(`seeding agent configurations on ${context.snapshot.machineId}`);
    await context.modules.agent.bootstrapLodyAgentConfigs(
      context.store,
      context.runtime,
      context.snapshot.machineId,
    );
    const project = await resolveProject(context, options.project);
    const sessionId = randomUUID();
    if (options.prompt === undefined) {
      const draftProject = project ?? await resolveProject(context, "/workspace");
      await createDraftSession(context, { sessionId, agent: options.agent, project: draftProject });
      rememberSession(sessionId, options.permissions);
      process.stdout.write(`${sessionId}\n`);
      return;
    }
    const started = await context.modules.session.startLodySession(context.runtime, {
      sessionId,
      machineId: context.snapshot.machineId,
      userId: context.snapshot.userId,
      agentConfigId: options.agent === "claude" ? "blitz-claude" : "blitz-codex",
      agentType: options.agent,
      prompt: options.prompt,
      project,
    });
    // A browser's mounted session view holds this room lease. This process has
    // no view, so without the explicit exchange it could exit with the history
    // entry still present only in its in-memory IndexedDB adapter.
    await syncSessionDocument(context, sessionId);
    const dispatch = await context.modules.session.dispatchLodyTurn(
      context.runtime,
      started,
      context.snapshot.machineId,
      context.snapshot.userId,
      { timeoutMs: 20_000 },
    );
    assertDispatchAccepted(dispatch);
    rememberSession(sessionId, options.permissions);
    stderrLog(`turn ${started.userTurnId} accepted for session ${sessionId}`);
    process.stdout.write(`${sessionId}\n`);
  });
}

function textFromEntry(entry) {
  if (typeof entry !== "object" || entry === null || !Array.isArray(entry.items)) return null;
  const text = entry.items
    .filter((item) => typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("")
    .trim();
  return text === "" ? null : text;
}

function failureFromHistory(history, startIndex) {
  for (let entryIndex = history.length - 1; entryIndex >= startIndex; entryIndex -= 1) {
    const entry = history[entryIndex];
    if (typeof entry !== "object" || entry === null || !Array.isArray(entry.items)) continue;
    for (const item of entry.items) {
      if (
        typeof item !== "object" || item === null || item.type !== "system_notice" ||
        item.name !== "chat_failed"
      ) continue;
      const meta = typeof item.meta === "object" && item.meta !== null ? item.meta : {};
      return {
        reason: typeof meta.reason === "string" && meta.reason !== "" ? meta.reason : "chat_failed",
        message: typeof meta.message === "string" && meta.message !== ""
          ? meta.message
          : meta.reason === "acp_auth_required"
            ? "Authentication required"
            : "The agent turn failed",
      };
    }
  }
  return null;
}

function summarizeSession(sessionId, meta, history) {
  let lastUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (typeof entry === "object" && entry !== null && entry.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  let lastAssistantText = null;
  for (let index = history.length - 1; index > lastUserIndex; index -= 1) {
    const entry = history[index];
    if (typeof entry === "object" && entry !== null && entry.role === "assistant") {
      lastAssistantText = textFromEntry(entry);
      if (lastAssistantText !== null) break;
    }
  }
  if (lastUserIndex < 0) {
    return { sessionId, state: "idle", turnId: null, reason: null, message: null, lastAssistantText };
  }

  const user = history[lastUserIndex];
  const turnId = typeof user.id === "string" ? user.id : null;
  const failure = failureFromHistory(history, lastUserIndex);
  if (failure !== null) {
    return { sessionId, state: "error", turnId, ...failure, lastAssistantText };
  }
  const userStatus = typeof user.status === "string"
    ? user.status
    : user.read === true
      ? "seen"
      : user.read === false
        ? "pending"
        : null;
  if (userStatus === "failed" || userStatus === "canceled") {
    return {
      sessionId,
      state: "error",
      turnId,
      reason: userStatus,
      message: `The agent turn was ${userStatus}`,
      lastAssistantText,
    };
  }
  const rawStatus = typeof meta.status === "object" && meta.status !== null ? meta.status.type : null;
  const active = new Set(["running", "initializing", "requestPermission"]);
  const handled = userStatus === "handled" || (turnId !== null && meta.lastHandledUserMsgId === turnId);
  const inProgress = active.has(rawStatus) || (turnId !== null && meta.processingUserMsgId === turnId) ||
    ["pending", "pending_apply", "seen", "processing"].includes(userStatus);
  return {
    sessionId,
    state: handled ? "completed" : inProgress ? "running" : "idle",
    turnId,
    reason: null,
    message: null,
    lastAssistantText,
  };
}

async function readSessionData(context, sessionId, waitForDocument = true) {
  const roomId = context.modules.shared.getSessionRoomId(sessionId);
  await context.runtime.ensureDocStream(roomId);
  const read = async () => {
    const snapshot = await context.runtime.repo.getDocMeta(roomId);
    if (snapshot === undefined || snapshot.deleted || snapshot.meta.id !== sessionId) return undefined;
    const history = await context.runtime.withSessionStore(sessionId, async (sessionStore) => {
      await sessionStore.waitUntilSynced();
      const value = sessionStore.getState().history;
      return Array.isArray(value) ? [...value] : [];
    });
    return {
      summary: summarizeSession(sessionId, snapshot.meta, history),
      meta: snapshot.meta,
      history,
    };
  };
  if (!waitForDocument) return await read();
  return await waitUntil(`session ${sessionId} to sync`, read);
}

async function readSession(context, sessionId, waitForDocument = true) {
  const data = await readSessionData(context, sessionId, waitForDocument);
  return data?.summary;
}

async function promptSession(sessionId, options) {
  requireOwnedSession(sessionId);
  rememberSession(sessionId, options.permissions);
  await withRuntime(async (context) => {
    const roomId = context.modules.shared.getSessionRoomId(sessionId);
    await context.runtime.ensureDocStream(roomId);
    const snapshot = await waitUntil(`session ${sessionId} to sync`, async () => {
      const read = await context.runtime.repo.getDocMeta(roomId);
      return read === undefined || read.deleted || read.meta.id !== sessionId ? undefined : read;
    });
    const agentType = snapshot.meta.agentType;
    if (agentType !== "claude" && agentType !== "codex") {
      fail(`session ${sessionId} has unsupported agent type ${String(agentType)}`);
    }
    await syncSessionDocument(context, sessionId);
    const started = await context.modules.session.continueLodySession(context.runtime, {
      sessionId,
      userId: context.snapshot.userId,
      agentType,
      prompt: options.prompt,
    });
    await syncSessionDocument(context, sessionId);
    const dispatch = await context.modules.session.dispatchLodyTurn(
      context.runtime,
      started,
      context.snapshot.machineId,
      context.snapshot.userId,
      { timeoutMs: 20_000 },
    );
    assertDispatchAccepted(dispatch);
    stderrLog(`turn ${started.userTurnId} accepted for session ${sessionId}`);
    process.stdout.write(`${sessionId}\n`);
  });
}

async function statusSession(sessionId) {
  await withRuntime(async (context) => {
    const status = await readSession(context, sessionId);
    process.stdout.write(`${JSON.stringify(status)}\n`);
  });
}

function parseTimeout(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--timeout") {
    fail("session wait requires --timeout <seconds>");
  }
  const seconds = Number(argumentsList[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) fail("--timeout must be a positive number of seconds");
  return Math.floor(seconds * 1_000);
}

async function waitSession(sessionId, timeoutMs) {
  let terminalStatus;
  const sessionOwner = ownedSession(sessionId);
  const permissions = sessionOwner?.permissions ?? "ask";
  const answeredRequestIds = new Set();
  await withRuntime(async (context) => {
    const deadline = Date.now() + timeoutMs;
    let priorState = null;
    while (Date.now() < deadline) {
      const data = await readSessionData(context, sessionId, priorState === null);
      if (data !== undefined) {
        const requests = pendingPermissionRequests(data.history);
        if (requests.length > 0 && permissions === "ask") {
          const request = requests[0];
          terminalStatus = {
            ...data.summary,
            state: "awaitingPermission",
            permissionRequest: {
              requestId: request.requestId,
              optionIds: request.options.map((option) => option.optionId),
              toolSummary: request.toolSummary,
            },
          };
          break;
        }
        if (requests.length > 0) {
          if (sessionOwner === null) {
            fail(`refusing to answer permission for unowned session ${sessionId}`);
          }
          await answerSessionPermissions({
            sessionId,
            permissions,
            history: data.history,
            answeredRequestIds,
            respond: async (response) => {
              await context.runtime.writer.respondSessionPermission(
                response.sessionId,
                response.requestId,
                response.outcome,
              );
            },
            log: stderrLog,
          });
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const status = data.summary;
        if (status.state !== priorState) {
          stderrLog(`session ${sessionId}: ${status.state}`);
          priorState = status.state;
        }
        if (status.state === "completed" || status.state === "error") {
          terminalStatus = status;
          break;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (terminalStatus === undefined) {
      terminalStatus = {
        sessionId,
        state: "error",
        turnId: null,
        reason: "timeout",
        message: `Timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`,
        lastAssistantText: null,
      };
    }
  });
  process.stdout.write(`${JSON.stringify(terminalStatus)}\n`);
  if (terminalStatus.state !== "completed") process.exitCode = 1;
}

function activeAssistantTurnId(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (typeof entry !== "object" || entry === null || entry.role !== "assistant") continue;
    if (entry.finished === true || typeof entry.endedAt === "number") return null;
    return typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
  }
  return null;
}

async function cancelSession(sessionId) {
  let result;
  await withRuntime(async (context) => {
    const data = await readSessionData(context, sessionId);
    const turnId = activeAssistantTurnId(data.history);
    if (turnId === null) fail(`session ${sessionId} has no active assistant turn to cancel`);
    result = await context.runtime.requestSessionCancel(
      context.snapshot.machineId,
      sessionId,
      turnId,
      { timeoutMs: 20_000 },
    );
    if (result === null) fail(`session ${sessionId} cancel received no response`);
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.success !== true) process.exitCode = 1;
}

async function listSessions() {
  await withRuntime(async (context) => {
    const state = parseState();
    const entries = await context.runtime.repo.listDoc();
    const sessions = entries
      .filter((entry) =>
        context.modules.shared.isSessionDocRoomId(entry.docId) &&
        !context.modules.shared.isLoroRepoDocDeleted(entry)
      )
      .map((entry) => {
        const sessionId = context.modules.shared.getSessionIdFromRoomId(entry.docId);
        const status = typeof entry.meta.status === "object" && entry.meta.status !== null &&
          typeof entry.meta.status.type === "string"
          ? entry.meta.status.type
          : "idle";
        return {
          sessionId,
          status,
          agentType: typeof entry.meta.agentType === "string" ? entry.meta.agentType : null,
          title: typeof entry.meta.title === "string" ? entry.meta.title : null,
          archived: entry.meta.isArchived === true,
          owned: sessionId !== null && state.sessions?.[sessionId] !== undefined,
        };
      })
      .filter((session) => session.sessionId !== null)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    process.stdout.write(`${JSON.stringify({ sessions })}\n`);
  });
}

function requireSessionId(value) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) fail("a session id is required");
  return value;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length === 0 || argumentsList[0] === "--help" || argumentsList[0] === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (argumentsList[0] === "open") {
    await openTunnel(argumentsList.slice(1));
    return;
  }
  if (argumentsList[0] !== "session") fail(`unknown command: ${argumentsList[0]}`);
  const action = argumentsList[1];
  if (action === "create") {
    await createSession(argumentsList.slice(2));
    return;
  }
  if (action === "list") {
    if (argumentsList.length !== 2) fail("session list takes no arguments");
    await listSessions();
    return;
  }
  const sessionId = requireSessionId(argumentsList[2]);
  if (action === "prompt") {
    await promptSession(sessionId, parsePromptArguments(argumentsList.slice(3)));
    return;
  }
  if (action === "status") {
    if (argumentsList.length !== 3) fail("session status requires only <session-id>");
    await statusSession(sessionId);
    return;
  }
  if (action === "wait") {
    await waitSession(sessionId, parseTimeout(argumentsList.slice(3)));
    return;
  }
  if (action === "cancel") {
    if (argumentsList.length !== 3) fail("session cancel requires only <session-id>");
    await cancelSession(sessionId);
    return;
  }
  fail(`unknown session action: ${String(action)}`);
}

await main().catch((cause) => {
  originalConsoleError(`session-driver: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
  process.exitCode = 1;
});

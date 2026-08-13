#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELECTABLE_SUITE_NAMES = Object.freeze([
  "quota-seam",
  "volumes",
  "destroy-while-creating",
  "broker-best-effort",
]);
const SUITE_ENVIRONMENT_VARIABLE = "COVERAGE_SUITE";

function usage() {
  return [
    "Usage: node e2e/coverage.mjs [--suite <name>]",
    "",
    `Environment: ${SUITE_ENVIRONMENT_VARIABLE}=<name>`,
    `Suites: ${SELECTABLE_SUITE_NAMES.join(", ")}`,
    "",
    "Options:",
    "  --suite <name>  Run only the named workload suite.",
    "  --help, -h      Print this help and exit before live initialization.",
    "",
    "Preflight and teardown always run around selected suites during live execution.",
  ].join("\n");
}

function parseOptions(args, environment) {
  let argumentSuite;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--suite") {
      if (argumentSuite !== undefined) throw new Error("--suite may only be specified once");
      index += 1;
      if (index >= args.length) throw new Error("--suite requires a suite name");
      argumentSuite = args[index];
    } else if (argument.startsWith("--suite=")) {
      if (argumentSuite !== undefined) throw new Error("--suite may only be specified once");
      argumentSuite = argument.slice("--suite=".length);
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const requestedSuite = argumentSuite ?? environment[SUITE_ENVIRONMENT_VARIABLE];
  const selectedSuiteNames = requestedSuite === undefined
    ? [...SELECTABLE_SUITE_NAMES]
    : [requestedSuite.trim()];
  if (!SELECTABLE_SUITE_NAMES.includes(selectedSuiteNames[0])) {
    throw new Error(
      `unknown suite: ${JSON.stringify(selectedSuiteNames[0])}; expected one of: ${SELECTABLE_SUITE_NAMES.join(", ")}`,
    );
  }
  return { help, selectedSuiteNames };
}

let options;
try {
  options = parseOptions(process.argv.slice(2), process.env);
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exit(2);
}

if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const selectedSuiteNames = new Set(options.selectedSuiteNames);

const DEFAULT_CP_URL = "https://blitz-control-plane.blitzapp.workers.dev";
const DEFAULT_LEDGER =
  "/private/tmp/claude-501/-Users-minjunes-blitz-core/04b1d3bc-f75f-42dd-8392-58b453d06f5a/scratchpad/w3-workspace-id";
const DEFAULT_WORK_ROOT =
  "/private/tmp/claude-501/-Users-minjunes-blitz-core/04b1d3bc-f75f-42dd-8392-58b453d06f5a/scratchpad/coverage";
const HETZNER_API = "https://api.hetzner.cloud/v1";
const MAX_WORKSPACE_CREATES = 4;
const ACTIVE_PHASES = new Set(["creating", "ready", "destroying", "error"]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");
const runToken = randomBytes(6).toString("hex");
const runLabel = `blitz-coverage-${runToken}`;
const workDir = join(process.env.WORK_DIR ?? DEFAULT_WORK_ROOT, runToken);
const ledgerPath = process.env.WORKSPACE_LEDGER ?? DEFAULT_LEDGER;
const cpUrl = (process.env.CP_URL ?? DEFAULT_CP_URL).replace(/\/+$/u, "");
const machineTypeId = process.env.MACHINE_TYPE ?? "cx23@fsn1";
const volumeLocation = process.env.VOLUME_LOCATION ?? "fsn1";

function readEnvValue(name) {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    if (!line.startsWith(`${name}=`)) continue;
    const raw = line.slice(name.length + 1);
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return undefined;
}

const operatorKey =
  process.env.OPERATOR_API_KEY ?? readEnvValue("OPERATOR_API_KEY") ?? "";
const hetznerToken =
  process.env.HETZNER_API_TOKEN ??
  process.env.HETZNER_API_KEY ??
  readEnvValue("HETZNER_API_TOKEN") ??
  readEnvValue("HETZNER_API_KEY") ??
  "";
const sensitiveValues = [operatorKey, hetznerToken].filter((value) => value.length > 0);

const suites = [];
const workspaceIds = [];
const workspaceIdSet = new Set();
const volumeIds = [];
const volumeIdSet = new Set();
const details = {
  runLabel,
  target: cpUrl,
  quota: null,
  volumePersistence: null,
  destroyWhileCreating: null,
  broker: {
    build: "not attempted",
    container: "not created",
    enrollment: "not attempted",
    approvalStatus: null,
    stateProof: null,
    deregistration: "not attempted",
    transcript: [],
    gap: null,
  },
  teardown: null,
};

let cookie = null;
let publicKey = null;
let privateKeyPath = null;
let createRequests = 0;
let preservedVolumeId = null;

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function redact(value, limit = 2_000) {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) text = text.split(sensitive).join("[REDACTED]");
  }
  text = text.replace(/\b[A-F0-9]{4}-[A-F0-9]{4}\b/gu, "[USER-CODE REDACTED]");
  return text.trim().slice(0, limit);
}

function shortError(error) {
  return redact(error instanceof Error ? error.message : error, 1_000).replace(/\s+/gu, " ");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function endpoint(pathname) {
  return `${cpUrl}${pathname}`;
}

async function jsonResponse(response) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiError(body) {
  return body !== null && typeof body === "object" && typeof body.error === "string"
    ? `; error=${body.error}`
    : "";
}

async function requestJson(url, init = {}, timeoutMs = 30_000) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, body: await jsonResponse(response) };
}

async function mintSession() {
  const { response, body } = await requestJson(endpoint("/sessions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${operatorKey}` },
  });
  assert(response.status === 204, `session login HTTP ${response.status}; expected 204${apiError(body)}`);
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  const sessionHeader = setCookies.find((value) => value.startsWith("blitz_session="));
  const sessionCookie = sessionHeader?.split(";", 1)[0]?.trim();
  assert(
    sessionCookie !== undefined && sessionCookie.startsWith("blitz_session="),
    "session login did not return a blitz_session cookie",
  );
  sensitiveValues.push(sessionCookie);
  return sessionCookie;
}

async function controlPlane(pathname, init = {}, timeoutMs = 30_000) {
  assert(cookie !== null, "control-plane session is unavailable");
  return requestJson(
    endpoint(pathname),
    {
      ...init,
      headers: {
        Cookie: cookie,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    },
    timeoutMs,
  );
}

async function listWorkspaces() {
  const { response, body } = await controlPlane("/workspaces");
  assert(response.status === 200, `GET /workspaces HTTP ${response.status}${apiError(body)}`);
  assert(body !== null && typeof body === "object" && Array.isArray(body.workspaces), "GET /workspaces did not return a list");
  return body.workspaces;
}

async function listVolumes() {
  const { response, body } = await controlPlane("/volumes");
  assert(response.status === 200, `GET /volumes HTTP ${response.status}${apiError(body)}`);
  assert(body !== null && typeof body === "object" && Array.isArray(body.volumes), "GET /volumes did not return a list");
  return body.volumes;
}

function activeWorkspaces(workspaces) {
  return workspaces.filter((workspace) => ACTIVE_PHASES.has(workspace?.phase));
}

function recordWorkspaceId(id) {
  if (workspaceIdSet.has(id)) return;
  assert(workspaceIds.length < MAX_WORKSPACE_CREATES, `workspace create budget of ${MAX_WORKSPACE_CREATES} would be exceeded`);
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  appendFileSync(ledgerPath, `${id}\n`, { encoding: "utf8", mode: 0o600 });
  workspaceIdSet.add(id);
  workspaceIds.push(id);
  console.log(`EVIDENCE ledger workspace=${id}; path=${ledgerPath}`);
}

function reserveCreate() {
  assert(createRequests < MAX_WORKSPACE_CREATES, `workspace create request budget of ${MAX_WORKSPACE_CREATES} exhausted`);
  createRequests += 1;
}

async function createWorkspace(volumeId = undefined) {
  reserveCreate();
  const beforeIds = new Set((await listWorkspaces()).map((workspace) => workspace?.id));
  let response;
  let body;
  try {
    ({ response, body } = await controlPlane(
      "/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          machineTypeId,
          sshPublicKey: publicKey,
          ...(volumeId === undefined ? {} : { volumeId }),
        }),
      },
      90_000,
    ));
  } catch (error) {
    // A timed-out POST can still have committed. Recover any new row before
    // surfacing the error so its id reaches the safety ledger and finalizer.
    try {
      const after = await listWorkspaces();
      for (const workspace of after) {
        if (typeof workspace?.id === "string" && !beforeIds.has(workspace.id)) {
          recordWorkspaceId(workspace.id);
        }
      }
    } catch {
      // The exact-label provider audit in the outer finalizer remains the last
      // line of defense when both the POST and recovery poll are unavailable.
    }
    throw error;
  }
  const workspace = body !== null && typeof body === "object" ? body.workspace : null;
  if (workspace !== null && typeof workspace?.id === "string") recordWorkspaceId(workspace.id);
  assert(response.status === 201, `POST /workspaces HTTP ${response.status}; expected 201${apiError(body)}`);
  assert(workspace !== null && typeof workspace?.id === "string", "POST /workspaces did not return workspace.id");
  assert(
    workspace.phase === "creating" || workspace.phase === "ready",
    `workspace ${workspace.id} returned phase=${workspace.phase ?? "missing"}; error=${workspace.error ?? "none"}`,
  );
  if (volumeId !== undefined) {
    assert(workspace.volumeId === volumeId, `workspace ${workspace.id} did not retain volumeId=${volumeId}`);
  }
  return workspace;
}

async function waitForWorkspace(id, wantedPhase, timeoutMs, observations = undefined) {
  const deadline = Date.now() + timeoutMs;
  let lastPhase = "unknown";
  while (Date.now() <= deadline) {
    const workspace = (await listWorkspaces()).find((candidate) => candidate?.id === id) ?? null;
    assert(workspace !== null, `workspace ${id} is missing from GET /workspaces`);
    const phase = String(workspace.phase ?? "missing");
    if (phase !== lastPhase) {
      observations?.push({ at: new Date().toISOString(), phase });
      lastPhase = phase;
    }
    if (phase === wantedPhase) return workspace;
    if (phase === "error") throw new Error(`workspace ${id} reached phase=error; error=${workspace.error ?? "unspecified"}`);
    if (wantedPhase === "ready" && (phase === "destroying" || phase === "destroyed")) {
      throw new Error(`workspace ${id} reached unexpected phase=${phase}`);
    }
    await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`workspace ${id} timed out waiting for phase=${wantedPhase}; last phase=${lastPhase}`);
}

async function deleteWorkspace(id, options = {}) {
  const observations = options.observations;
  if (options.freshSession === true) cookie = await mintSession();
  const requestAt = new Date().toISOString();
  const requestStartedMs = Date.now();
  const { response, body } = await controlPlane(
    `/workspaces/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    90_000,
  );
  const responseAt = new Date().toISOString();
  assert(response.status >= 200 && response.status < 300, `DELETE /workspaces/${id} HTTP ${response.status}${apiError(body)}`);
  const returned = body !== null && typeof body === "object" ? body.workspace : null;
  if (returned !== null && typeof returned?.phase === "string") {
    observations?.push({ at: responseAt, phase: returned.phase, source: "DELETE response" });
  }
  const destroyed = returned?.phase === "destroyed"
    ? returned
    : await waitForWorkspace(id, "destroyed", 180_000, observations);
  return {
    workspace: destroyed,
    requestAt,
    responseAt,
    durationMs: Date.now() - requestStartedMs,
    status: response.status,
  };
}

async function waitForVolume(id, wantedStatus, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() <= deadline) {
    const volume = (await listVolumes()).find((candidate) => candidate?.id === id) ?? null;
    assert(volume !== null, `volume ${id} disappeared while waiting for status=${wantedStatus}`);
    lastStatus = String(volume.status ?? "missing");
    if (lastStatus === wantedStatus) return volume;
    await sleep(Math.min(3_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`volume ${id} timed out waiting for status=${wantedStatus}; last status=${lastStatus}`);
}

async function hetznerRequest(pathname, init = {}, notFoundIsNull = false) {
  assert(hetznerToken.length > 0, "Hetzner API token is unavailable");
  const { response, body } = await requestJson(
    `${HETZNER_API}${pathname}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${hetznerToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    },
    30_000,
  );
  if (notFoundIsNull && response.status === 404) return null;
  assert(response.ok, `Hetzner ${init.method ?? "GET"} ${pathname} HTTP ${response.status}${apiError(body)}`);
  return body;
}

async function listHetzner(pathname, field, query = {}) {
  const result = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ ...query, per_page: "50", page: String(page) });
    const body = await hetznerRequest(`${pathname}?${params.toString()}`);
    assert(body !== null && typeof body === "object" && Array.isArray(body[field]), `invalid Hetzner ${field} list`);
    result.push(...body[field]);
    const nextPage = body?.meta?.pagination?.next_page;
    if (typeof nextPage !== "number") return result;
    page = nextPage;
  }
}

async function serversForWorkspace(id) {
  return listHetzner("/servers", "servers", { label_selector: `blitz-workspace=${id}` });
}

async function waitForLabelZero(id, timeoutMs = 180_000) {
  const started = Date.now();
  const samples = [];
  let lastCount = null;
  while (Date.now() - started <= timeoutMs) {
    const count = (await serversForWorkspace(id)).length;
    if (count !== lastCount) {
      samples.push({ elapsedMs: Date.now() - started, count });
      lastCount = count;
    }
    if (count === 0) return { elapsedMs: Date.now() - started, samples };
    await sleep(3_000);
  }
  throw new Error(`Hetzner label query for workspace ${id} did not reach zero within ${timeoutMs / 1_000}s`);
}

function commandFailure(result) {
  if (result.error !== undefined) return shortError(result.error);
  const stderr = String(result.stderr ?? "").trim();
  return stderr.length > 0 ? redact(stderr, 1_000).replace(/\s+/gu, " ") : `exit ${result.status ?? "unknown"}`;
}

function generateKeypair() {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const keyPath = join(workDir, "id_ed25519");
  const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", runLabel, "-f", keyPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert(generated.status === 0, `ssh-keygen failed: ${commandFailure(generated)}`);
  const key = readFileSync(`${keyPath}.pub`, "utf8").trim();
  assert(key.startsWith("ssh-ed25519 "), "generated public key is not ed25519");
  privateKeyPath = keyPath;
  publicKey = key;
}

function sshArgs(workspace, knownHostsPath, remoteCommand) {
  return [
    "-i",
    privateKeyPath,
    "-p",
    String(workspace.ssh.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    `${workspace.ssh.user}@${workspace.ssh.host}`,
    remoteCommand,
  ];
}

async function boxSsh(workspace, remoteCommand, label) {
  assert(workspace?.ssh !== null && typeof workspace?.ssh === "object", `${label} has no SSH metadata`);
  assert(typeof workspace.ssh.hostPublicKey === "string" && workspace.ssh.hostPublicKey.startsWith("ssh-"), `${label} has no SSH host key`);
  const knownHostsPath = join(workDir, `known_hosts_${workspace.id}`);
  const knownHostName = workspace.ssh.port === 22
    ? workspace.ssh.host
    : `[${workspace.ssh.host}]:${workspace.ssh.port}`;
  writeFileSync(
    knownHostsPath,
    `${knownHostName} ${workspace.ssh.hostPublicKey.split(/\r?\n/u)[0].trim()}\n`,
    { mode: 0o600 },
  );
  const deadline = Date.now() + 90_000;
  let lastFailure = "not attempted";
  while (Date.now() <= deadline) {
    const result = spawnSync("ssh", sshArgs(workspace, knownHostsPath, remoteCommand), {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (result.status === 0) return String(result.stdout).trim();
    lastFailure = commandFailure(result);
    await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${label} SSH failed within 90s; last failure=${lastFailure}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function cleanupWorkspace(id) {
  try {
    cookie = await mintSession();
    const workspace = (await listWorkspaces()).find((candidate) => candidate?.id === id) ?? null;
    if (workspace !== null && workspace.phase !== "destroyed") {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await deleteWorkspace(id);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await sleep(attempt * 2_000);
        }
      }
      if (lastError !== null) throw lastError;
    }
    await waitForLabelZero(id);
    return;
  } catch (controlPlaneError) {
    console.log(`EVIDENCE cleanup workspace=${id}; control-plane retry exhausted; exact-label provider fallback`);
    const servers = await serversForWorkspace(id);
    for (const server of servers) {
      assert(typeof server?.id === "number", `labeled server for ${id} has no numeric id`);
      await hetznerRequest(`/servers/${server.id}`, { method: "DELETE" }, true);
    }
    await waitForLabelZero(id);
    cookie = await mintSession();
    try {
      await deleteWorkspace(id);
    } catch (retryError) {
      throw new Error(
        `workspace ${id} provider resource was removed, but API tombstone cleanup failed: ${shortError(retryError)}; initial=${shortError(controlPlaneError)}`,
      );
    }
  }
}

async function deleteVolumeViaControlPlane(id) {
  const { response, body } = await controlPlane(`/volumes/${encodeURIComponent(id)}`, { method: "DELETE" });
  assert(response.status >= 200 && response.status < 300, `DELETE /volumes/${id} HTTP ${response.status}${apiError(body)}`);
  const remaining = (await listVolumes()).filter((volume) => volume?.id === id);
  assert(remaining.length === 0, `volume ${id} remains after control-plane DELETE`);
}

async function cleanupVolume(id) {
  cookie = await mintSession();
  const apiVolume = (await listVolumes()).find((volume) => volume?.id === id) ?? null;
  if (apiVolume !== null) {
    if (apiVolume.status === "attached") await waitForVolume(id, "available");
    try {
      await deleteVolumeViaControlPlane(id);
    } catch (error) {
      console.log(`EVIDENCE cleanup volume=${id}; control-plane DELETE failed; exact-id provider fallback: ${shortError(error)}`);
      const providerVolume = await hetznerRequest(`/volumes/${encodeURIComponent(id)}`, undefined, true);
      if (providerVolume !== null) {
        const server = providerVolume?.volume?.server;
        if (typeof server === "number") {
          await hetznerRequest(`/volumes/${encodeURIComponent(id)}/actions/detach`, {
            method: "POST",
            body: "{}",
          });
          const deadline = Date.now() + 180_000;
          while (Date.now() <= deadline) {
            const current = await hetznerRequest(`/volumes/${encodeURIComponent(id)}`, undefined, true);
            if (current === null || current?.volume?.server === null) break;
            await sleep(3_000);
          }
        }
        await hetznerRequest(`/volumes/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
      }
    }
  }
  let direct = await hetznerRequest(`/volumes/${encodeURIComponent(id)}`, undefined, true);
  if (direct !== null) {
    const server = direct?.volume?.server;
    if (typeof server === "number") {
      await hetznerRequest(`/volumes/${encodeURIComponent(id)}/actions/detach`, {
        method: "POST",
        body: "{}",
      });
      const deadline = Date.now() + 180_000;
      while (Date.now() <= deadline) {
        direct = await hetznerRequest(`/volumes/${encodeURIComponent(id)}`, undefined, true);
        if (direct === null || direct?.volume?.server === null) break;
        await sleep(3_000);
      }
    }
    await hetznerRequest(`/volumes/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
    direct = await hetznerRequest(`/volumes/${encodeURIComponent(id)}`, undefined, true);
  }
  assert(direct === null, `Hetzner volume ${id} remains after cleanup`);
}

async function runSuite(name, action, { required = true } = {}) {
  const started = Date.now();
  try {
    const evidence = await action();
    const record = {
      name,
      ok: true,
      required,
      durationMs: Date.now() - started,
      evidence: redact(evidence, 2_000).replace(/\s+/gu, " "),
    };
    suites.push(record);
    console.log(`PASS ${name}: ${record.evidence}`);
    return record;
  } catch (error) {
    const record = {
      name,
      ok: false,
      required,
      durationMs: Date.now() - started,
      evidence: shortError(error),
    };
    suites.push(record);
    console.log(`FAIL ${name}: ${record.evidence}`);
    return record;
  }
}

function dockerEnvironment() {
  const environment = { ...process.env };
  delete environment.DOCKER_HOST;
  return environment;
}

function appendCapped(current, chunk, limit = 32_000) {
  const next = current + String(chunk);
  return next.length <= limit ? next : next.slice(next.length - limit);
}

async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
  const heartbeat = options.heartbeatLabel === undefined
    ? null
    : setInterval(() => {
        console.log(`EVIDENCE ${options.heartbeatLabel}; elapsed=${Math.round((Date.now() - started) / 1_000)}s`);
      }, 30_000);
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const result = await new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ status: null, signal: null, error }));
    child.once("close", (status, signal) => resolveResult({ status, signal, error: null }));
  });
  clearTimeout(timeout);
  if (heartbeat !== null) clearInterval(heartbeat);
  return { ...result, stdout, stderr, durationMs: Date.now() - started };
}

function processError(result) {
  if (result.error !== null) return shortError(result.error);
  const output = redact(result.stderr || result.stdout, 2_000).replace(/\s+/gu, " ");
  return output.length > 0 ? output : `exit=${result.status ?? "unknown"}; signal=${result.signal ?? "none"}`;
}

async function brokerEnrollment(containerName, advertisedPort) {
  const child = spawn(
    "docker",
    [
      "exec",
      containerName,
      "blitz-broker",
      "enroll",
      "--origin",
      cpUrl,
      "--host",
      "127.0.0.1",
      "--port",
      String(advertisedPort),
    ],
    { cwd: repoRoot, env: dockerEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let instructionsResolved = false;
  let resolveInstructions;
  const instructions = new Promise((resolveValue) => { resolveInstructions = resolveValue; });
  const inspectInstructions = () => {
    if (instructionsResolved) return;
    const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const verificationUri = lines.find((line) => /^https?:\/\//u.test(line));
    const userCode = lines.find((line) => /^[A-F0-9]{4}-[A-F0-9]{4}$/u.test(line));
    if (verificationUri !== undefined && userCode !== undefined) {
      instructionsResolved = true;
      resolveInstructions({ verificationUri, userCode });
    }
  };
  child.stdout.on("data", (chunk) => {
    stdout = appendCapped(stdout, chunk);
    inspectInstructions();
  });
  child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
  const closed = new Promise((resolveClose) => {
    child.once("error", (error) => resolveClose({ status: null, signal: null, error }));
    child.once("close", (status, signal) => resolveClose({ status, signal, error: null }));
  });
  const first = await Promise.race([
    instructions.then((value) => ({ kind: "instructions", value })),
    closed.then((value) => ({ kind: "closed", value })),
    new Promise((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), 60_000);
      instructions.finally(() => clearTimeout(timer));
      closed.finally(() => clearTimeout(timer));
    }),
  ]);
  let approvalStatus = null;
  let verificationUri = null;
  if (first.kind === "instructions") {
    verificationUri = first.value.verificationUri;
    const expectedUri = `${cpUrl}/oauth/device/approve`;
    assert(verificationUri === expectedUri, `broker returned unexpected verification URI ${verificationUri}`);
    const { response, body } = await controlPlane("/oauth/device/approve", {
      method: "POST",
      body: JSON.stringify({ user_code: first.value.userCode }),
    });
    approvalStatus = response.status;
    if (response.status !== 204) {
      child.kill("SIGTERM");
      throw new Error(`POST /oauth/device/approve HTTP ${response.status}; expected 204${apiError(body)}`);
    }
  } else if (first.kind === "timeout") {
    child.kill("SIGTERM");
    throw new Error("broker enroll emitted no device instructions within 60s");
  }
  let result;
  if (first.kind === "closed") {
    result = first.value;
  } else {
    let closeTimer;
    result = await Promise.race([
      closed.finally(() => clearTimeout(closeTimer)),
      new Promise((resolveTimeout) => {
        closeTimer = setTimeout(() => {
          child.kill("SIGTERM");
          resolveTimeout({ status: null, signal: "timeout", error: null });
        }, 120_000);
      }),
    ]);
  }
  return { ...result, stdout, stderr, approvalStatus, verificationUri };
}

async function deregisterBroker(containerName) {
  const script = String.raw`
const { readFile } = await import("node:fs/promises");
const credential = JSON.parse(await readFile("/var/lib/blitz-broker/box-credential.json", "utf8"));
const response = await fetch(process.argv[1] + "/boxes/" + encodeURIComponent(credential.box_id) + "/broker", {
  method: "DELETE",
  headers: { Authorization: "Bearer " + credential.access_token },
});
console.log("HTTP " + response.status);
if (response.status !== 204) process.exit(1);
`;
  return runCommand(
    "docker",
    ["exec", containerName, "node", "--input-type=module", "--eval", script, cpUrl],
    { env: dockerEnvironment(), timeoutMs: 30_000 },
  );
}

async function runBrokerSuite() {
  const image = `blitz-broker:coverage-${runToken}`;
  const containerName = `blitz-coverage-broker-${runToken}`;
  const volumeName = `blitz-coverage-broker-state-${runToken}`;
  let containerCreated = false;
  let volumeCreated = false;
  let enrolled = false;
  let primaryError = null;
  try {
    console.log(`EVIDENCE broker build image=${image}; Dockerfile=packages/broker/Dockerfile`);
    const build = await runCommand(
      "docker",
      ["build", "--progress=plain", "--file", "packages/broker/Dockerfile", "--tag", image, "packages/broker"],
      { env: dockerEnvironment(), timeoutMs: 1_200_000, heartbeatLabel: "broker build running" },
    );
    if (build.status !== 0) {
      details.broker.gap = `local image build failed: ${processError(build)}`;
      throw new Error(details.broker.gap);
    }
    details.broker.build = `PASS in ${Math.round(build.durationMs / 1_000)}s`;

    const volumeCreate = await runCommand(
      "docker",
      ["volume", "create", "--label", `blitz.coverage.run=${runLabel}`, volumeName],
      { env: dockerEnvironment(), timeoutMs: 30_000 },
    );
    assert(volumeCreate.status === 0, `docker volume create failed: ${processError(volumeCreate)}`);
    volumeCreated = true;

    const run = await runCommand(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        containerName,
        "--label",
        `blitz.coverage.run=${runLabel}`,
        "--publish",
        "127.0.0.1::22",
        "--volume",
        `${volumeName}:/var/lib/blitz-broker`,
        image,
      ],
      { env: dockerEnvironment(), timeoutMs: 60_000 },
    );
    assert(run.status === 0, `docker run failed: ${processError(run)}`);
    containerCreated = true;
    details.broker.container = "PASS running with labeled state volume";
    await sleep(2_000);
    const portResult = await runCommand(
      "docker",
      ["port", containerName, "22/tcp"],
      { env: dockerEnvironment(), timeoutMs: 30_000 },
    );
    assert(portResult.status === 0, `docker port failed: ${processError(portResult)}`);
    const portMatch = portResult.stdout.trim().match(/:(\d+)$/u);
    assert(portMatch !== null, `docker port returned an invalid mapping: ${redact(portResult.stdout)}`);

    const enrollment = await brokerEnrollment(containerName, Number(portMatch[1]));
    details.broker.approvalStatus = enrollment.approvalStatus;
    details.broker.transcript = [
      ...enrollment.stdout.split(/\r?\n/u),
      ...enrollment.stderr.split(/\r?\n/u).map((line) => (line === "" ? "" : `stderr: ${line}`)),
      `exit=${enrollment.status ?? "null"}; signal=${enrollment.signal ?? "none"}`,
    ].filter(Boolean).map((line) => redact(line, 1_000));
    if (enrollment.status !== 0) {
      const reason = redact(enrollment.stderr || enrollment.stdout, 2_000).replace(/\s+/gu, " ");
      details.broker.gap = `enrollment stopped after device authorization${enrollment.approvalStatus === 204 ? " and approval" : ""}: ${reason || `exit=${enrollment.status}`}`;
      throw new Error(details.broker.gap);
    }
    enrolled = true;
    details.broker.enrollment = "PASS device authorization, operator approval, token exchange, and PUT /boxes/:id/broker";

    const state = await runCommand(
      "docker",
      [
        "exec",
        containerName,
        "sh",
        "-c",
        "test -s /var/lib/blitz-broker/origin && test -s /var/lib/blitz-broker/box-credential.json && stat -c 'credential_mode=%a credential_bytes=%s' /var/lib/blitz-broker/box-credential.json",
      ],
      { env: dockerEnvironment(), timeoutMs: 30_000 },
    );
    assert(state.status === 0, `broker state proof failed: ${processError(state)}`);
    assert(/^credential_mode=600 credential_bytes=\d+$/u.test(state.stdout.trim()), `unexpected credential proof: ${redact(state.stdout)}`);
    details.broker.stateProof = state.stdout.trim();
    details.broker.gap = null;
    return `image built; container ran; enroll exit=0; approval HTTP 204; ${state.stdout.trim()}; registry endpoint accepted broker`;
  } catch (error) {
    primaryError = error;
    if (details.broker.gap === null) details.broker.gap = shortError(error);
    throw error;
  } finally {
    const cleanupErrors = [];
    if (enrolled && containerCreated) {
      const deregister = await deregisterBroker(containerName);
      if (deregister.status === 0 && deregister.stdout.trim() === "HTTP 204") {
        details.broker.deregistration = "PASS DELETE /boxes/:id/broker HTTP 204";
      } else {
        details.broker.deregistration = `FAIL ${processError(deregister)}`;
        cleanupErrors.push(`broker deregistration failed: ${processError(deregister)}`);
      }
    }
    if (containerCreated) {
      const removed = await runCommand("docker", ["rm", "--force", containerName], {
        env: dockerEnvironment(),
        timeoutMs: 30_000,
      });
      if (removed.status !== 0) cleanupErrors.push(`container cleanup failed: ${processError(removed)}`);
    }
    if (volumeCreated) {
      const removed = await runCommand("docker", ["volume", "rm", "--force", volumeName], {
        env: dockerEnvironment(),
        timeoutMs: 30_000,
      });
      if (removed.status !== 0) cleanupErrors.push(`Docker volume cleanup failed: ${processError(removed)}`);
    }
    if (primaryError === null && cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.join("; "));
    }
    if (cleanupErrors.length > 0) {
      console.log(`FAIL broker-cleanup: ${redact(cleanupErrors.join("; "))}`);
    }
  }
}

let preflightOk = false;
try {
  const preflight = await runSuite("preflight", async () => {
    assert(new URL(cpUrl).origin === cpUrl, "CP_URL must be an absolute origin without a path");
    assert(operatorKey.length > 0, "OPERATOR_API_KEY is missing from the environment and .env");
    assert(hetznerToken.length > 0, "HETZNER_API_KEY/HETZNER_API_TOKEN is missing from the environment and .env");
    generateKeypair();
    cookie = await mintSession();
    const workspaces = await listWorkspaces();
    const active = activeWorkspaces(workspaces);
    assert(active.length === 0, `preflight requires zero non-destroyed workspaces; found ${active.length}`);
    const labeledServers = await listHetzner("/servers", "servers", {
      label_selector: "blitz-purpose=workspace",
    });
    assert(labeledServers.length === 0, `preflight requires zero Hetzner servers labeled blitz-purpose=workspace; found ${labeledServers.length}`);
    return `session HTTP 204; API active=0; Hetzner label blitz-purpose=workspace count=0; create budget=${MAX_WORKSPACE_CREATES}`;
  });
  preflightOk = preflight.ok;

  if (preflightOk) {
    if (selectedSuiteNames.has("quota-seam")) await runSuite("quota-seam", async () => {
      const before = await listWorkspaces();
      const activeBefore = activeWorkspaces(before).length;
      assert(activeBefore === 0, `quota seam requires active count=0; found ${activeBefore}`);
      const { response, body } = await controlPlane("/workspaces", {
        method: "POST",
        body: JSON.stringify({ machineTypeId: "", sshPublicKey: publicKey }),
      });
      assert(response.status === 400, `invalid machineType seam returned HTTP ${response.status}; expected validation HTTP 400, not quota HTTP 409${apiError(body)}`);
      assert(!String(body?.error ?? "").toLowerCase().includes("quota"), `invalid machineType was rejected by quota path: ${body?.error}`);
      const after = await listWorkspaces();
      assert(after.length === before.length, `invalid machineType request created a workspace tombstone (${before.length} -> ${after.length})`);
      assert(activeWorkspaces(after).length === 0, "invalid machineType request changed active workspace count");
      details.quota = {
        mode: "validation seam check, not a load test",
        activeBefore,
        request: "machineTypeId was the empty string",
        responseStatus: response.status,
        quotaStatus: 409,
        workspaceRowsAdded: after.length - before.length,
        realCreates: 0,
      };
      return `activeBefore=0; invalid machineType HTTP 400 (quota would be 409); rowsAdded=0; realCreates=0; seam check only`;
    });

    if (selectedSuiteNames.has("volumes")) await runSuite("volumes", async () => {
      let volumeId = null;
      const suiteWorkspaceIds = [];
      const markerNonce = `coverage-${randomBytes(16).toString("hex")}`;
      const markerPath = "/var/lib/blitz/coverage-marker";
      let firstRead = null;
      let secondRead = null;
      let survivalProof = null;
      let secondCreateStarted = false;
      details.volumePersistence = {
        volumeId,
        markerPath,
        markerNonce,
        firstRead,
        secondRead,
        nonceMatch: false,
        afterFirstDestroy: survivalProof,
        workspaceIds: [...suiteWorkspaceIds],
        deleted: false,
        secondCreateStarted,
        preserved: false,
        preservedVolumeId: null,
        preservationReason: null,
        preservationVerified: false,
        preservedControlPlaneStatus: null,
        preservedControlPlaneAttachedTo: null,
        preservedHetznerServer: null,
        failure: null,
      };
      try {
        const { response, body } = await controlPlane("/volumes", {
          method: "POST",
          body: JSON.stringify({ name: runLabel, sizeGb: 10, location: volumeLocation }),
        });
        const volume = body !== null && typeof body === "object" ? body.volume : null;
        if (volume !== null && typeof volume?.id === "string") {
          volumeId = volume.id;
          if (!volumeIdSet.has(volumeId)) {
            volumeIdSet.add(volumeId);
            volumeIds.push(volumeId);
          }
          console.log(`EVIDENCE volume created id=${volumeId}; size=${volume.sizeGb}; location=${volume.location}`);
          details.volumePersistence.volumeId = volumeId;
        }
        assert(response.status === 201, `POST /volumes HTTP ${response.status}; expected 201${apiError(body)}`);
        assert(volumeId !== null, "POST /volumes did not return volume.id");
        assert(volume.sizeGb === 10 && volume.location === volumeLocation, `created volume metadata mismatch: ${JSON.stringify(volume)}`);

        const first = await createWorkspace(volumeId);
        suiteWorkspaceIds.push(first.id);
        const firstReady = first.phase === "ready" ? first : await waitForWorkspace(first.id, "ready", 900_000);
        firstRead = await boxSsh(
          firstReady,
          `umask 077; printf '%s' ${shellQuote(markerNonce)} > ${shellQuote(markerPath)}; cat ${shellQuote(markerPath)}`,
          "first volume workspace marker write",
        );
        assert(firstRead === markerNonce, `first workspace marker readback mismatch: ${firstRead}`);
        details.volumePersistence.firstRead = firstRead;
        details.volumePersistence.workspaceIds = [...suiteWorkspaceIds];
        await deleteWorkspace(first.id, { freshSession: true });
        const surviving = await waitForVolume(volumeId, "available");
        survivalProof = {
          id: surviving.id,
          status: surviving.status,
          sizeGb: surviving.sizeGb,
          location: surviving.location,
        };
        details.volumePersistence.afterFirstDestroy = survivalProof;
        assert((await serversForWorkspace(first.id)).length === 0, `first workspace ${first.id} still has a labeled Hetzner server`);

        secondCreateStarted = true;
        details.volumePersistence.secondCreateStarted = true;
        const second = await createWorkspace(volumeId);
        suiteWorkspaceIds.push(second.id);
        const secondReady = second.phase === "ready" ? second : await waitForWorkspace(second.id, "ready", 900_000);
        secondRead = await boxSsh(secondReady, `cat ${shellQuote(markerPath)}`, "second volume workspace marker read");
        assert(secondRead === markerNonce, `reattached volume marker mismatch: expected ${markerNonce}; got ${secondRead}`);
        details.volumePersistence.secondRead = secondRead;
        details.volumePersistence.nonceMatch = firstRead === secondRead && secondRead === markerNonce;
        details.volumePersistence.workspaceIds = [...suiteWorkspaceIds];
        await deleteWorkspace(second.id, { freshSession: true });
        await waitForVolume(volumeId, "available");
        assert((await serversForWorkspace(second.id)).length === 0, `second workspace ${second.id} still has a labeled Hetzner server`);
        await deleteVolumeViaControlPlane(volumeId);
        const providerVolume = await hetznerRequest(`/volumes/${encodeURIComponent(volumeId)}`, undefined, true);
        assert(providerVolume === null, `Hetzner volume ${volumeId} survived DELETE /volumes/:id`);
        details.volumePersistence.deleted = true;
        return `volume=${volumeId} survived first destroy as status=${survivalProof.status}; marker path=${markerPath}; nonce=${markerNonce}; reattach read=${secondRead}; match=true; volume deleted`;
      } catch (error) {
        details.volumePersistence.failure = shortError(error);
        details.volumePersistence.workspaceIds = [...suiteWorkspaceIds];
        if (secondCreateStarted && volumeId !== null) {
          preservedVolumeId = volumeId;
          details.volumePersistence.preserved = true;
          details.volumePersistence.preservedVolumeId = volumeId;
          details.volumePersistence.preservationReason = "volumes suite failed after second workspace create started";
          console.log(
            `EVIDENCE INTENTIONAL-RETAINED-VOLUME id=${volumeId}; reason=volumes-suite-failure-after-second-create-started; durable-log=/var/lib/blitz/bootstrap.log`,
          );
        }
        throw error;
      } finally {
        const cleanupErrors = [];
        try {
          const discovered = (await listHetzner("/volumes", "volumes")).filter(
            (volume) => volume?.name === runLabel,
          );
          for (const volume of discovered) {
            const discoveredId = String(volume.id);
            if (!volumeIdSet.has(discoveredId)) {
              volumeIdSet.add(discoveredId);
              volumeIds.push(discoveredId);
              console.log(`EVIDENCE volume recovery discovered id=${discoveredId}; name=${runLabel}`);
            }
            if (volumeId === null) volumeId = discoveredId;
          }
        } catch (error) {
          cleanupErrors.push(`volume discovery failed: ${shortError(error)}`);
        }
        if (volumeId !== null) {
          try {
            for (const workspace of await listWorkspaces()) {
              if (
                workspace?.volumeId === volumeId &&
                typeof workspace?.id === "string" &&
                !suiteWorkspaceIds.includes(workspace.id)
              ) {
                recordWorkspaceId(workspace.id);
                suiteWorkspaceIds.push(workspace.id);
              }
            }
          } catch (error) {
            cleanupErrors.push(`volume workspace recovery failed: ${shortError(error)}`);
          }
        }
        for (const id of [...suiteWorkspaceIds].reverse()) {
          try {
            await cleanupWorkspace(id);
          } catch (error) {
            cleanupErrors.push(shortError(error));
          }
        }
        if (volumeId !== null && volumeId !== preservedVolumeId) {
          try {
            await cleanupVolume(volumeId);
            details.volumePersistence.deleted = true;
          } catch (error) {
            cleanupErrors.push(shortError(error));
          }
        }
        if (cleanupErrors.length > 0) throw new Error(`volume suite cleanup failed: ${cleanupErrors.join("; ")}`);
      }
    });

    if (selectedSuiteNames.has("destroy-while-creating")) await runSuite("destroy-while-creating", async () => {
      const activeBefore = activeWorkspaces(await listWorkspaces()).length;
      assert(activeBefore === 0, `destroy-while-creating requires active count=0; found ${activeBefore}`);
      let workspaceId = null;
      const observations = [];
      try {
        const createRequestAt = new Date().toISOString();
        const createStartedMs = Date.now();
        const workspace = await createWorkspace();
        workspaceId = workspace.id;
        const createResponseAt = new Date().toISOString();
        const createDurationMs = Date.now() - createStartedMs;
        observations.push({ at: createResponseAt, phase: workspace.phase, source: "POST response" });
        assert(workspace.phase === "creating", `immediate destroy prerequisite expected phase=creating; got ${workspace.phase}`);
        const deleteStartedMs = Date.now();
        const deleteDelayMs = deleteStartedMs - (createStartedMs + createDurationMs);
        const destroyed = await deleteWorkspace(workspaceId, { observations });
        assert(deleteDelayMs <= 2_000, `DELETE began ${deleteDelayMs}ms after create response; expected <=2000ms`);
        assert(destroyed.workspace.phase === "destroyed", `workspace ${workspaceId} ended in phase=${destroyed.workspace.phase}`);
        assert(!observations.some((entry) => entry.phase === "error"), `workspace ${workspaceId} passed through phase=error`);
        const label = await waitForLabelZero(workspaceId, 180_000);
        details.destroyWhileCreating = {
          workspaceId,
          createRequestAt,
          createResponseAt,
          createDurationMs,
          deleteRequestAt: destroyed.requestAt,
          deleteResponseAt: destroyed.responseAt,
          deleteDelayAfterCreateResponseMs: deleteDelayMs,
          deleteDurationMs: destroyed.durationMs,
          finalPhase: destroyed.workspace.phase,
          observations,
          labelZeroElapsedMs: label.elapsedMs,
          labelSamples: label.samples,
        };
        return `workspace=${workspaceId}; POST phase=creating; DELETE delay=${deleteDelayMs}ms; DELETE HTTP ${destroyed.status}; final=destroyed; errorSeen=false; labelCount=0 after ${label.elapsedMs}ms`;
      } finally {
        if (workspaceId !== null) await cleanupWorkspace(workspaceId);
      }
    });

    if (selectedSuiteNames.has("broker-best-effort")) {
      await runSuite("broker-best-effort", runBrokerSuite, { required: false });
    }
  } else {
    for (const name of options.selectedSuiteNames) {
      suites.push({ name, ok: false, required: name !== "broker-best-effort", durationMs: 0, evidence: "preflight prerequisite failed" });
      console.log(`FAIL ${name}: preflight prerequisite failed`);
    }
  }
} finally {
  const cleanupProblems = [];
  for (const id of [...workspaceIds].reverse()) {
    try {
      await cleanupWorkspace(id);
    } catch (error) {
      cleanupProblems.push(shortError(error));
    }
  }
  for (const id of [...volumeIds].reverse()) {
    if (id === preservedVolumeId) continue;
    try {
      await cleanupVolume(id);
    } catch (error) {
      cleanupProblems.push(shortError(error));
    }
  }

  await runSuite("teardown", async () => {
    if (cleanupProblems.length > 0) throw new Error(cleanupProblems.join("; "));
    cookie = await mintSession();
    const apiWorkspaces = await listWorkspaces();
    const testRows = apiWorkspaces.filter((workspace) => workspaceIdSet.has(workspace?.id));
    const nonDestroyedTestRows = testRows.filter((workspace) => workspace.phase !== "destroyed");
    const activeAll = activeWorkspaces(apiWorkspaces);
    assert(nonDestroyedTestRows.length === 0, `test workspace tombstones not destroyed=${nonDestroyedTestRows.length}`);
    assert(activeAll.length === 0, `control-plane still has active workspaces=${activeAll.length}`);

    const perWorkspaceLabels = [];
    for (const id of workspaceIds) {
      perWorkspaceLabels.push({ id, count: (await serversForWorkspace(id)).length });
    }
    assert(perWorkspaceLabels.every((entry) => entry.count === 0), `exact workspace label query found servers: ${JSON.stringify(perWorkspaceLabels)}`);
    const allWorkspaceServers = await listHetzner("/servers", "servers", {
      label_selector: "blitz-purpose=workspace",
    });
    assert(allWorkspaceServers.length === 0, `Hetzner blitz-purpose=workspace label query count=${allWorkspaceServers.length}`);

    const apiVolumes = await listVolumes();
    const apiTestVolumes = apiVolumes.filter(
      (volume) => volumeIdSet.has(volume?.id) || volume?.name === runLabel,
    );
    const providerVolumes = await listHetzner("/volumes", "volumes");
    const providerTestVolumes = providerVolumes.filter(
      (volume) => volumeIdSet.has(String(volume?.id)) || volume?.name === runLabel,
    );
    const unexpectedApiTestVolumes = apiTestVolumes.filter(
      (volume) => volume?.id !== preservedVolumeId,
    );
    const unexpectedProviderTestVolumes = providerTestVolumes.filter(
      (volume) => String(volume?.id) !== preservedVolumeId,
    );
    let retainedVolumeProof = null;
    if (preservedVolumeId === null) {
      assert(apiTestVolumes.length === 0, `control-plane volume list still contains test volume ids=${apiTestVolumes.map((volume) => volume.id).join(",")}`);
      assert(providerTestVolumes.length === 0, `Hetzner volumes list still contains test volumes=${providerTestVolumes.length}`);
    } else {
      const apiPreservedVolumes = apiTestVolumes.filter(
        (volume) => volume?.id === preservedVolumeId,
      );
      const providerPreservedVolumes = providerTestVolumes.filter(
        (volume) => String(volume?.id) === preservedVolumeId,
      );
      assert(apiPreservedVolumes.length === 1, `intentional retained volume ${preservedVolumeId} control-plane count=${apiPreservedVolumes.length}; expected 1`);
      assert(apiPreservedVolumes[0].status === "available", `intentional retained volume ${preservedVolumeId} control-plane status=${apiPreservedVolumes[0].status}; expected available`);
      assert(apiPreservedVolumes[0].attachedTo === null, `intentional retained volume ${preservedVolumeId} control-plane attachedTo=${apiPreservedVolumes[0].attachedTo}; expected null`);
      assert(providerPreservedVolumes.length === 1, `intentional retained volume ${preservedVolumeId} Hetzner count=${providerPreservedVolumes.length}; expected 1`);
      assert(providerPreservedVolumes[0].server === null, `intentional retained volume ${preservedVolumeId} remains attached to Hetzner server=${providerPreservedVolumes[0].server}`);
      assert(unexpectedApiTestVolumes.length === 0, `unexpected control-plane test volume leaks=${unexpectedApiTestVolumes.map((volume) => volume.id).join(",")}`);
      assert(unexpectedProviderTestVolumes.length === 0, `unexpected Hetzner test volume leaks=${unexpectedProviderTestVolumes.map((volume) => volume.id).join(",")}`);
      retainedVolumeProof = {
        id: preservedVolumeId,
        controlPlaneStatus: apiPreservedVolumes[0].status,
        hetznerServer: providerPreservedVolumes[0].server,
      };
      details.volumePersistence.preservationVerified = true;
      details.volumePersistence.preservedControlPlaneStatus = apiPreservedVolumes[0].status;
      details.volumePersistence.preservedControlPlaneAttachedTo = apiPreservedVolumes[0].attachedTo;
      details.volumePersistence.preservedHetznerServer = providerPreservedVolumes[0].server;
    }

    const containers = await runCommand(
      "docker",
      ["ps", "--all", "--quiet", "--filter", `label=blitz.coverage.run=${runLabel}`],
      { env: dockerEnvironment(), timeoutMs: 30_000 },
    );
    assert(containers.status === 0, `Docker container audit failed: ${processError(containers)}`);
    const dockerVolumes = await runCommand(
      "docker",
      ["volume", "ls", "--quiet", "--filter", `label=blitz.coverage.run=${runLabel}`],
      { env: dockerEnvironment(), timeoutMs: 30_000 },
    );
    assert(dockerVolumes.status === 0, `Docker volume audit failed: ${processError(dockerVolumes)}`);
    const containerCount = containers.stdout.trim() === "" ? 0 : containers.stdout.trim().split(/\r?\n/u).length;
    const dockerVolumeCount = dockerVolumes.stdout.trim() === "" ? 0 : dockerVolumes.stdout.trim().split(/\r?\n/u).length;
    assert(containerCount === 0, `labeled Docker containers remain=${containerCount}`);
    assert(dockerVolumeCount === 0, `labeled Docker volumes remain=${dockerVolumeCount}`);

    details.teardown = {
      apiActiveWorkspaces: activeAll.length,
      testWorkspaceTombstones: testRows.map((workspace) => ({ id: workspace.id, phase: workspace.phase })),
      exactWorkspaceLabelQueries: perWorkspaceLabels,
      allWorkspacePurposeLabelCount: allWorkspaceServers.length,
      apiTestVolumes: apiTestVolumes.length,
      hetznerTestVolumes: providerTestVolumes.length,
      intentionalRetainedVolume: retainedVolumeProof,
      unexpectedApiTestVolumeLeaks: unexpectedApiTestVolumes.length,
      unexpectedHetznerTestVolumeLeaks: unexpectedProviderTestVolumes.length,
      hetznerProjectVolumeTotal: providerVolumes.length,
      labeledDockerContainers: containerCount,
      labeledDockerVolumes: dockerVolumeCount,
    };
    const volumeEvidence = preservedVolumeId === null
      ? `intentional retained volume=none; API test volumes=0; Hetzner test volumes=0 (project total=${providerVolumes.length}); unexpected test volume leaks=0`
      : `intentional retained volume=${preservedVolumeId}; control-plane status=available attachedTo=null; Hetzner server=null; unexpected test volume leaks=0 (project total=${providerVolumes.length})`;
    return `API active workspaces=0; ${workspaceIds.length} test tombstones all destroyed; exact label queries all 0; blitz-purpose=workspace count=0; ${volumeEvidence}; labeled Docker containers=0; labeled Docker volumes=0`;
  });
  rmSync(workDir, { recursive: true, force: true });
}

console.log("EVIDENCE volume-persistence " + redact(JSON.stringify(details.volumePersistence), 8_000));
console.log("EVIDENCE destroy-timeline " + redact(JSON.stringify(details.destroyWhileCreating), 8_000));
console.log("EVIDENCE broker-transcript " + redact(JSON.stringify(details.broker), 8_000));
console.log("EVIDENCE teardown-proof " + redact(JSON.stringify(details.teardown), 8_000));

const requiredFailures = suites.filter((suite) => suite.required && !suite.ok);
console.log(
  JSON.stringify({
    summary: {
      passed: suites.filter((suite) => suite.ok).length,
      failed: suites.filter((suite) => !suite.ok).length,
      requiredFailures: requiredFailures.length,
      workspaceCreates: createRequests,
      workspaceIds,
      volumeIds,
      suites: Object.fromEntries(suites.map((suite) => [suite.name, suite.ok ? "PASS" : "FAIL"])),
    },
    suites,
    details,
  }),
);
process.exitCode = requiredFailures.length === 0 ? 0 : 1;

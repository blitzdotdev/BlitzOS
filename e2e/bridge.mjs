#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");
const defaultScratch = join(repoRoot, ".bridge-e2e");
const scratchDir = resolve(process.env.BRIDGE_SCRATCH_DIR ?? defaultScratch);
const cpUrl = (process.env.CP_URL ?? "https://blitz-control-plane.blitzapp.workers.dev").replace(
  /\/+$/u,
  "",
);
const privateKeyPath = resolve(process.env.SSH_KEY_PATH ?? join(scratchDir, "id_ed25519"));
const publicKeyPath = `${privateKeyPath}.pub`;
const imageArchive = resolve(
  process.env.BOX_ARCHIVE ?? process.env.IMAGE_ARCHIVE ?? join(scratchDir, "blitz-box.tar.gz"),
);
const janitorPath = resolve(
  process.env.BRIDGE_JANITOR_FILE ?? join(scratchDir, "bridge-workspace-id"),
);
const resultPath = resolve(process.env.BRIDGE_RESULT_FILE ?? join(scratchDir, "bridge-result.json"));
const defaultMachine = "cax11@fsn1";
const preferredMachine = process.env.MACHINE_TYPE ?? defaultMachine;
const boxImageTag = process.env.BOX_IMAGE_TAG ?? "blitz-box:local";
const allowUnlistedPreferred = process.env.ALLOW_UNLISTED_PREFERRED_MACHINE === "1";
const outerPort = Number(process.env.OUTER_TUNNEL_PORT ?? 12222);
const terminalPort = Number(process.env.TERMINAL_TUNNEL_PORT ?? 17443);
const acpPort = Number(process.env.ACP_TUNNEL_PORT ?? 17444);
const filesPort = Number(process.env.FILES_TUNNEL_PORT ?? 17445);
const imageUploadStreamCount = 4;
const imagePartUploadTimeoutMs = 1_800_000;
const imageAssemblyTimeoutMs = 300_000;
const imageUploadCleanupTimeoutMs = 60_000;
const sshChildKillGraceMs = 5_000;

function readEnvValue(name) {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    if (!line.startsWith(`${name}=`)) continue;
    const raw = line.slice(name.length + 1).trim();
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

const operatorKey = process.env.OPERATOR_API_KEY ?? readEnvValue("OPERATOR_API_KEY") ?? "";
const sensitiveValues = [operatorKey].filter(Boolean);
const timings = [];
const errors = [];
const webAppCodes = { terminal: null, acp: null, files: null };
const tunnels = [];

let cookie = null;
let workspaceId = null;
let workspacePhase = null;
let machineType = null;
let machineSelection = null;
let vmSsh = null;
let cloudInitExitCode = null;
let dockerSetupMode = null;
let uploadStats = null;
let preTeardownEvidence = null;
let preTeardownEvidencePromise = null;
let controlPlaneTeardownProof = null;
const providerDirectProof = {
  provider: "Hetzner",
  status: "unavailable",
  exactServerId: null,
  reason: "POST/GET /workspaces expose no exact provider server ID",
};
let cleanupPromise = null;
let signalExit = null;
let createStartedAt = null;
let boxContainerCreated = false;

function redact(value) {
  let text = String(value ?? "unknown error");
  for (const sensitive of sensitiveValues) text = text.split(sensitive).join("[REDACTED]");
  if (cookie !== null) text = text.split(cookie).join("[REDACTED]");
  return text.trim();
}

function errorMessage(error) {
  return redact(error instanceof Error ? error.message : error);
}

function isWorkspaceId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function exactWorkspaceId() {
  if (!isWorkspaceId(workspaceId)) throw new Error("no validated exact workspace ID is available");
  return workspaceId;
}

function parseSshHostPublicKey(value) {
  if (typeof value !== "string" || value.includes("\r")) return null;
  const lines = value.split("\n");
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim() === "")) return null;

  const keys = lines.map((line) => {
    const [algorithm, encoded] = line.trim().split(/\s+/u, 3);
    if (
      algorithm === undefined ||
      encoded === undefined ||
      !(algorithm.startsWith("ssh-") || algorithm.startsWith("ecdsa-") || algorithm.startsWith("sk-")) ||
      !/^[A-Za-z0-9+/]+={0,3}$/u.test(encoded)
    ) {
      return null;
    }
    return `${algorithm} ${encoded}`;
  });
  return keys.every((key) => key !== null) ? keys[0] : null;
}

function validateVmSsh(ssh) {
  if (ssh === null || typeof ssh !== "object") {
    throw new Error("ready workspace lacks complete SSH metadata");
  }
  if (typeof ssh.host !== "string" || isIP(ssh.host) === 0) {
    throw new Error("ready workspace returned an invalid SSH host");
  }
  if (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65_535) {
    throw new Error("ready workspace returned an invalid SSH port");
  }
  if (typeof ssh.user !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*\$?$/u.test(ssh.user)) {
    throw new Error("ready workspace returned an invalid SSH user");
  }
  const hostPublicKey = parseSshHostPublicKey(ssh.hostPublicKey);
  if (hostPublicKey === null) {
    throw new Error("ready workspace returned an invalid SSH host public key");
  }
  return { ...ssh, hostPublicKey };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function timed(name, action) {
  const start = Date.now();
  try {
    const value = await action();
    const seconds = (Date.now() - start) / 1_000;
    timings.push({ step: name, seconds, ok: true });
    console.log(`PASS ${name} (${seconds.toFixed(1)}s)`);
    return value;
  } catch (error) {
    const seconds = (Date.now() - start) / 1_000;
    const message = errorMessage(error);
    timings.push({ step: name, seconds, ok: false });
    errors.push(`${name}: ${message}`);
    console.error(`FAIL ${name} (${seconds.toFixed(1)}s): ${message}`);
    throw error;
  }
}

function validateConfig() {
  const parsed = new URL(cpUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("CP_URL must use HTTP or HTTPS");
  if (/\s/u.test(cpUrl)) throw new Error("CP_URL must not contain whitespace");
  if (operatorKey.length === 0) throw new Error("OPERATOR_API_KEY is missing");
  if (!existsSync(privateKeyPath)) throw new Error(`SSH private key is missing: ${privateKeyPath}`);
  if (!existsSync(publicKeyPath)) throw new Error(`SSH public key is missing: ${publicKeyPath}`);
  if (!existsSync(imageArchive)) throw new Error(`image archive is missing: ${imageArchive}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u.test(boxImageTag)) {
    throw new Error("BOX_IMAGE_TAG must be a nonempty Docker image reference");
  }
  for (const port of [outerPort, terminalPort, acpPort, filesPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid local port: ${port}`);
  }
}

async function responseJson(response) {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status} returned non-JSON: ${text.slice(0, 500)}`);
  }
}

function apiError(response, body) {
  const detail = body !== null && typeof body?.error === "string" ? `: ${body.error}` : "";
  return new Error(`HTTP ${response.status}${detail}`);
}

async function cpFetch(pathname, init = {}) {
  const response = await fetch(`${cpUrl}${pathname}`, {
    ...init,
    headers: {
      ...(cookie === null ? {} : { Cookie: cookie }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const body = response.status === 204 ? null : await responseJson(response);
  return { response, body };
}

async function login() {
  const { response } = await cpFetch("/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${operatorKey}` },
  });
  if (response.status !== 204) throw new Error(`login returned HTTP ${response.status}`);
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  const header = setCookies.find((value) => value.startsWith("blitz_session="));
  cookie = header?.split(";", 1)[0]?.trim() ?? null;
  if (cookie === null) throw new Error("login response did not set blitz_session");
}

function machineRank(type) {
  const match = /^cax(\d+)$/u.exec(type.name);
  return [match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]), type.cpuCores, type.memGb, type.diskGb, type.id];
}

function compareMachine(left, right) {
  const a = machineRank(left);
  const b = machineRank(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

async function pickMachineType() {
  const { response, body } = await cpFetch("/machine-types");
  if (response.status !== 200) throw apiError(response, body);
  if (!Array.isArray(body?.machineTypes)) throw new Error("machine-types response is not a list");
  const preferred = body.machineTypes.find((type) => type?.id === preferredMachine);
  const candidates = body.machineTypes
    .filter((type) => type?.arch === "arm64" && type?.name?.startsWith("cax"))
    .sort(compareMachine);
  const legacyFallback = preferredMachine === defaultMachine ? candidates[0] : undefined;
  machineType = preferred ?? legacyFallback ?? null;
  machineSelection =
    preferred !== undefined
      ? "preferred offered machine"
      : legacyFallback !== undefined
        ? "cheapest offered cax fallback"
        : null;
  if (machineType === null && allowUnlistedPreferred && /^cax\d+(?:@[a-z0-9]+)?$/u.test(preferredMachine)) {
    const [name, location = null] = preferredMachine.split("@");
    machineType = { id: preferredMachine, name, location, arch: "arm64" };
    machineSelection = "explicit unlisted preferred probe";
  }
  if (machineType === null) {
    if (preferredMachine === defaultMachine) {
      throw new Error("the control plane offered no ARM cax machine type");
    }
    throw new Error(`preferred machine type is not offered: ${preferredMachine}`);
  }
  const size =
    typeof machineType.cpuCores === "number" && typeof machineType.memGb === "number"
      ? `; ${machineType.cpuCores} vCPU, ${machineType.memGb} GiB`
      : "";
  console.log(`MACHINE ${machineType.id} (${machineSelection}${size})`);
}

async function createWorkspace() {
  const publicKey = readFileSync(publicKeyPath, "utf8").trim();
  if (!publicKey.startsWith("ssh-ed25519 ")) throw new Error("caller public key is not ed25519");
  const userData = `#!/bin/sh
set -eux
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
mkdir -p /home/blitz/workspace
chown blitz:blitz /home/blitz/workspace
`;
  createStartedAt = Date.now();
  const { response, body } = await cpFetch("/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      machineTypeId: machineType.id,
      sshPublicKey: publicKey,
      userData,
    }),
  });
  const id = typeof body?.workspace?.id === "string" ? body.workspace.id : null;
  if (id !== null) {
    if (!isWorkspaceId(id)) throw new Error("create returned an invalid workspace ID");
    workspaceId = id;
    workspacePhase = body.workspace.phase ?? null;
    appendFileSync(janitorPath, `${workspaceId} ${cpUrl}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`JANITOR_RECORDED ${workspaceId} ${cpUrl}`);
  }
  if (response.status !== 201) throw apiError(response, body);
  if (workspaceId === null) throw new Error("create returned no workspace ID");
  if (!["creating", "ready"].includes(workspacePhase)) {
    throw new Error(`workspace ${workspaceId} entered phase=${workspacePhase}: ${body.workspace.error ?? "unspecified"}`);
  }
  console.log(`WORKSPACE ${workspaceId} phase=${workspacePhase}`);
}

async function getWorkspace() {
  const id = exactWorkspaceId();
  const { response, body } = await cpFetch("/workspaces");
  if (response.status !== 200) throw apiError(response, body);
  if (!Array.isArray(body?.workspaces)) throw new Error("workspaces response is not a list");
  const exactMatches = body.workspaces.filter((workspace) => workspace?.id === id);
  if (exactMatches.length > 1) throw new Error(`workspace ${id} appeared more than once`);
  return exactMatches[0] ?? null;
}

async function waitReady() {
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const workspace = await getWorkspace();
    if (workspace === null) throw new Error(`workspace ${workspaceId} disappeared`);
    workspacePhase = workspace.phase;
    if (workspace.phase === "ready") {
      vmSsh = validateVmSsh(workspace.ssh);
      console.log(`READY ${workspaceId} vm=${vmSsh.host}:${vmSsh.port}`);
      return;
    }
    if (["error", "destroying", "destroyed"].includes(workspace.phase)) {
      throw new Error(
        `workspace ${workspaceId} entered phase=${workspace.phase}: ${workspace.error ?? "unspecified"}`,
      );
    }
    await sleep(4_000);
  }
  throw new Error(`workspace ${workspaceId} did not become ready within 360 seconds`);
}

function vmKnownHostsPath() {
  return join(scratchDir, `known_hosts-vm-${workspaceId}`);
}

function boxKnownHostsPath() {
  return join(scratchDir, `known_hosts-box-${workspaceId}`);
}

function vmSshArgs(remoteCommand) {
  return [
    "-i",
    privateKeyPath,
    "-p",
    String(vmSsh.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${vmKnownHostsPath()}`,
    `${vmSsh.user}@${vmSsh.host}`,
    ...(remoteCommand === undefined ? [] : [remoteCommand]),
  ];
}

function commandText(result) {
  const stderr = redact(String(result.stderr ?? "").trim());
  const stdout = redact(String(result.stdout ?? "").trim());
  return stderr || stdout || `exit ${result.status ?? "unknown"}`;
}

function remoteSync(command, options = {}) {
  const result = spawnSync("ssh", vmSshArgs(command), {
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`remote command failed: ${commandText(result)}`);
  return String(result.stdout ?? "").trim();
}

async function remoteAsyncResult(command, timeout = 600_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ssh", vmSshArgs(command), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    let childError = null;
    let killTimer = null;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (error === undefined) resolvePromise(result);
      else reject(error);
    };
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, sshChildKillGraceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout);
    child.on("error", (error) => {
      if (settled) return;
      childError = timedOut ? new Error(`remote command timed out: ${command}`) : error;
      if (child.pid === undefined) finish(childError);
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error(`remote command timed out: ${command}`));
        return;
      }
      if (childError !== null) {
        finish(childError);
        return;
      }
      finish(undefined, {
        code,
        signal,
        stdout: redact(Buffer.concat(stdout).toString().trim()),
        stderr: redact(Buffer.concat(stderr).toString().trim()),
      });
    });
  });
}

async function remoteAsync(command, timeout = 600_000) {
  const result = await remoteAsyncResult(command, timeout);
  if (result.code !== 0) {
    throw new Error(
      `remote command failed (${result.signal ?? `exit ${result.code}`}): ${result.stderr || result.stdout || "no output"}`,
    );
  }
  return result.stdout;
}

function prepareVmKnownHosts() {
  const host = vmSsh.port === 22 ? vmSsh.host : `[${vmSsh.host}]:${vmSsh.port}`;
  writeFileSync(vmKnownHostsPath(), `${host} ${vmSsh.hostPublicKey}\n`, { mode: 0o600 });
}

async function waitForDocker() {
  const cloudInit = await remoteAsyncResult("sudo cloud-init status --wait", 300_000);
  cloudInitExitCode = cloudInit.code;
  const cloudInitOutput = [cloudInit.stdout, cloudInit.stderr].filter(Boolean).join("\n");
  console.log(
    `CLOUD_INIT exitCode=${cloudInitExitCode ?? "null"} output=${JSON.stringify(cloudInitOutput || "no output")}`,
  );
  if (cloudInit.signal !== null || ![0, 2].includes(cloudInitExitCode)) {
    throw new Error(
      `cloud-init wait failed (${cloudInit.signal ?? `exit ${cloudInitExitCode}`}): ${cloudInitOutput || "no output"}`,
    );
  }
  if (!/^status:\s*done\s*$/imu.test(cloudInitOutput)) {
    throw new Error(
      `cloud-init wait did not report completed status: ${cloudInitOutput || "no output"}`,
    );
  }

  const initialState = remoteSync("sudo systemctl is-active docker 2>&1 || true", { timeout: 30_000 });
  if (initialState === "active") {
    dockerSetupMode = "cloud-init";
    console.log(`DOCKER_SETUP mode=${dockerSetupMode}`);
    return;
  }

  console.log(`DOCKER_INITIAL_STATE ${redact(initialState || "unknown")}`);
  await remoteAsync(
    "sudo apt-get update && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io && sudo systemctl enable --now docker",
    600_000,
  );
  const finalState = remoteSync("sudo systemctl is-active docker", { timeout: 30_000 });
  if (finalState !== "active") throw new Error(`docker.service is not active after SSH fallback: ${finalState}`);
  dockerSetupMode = "ssh-fallback";
  console.log(`DOCKER_SETUP mode=${dockerSetupMode}`);
}

function uploadImagePart(part) {
  const quotedPartPath = shellQuote(part.remotePath);
  const uploadCommand =
    `set -eu; umask 077; part=${quotedPartPath}; rm -f -- "$part"; complete=0; ` +
    `trap '[ "$complete" -eq 1 ] || rm -f -- "$part"' EXIT; ` +
    `trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; ` +
    `cat > "$part"; remote_bytes=$(wc -c < "$part"); ` +
    `[ "$remote_bytes" -eq ${part.expectedBytes} ]; complete=1; printf '%s\\n' "$remote_bytes"`;

  return new Promise((resolvePromise, reject) => {
    const child = spawn("ssh", vmSshArgs(uploadCommand), { stdio: ["pipe", "pipe", "pipe"] });
    const source = createReadStream(imageArchive, { start: part.start, end: part.end });
    const stdout = [];
    const stderr = [];
    let failure = null;
    let settled = false;
    let terminationRequested = false;
    let killTimer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (error === undefined) resolvePromise(value);
      else reject(error);
    };
    const terminate = (error) => {
      if (settled) return;
      failure ??= error;
      source.destroy();
      child.stdin.destroy();
      if (terminationRequested || child.exitCode !== null || child.signalCode !== null) return;
      terminationRequested = true;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, sshChildKillGraceMs);
    };
    const timeoutTimer = setTimeout(() => {
      terminate(
        new Error(
          `image upload part ${part.index} timed out after ${imagePartUploadTimeoutMs / 1_000} seconds`,
        ),
      );
    }, imagePartUploadTimeoutMs);
    source.once("error", (error) => {
      terminate(new Error(`image upload part ${part.index} source failed: ${error.message}`));
    });
    child.stdin.once("error", (error) => {
      terminate(new Error(`image upload part ${part.index} stdin failed: ${error.message}`));
    });
    child.on("error", (error) => {
      if (settled) return;
      terminate(new Error(`image upload part ${part.index} SSH failed: ${error.message}`));
      if (child.pid === undefined) finish(failure);
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (code, signal) => {
      source.destroy();
      if (failure !== null) {
        finish(failure);
        return;
      }
      if (code !== 0) {
        const output = Buffer.concat(stderr).toString() || Buffer.concat(stdout).toString();
        finish(
          new Error(
            `image upload part ${part.index} failed (${signal ?? `exit ${code}`}): ${redact(output).trim() || "no output"}`,
          ),
        );
        return;
      }
      const output = Buffer.concat(stdout).toString().trim();
      if (!/^\d+$/u.test(output)) {
        finish(new Error(`image upload part ${part.index} returned an invalid byte count: ${redact(output)}`));
        return;
      }
      const uploadedBytes = Number(output);
      if (uploadedBytes !== part.expectedBytes) {
        finish(
          new Error(
            `image upload part ${part.index} returned ${uploadedBytes} bytes; expected ${part.expectedBytes}`,
          ),
        );
        return;
      }
      console.log(
        `UPLOAD_PART_COMPLETE part=${part.index} start=${part.start} end=${part.end} bytes=${uploadedBytes}`,
      );
      finish(undefined, uploadedBytes);
    });
    source.pipe(child.stdin);
  });
}

async function uploadImage() {
  const id = exactWorkspaceId();
  const remotePath = `/tmp/blitz-bridge-${id}.tar.gz`;
  const bytes = statSync(imageArchive).size;
  if (!Number.isSafeInteger(bytes) || bytes < imageUploadStreamCount) {
    throw new Error(`image archive must have a safe size of at least ${imageUploadStreamCount} bytes`);
  }
  const basePartBytes = Math.floor(bytes / imageUploadStreamCount);
  const remainderBytes = bytes % imageUploadStreamCount;
  let nextStart = 0;
  const parts = Array.from({ length: imageUploadStreamCount }, (_, index) => {
    const expectedBytes = basePartBytes + (index < remainderBytes ? 1 : 0);
    const start = nextStart;
    const end = start + expectedBytes - 1;
    nextStart = end + 1;
    return {
      index,
      start,
      end,
      expectedBytes,
      remotePath: `${remotePath}.part-${index}`,
    };
  });
  const quotedPath = shellQuote(remotePath);
  const quotedPartPaths = parts.map((part) => shellQuote(part.remotePath));
  const cleanupCommand = `set -eu; rm -f -- ${[quotedPath, ...quotedPartPaths].join(" ")}`;
  const partAssignments = parts
    .map((part) => `part${part.index}=${shellQuote(part.remotePath)}`)
    .join("; ");
  const partVariables = parts.map((part) => `"$part${part.index}"`).join(" ");
  const assemblyCommand =
    `set -eu; umask 077; archive=${quotedPath}; ${partAssignments}; rm -f -- "$archive"; complete=0; ` +
    `trap '[ "$complete" -eq 1 ] || rm -f -- "$archive"' EXIT; ` +
    `trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; ` +
    `cat -- ${partVariables} > "$archive"; remote_bytes=$(wc -c < "$archive"); ` +
    `[ "$remote_bytes" -eq ${bytes} ]; rm -f -- ${partVariables}; complete=1; ` +
    `printf '%s\\n' "$remote_bytes"`;
  const startedAt = Date.now();
  let ok = false;
  let uploadedBytes = null;
  try {
    const partResults = await Promise.allSettled(parts.map(uploadImagePart));
    const failures = partResults
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "rejected");
    if (failures.length > 0) {
      const detail = failures
        .map(({ result, index }) => `part ${index}: ${errorMessage(result.reason)}`)
        .join("; ");
      throw new Error(`parallel image upload failed: ${detail}`);
    }
    const uploadedPartBytes = partResults.reduce((total, result) => total + result.value, 0);
    if (uploadedPartBytes !== bytes) {
      throw new Error(`uploaded parts total ${uploadedPartBytes} bytes; expected ${bytes}`);
    }

    const output = await remoteAsync(assemblyCommand, imageAssemblyTimeoutMs);
    if (!/^\d+$/u.test(output)) {
      throw new Error(`image assembly returned an invalid byte count: ${redact(output)}`);
    }
    const assembledBytes = Number(output);
    if (assembledBytes !== bytes) {
      throw new Error(`assembled image has ${assembledBytes} bytes; expected ${bytes}`);
    }
    uploadedBytes = assembledBytes;
    ok = true;
  } catch (error) {
    try {
      await remoteAsync(cleanupCommand, imageUploadCleanupTimeoutMs);
    } catch (cleanupError) {
      console.error(`WARN image upload cleanup failed: ${errorMessage(cleanupError)}`);
    }
    throw error;
  } finally {
    const seconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
    const mebibytes = bytes / (1024 * 1024);
    uploadStats = {
      ok,
      remotePath,
      bytes,
      mebibytes: Number(mebibytes.toFixed(3)),
      streams: imageUploadStreamCount,
      uploadedBytes: ok ? uploadedBytes : null,
      seconds: Number(seconds.toFixed(3)),
      effectiveMiBps:
        ok && uploadedBytes !== null
          ? Number((uploadedBytes / (1024 * 1024) / seconds).toFixed(2))
          : null,
    };
    console.log(`UPLOAD_STATS ${JSON.stringify(uploadStats)}`);
  }
}

async function loadImage() {
  const remotePath = `/tmp/blitz-bridge-${exactWorkspaceId()}.tar.gz`;
  const quotedPath = shellQuote(remotePath);
  const output = await remoteAsync(
    `set -eu; archive=${quotedPath}; trap 'rm -f -- "$archive"' EXIT HUP INT TERM; ` +
      `test -f "$archive"; gzip -dc -- "$archive" | sudo docker load`,
  );
  if (output !== "") console.log(`DOCKER_LOAD ${output.replace(/\s+/gu, " ")}`);
}

async function startBox() {
  const publicKey = `${readFileSync(publicKeyPath, "utf8").trim()}\n`;
  remoteSync(
    "sudo install -d -m 0755 -o blitz -g blitz /home/blitz/workspace && sudo sh -c 'cat > /home/blitz/authorized_key' && sudo chmod 0644 /home/blitz/authorized_key",
    { input: publicKey },
  );
  remoteSync("sudo docker volume create blitz-box-state");
  const containerId = remoteSync(
    `sudo docker run -d --name blitz-box --privileged -e BLITZ_UID=1000 -e BLITZ_GID=1000 -v blitz-box-state:/var/lib/blitz --mount type=bind,src=/home/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly --mount type=bind,src=/home/blitz/workspace,dst=/workspace -p 127.0.0.1:2222:22 ${boxImageTag}`,
    { timeout: 120_000 },
  );
  if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new Error(`docker run returned: ${containerId}`);
  boxContainerCreated = true;
  const deadline = Date.now() + 120_000;
  let lastPorts = "";
  while (Date.now() < deadline) {
    const state = remoteSync("sudo docker inspect -f '{{.State.Status}}' blitz-box");
    if (state !== "running") {
      const logs = remoteSync("sudo docker logs blitz-box 2>&1 || true");
      throw new Error(`container state=${state}\n${logs}`);
    }
    lastPorts = remoteSync("sudo docker exec blitz-box ss -tlnp 2>&1 || true");
    if (listeningPorts(lastPorts).length === 4) {
      console.log(`S6_PORTS ${lastPorts.replace(/\s+/gu, " ").trim()}`);
      return;
    }
    await sleep(3_000);
  }
  const logs = remoteSync("sudo docker logs blitz-box 2>&1 || true");
  throw new Error(`s6 services did not listen on 22,7443,7444,7445\nss=${lastPorts}\nlogs=${logs}`);
}

function listeningPorts(ssOutput) {
  return [22, 7443, 7444, 7445].filter((port) => new RegExp(`:${port}(?=\\s)`, "u").test(ssOutput));
}

async function capturePreTeardownEvidence() {
  const containerState = remoteSync("sudo docker inspect -f '{{.State.Status}}' blitz-box");
  if (containerState !== "running") throw new Error(`pre-teardown container state=${containerState}`);

  const ssOutput = remoteSync("sudo docker exec blitz-box ss -tlnp");
  const ssListeningPorts = listeningPorts(ssOutput);
  if (ssListeningPorts.length !== 4) {
    throw new Error(`pre-teardown ss lacks required ports: ${ssListeningPorts.join(",") || "none"}`);
  }

  const dockerServerVersion = remoteSync(
    "sudo docker exec blitz-box docker info --format '{{.ServerVersion}}'",
  );
  if (dockerServerVersion === "" || /[\r\n]/u.test(dockerServerVersion)) {
    throw new Error("pre-teardown docker info returned no valid server version");
  }

  const pathOutput = remoteSync(
    "sudo docker exec blitz-box sh -c 'for path in /var/lib/blitz/origin /var/lib/blitz/box-credential.json; do if [ -e \"$path\" ] || [ -L \"$path\" ]; then printf \"present\\n\"; else printf \"absent\\n\"; fi; done'",
  );
  const pathStates = pathOutput.split(/\r?\n/u);
  if (
    pathStates.length !== 2 ||
    !pathStates.every((state) => state === "present" || state === "absent")
  ) {
    throw new Error(`invalid credential-path evidence: ${pathOutput}`);
  }

  preTeardownEvidence = {
    containerState,
    ssListeningPorts,
    dockerServerVersion,
    paths: {
      "/var/lib/blitz/origin": { exists: pathStates[0] === "present" },
      "/var/lib/blitz/box-credential.json": { exists: pathStates[1] === "present" },
    },
  };
  console.log(`PRE_TEARDOWN_EVIDENCE ${JSON.stringify(preTeardownEvidence)}`);
}

async function ensurePreTeardownEvidence() {
  if (!boxContainerCreated) return;
  preTeardownEvidencePromise ??= timed("capture pre-teardown evidence", capturePreTeardownEvidence);
  await preTeardownEvidencePromise;
}

async function assertFreePort(port) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`local port ${port} is already in use`)));
    server.listen(port, "127.0.0.1", () => server.close(resolvePromise));
  });
}

async function waitForPort(port, child, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`SSH tunnel exited early with code ${child.exitCode}`);
    const open = await new Promise((resolveOpen) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(1_000);
      socket.once("connect", () => {
        socket.destroy();
        resolveOpen(true);
      });
      socket.once("error", () => resolveOpen(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolveOpen(false);
      });
    });
    if (open) return;
    await sleep(250);
  }
  throw new Error(`SSH tunnel did not open local port ${port}`);
}

function launchTunnel(args, label) {
  const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  child.bridgeLabel = label;
  child.bridgeStderr = [];
  child.stderr.on("data", (chunk) => child.bridgeStderr.push(chunk));
  tunnels.push(child);
  return child;
}

async function startOuterTunnel() {
  const args = vmSshArgs();
  args.splice(args.length - 1, 0, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${outerPort}:127.0.0.1:2222`);
  const child = launchTunnel(args, "outer");
  await waitForPort(outerPort, child);
}

async function pinBoxHostKey() {
  const trustedPublicKey = remoteSync(
    "sudo docker exec blitz-box sh -c 'cat /var/lib/blitz/ssh/ssh_host_ed25519_key.pub && ssh-keygen -lf /var/lib/blitz/ssh/ssh_host_ed25519_key.pub >&2'",
  )
    .split(/\r?\n/u)
    .find((line) => line.startsWith("ssh-ed25519 "));
  if (trustedPublicKey === undefined) throw new Error("could not read the box ed25519 host key");
  const scan = spawnSync("ssh-keyscan", ["-T", "10", "-t", "ed25519", "-p", String(outerPort), "127.0.0.1"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (scan.status !== 0 || scan.stdout.trim() === "") throw new Error(`ssh-keyscan failed: ${commandText(scan)}`);
  const scannedLine = scan.stdout
    .split(/\r?\n/u)
    .find((line) => line.includes(" ssh-ed25519 "));
  if (scannedLine === undefined) throw new Error("ssh-keyscan returned no ed25519 key");
  const scannedPublicKey = scannedLine.split(/\s+/u).slice(1).join(" ");
  const trustedComparable = trustedPublicKey.split(/\s+/u).slice(0, 2).join(" ");
  if (scannedPublicKey !== trustedComparable) throw new Error("box host key scan did not match docker-exec key");
  writeFileSync(boxKnownHostsPath(), `${scannedLine}\n`, { mode: 0o600 });
  const fingerprint = remoteSync(
    "sudo docker exec blitz-box ssh-keygen -lf /var/lib/blitz/ssh/ssh_host_ed25519_key.pub",
  );
  console.log(`BOX_HOST_KEY ${fingerprint}`);
}

async function startInnerTunnel() {
  const args = [
    "-N",
    "-i",
    privateKeyPath,
    "-p",
    String(outerPort),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${boxKnownHostsPath()}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `127.0.0.1:${terminalPort}:127.0.0.1:7443`,
    "-L",
    `127.0.0.1:${acpPort}:127.0.0.1:7444`,
    "-L",
    `127.0.0.1:${filesPort}:127.0.0.1:7445`,
    "blitz@127.0.0.1",
  ];
  const child = launchTunnel(args, "inner");
  await waitForPort(terminalPort, child);
  await waitForPort(acpPort, child);
  await waitForPort(filesPort, child);
}

function curlCode(args, expected) {
  const result = spawnSync("curl", args, { encoding: "utf8", timeout: 15_000 });
  const code = String(result.stdout ?? "").trim();
  if (code !== expected) {
    throw new Error(`curl expected ${expected}, got ${code || "no status"}: ${commandText(result)}`);
  }
  return Number(code);
}

async function verifyWebApp() {
  webAppCodes.terminal = curlCode(
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", `http://127.0.0.1:${terminalPort}/`],
    "200",
  );
  webAppCodes.acp = curlCode(
    [
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--http1.1",
      "--max-time",
      "3",
      "-H",
      "Connection: Upgrade",
      "-H",
      "Upgrade: websocket",
      "-H",
      "Sec-WebSocket-Version: 13",
      "-H",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `http://127.0.0.1:${acpPort}/`,
    ],
    "101",
  );
  webAppCodes.files = curlCode(
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", `http://127.0.0.1:${filesPort}/workspace/`],
    "200",
  );
  console.log(`WEBAPP terminal=${webAppCodes.terminal} acp=${webAppCodes.acp} files=${webAppCodes.files}`);
}

async function stopTunnels() {
  await Promise.all(
    tunnels.splice(0).map(
      (child) =>
        new Promise((resolvePromise) => {
          if (child.exitCode !== null) {
            resolvePromise();
            return;
          }
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolvePromise();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}

async function destroyWorkspace() {
  if (workspaceId === null) return;
  const id = exactWorkspaceId();
  if (cookie === null) throw new Error(`cannot destroy workspace ${workspaceId}: no session cookie`);
  const { response, body } = await cpFetch(`/workspaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (response.status < 200 || response.status >= 300) throw apiError(response, body);
  if (body?.workspace?.id !== id) throw new Error("delete response did not contain the exact workspace ID");
  workspacePhase = body?.workspace?.phase ?? null;
  const deleteResponsePhase = workspacePhase;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const workspace = await getWorkspace();
    if (workspace === null) throw new Error("workspace tombstone disappeared during teardown");
    workspacePhase = workspace.phase;
    if (workspacePhase === "destroyed") {
      controlPlaneTeardownProof = {
        workspaceId: id,
        deleteResponsePhase,
        tombstonePhase: workspacePhase,
        exactIdMatch: true,
      };
      console.log(`CONTROL_PLANE_TEARDOWN ${JSON.stringify(controlPlaneTeardownProof)}`);
      return;
    }
    await sleep(3_000);
  }
  throw new Error(`workspace teardown timed out in phase=${workspacePhase}`);
}

async function cleanup() {
  if (cleanupPromise !== null) return cleanupPromise;
  cleanupPromise = (async () => {
    let evidenceError = null;
    try {
      await ensurePreTeardownEvidence();
    } catch (error) {
      evidenceError = error;
    }
    await stopTunnels();
    let destroyError = null;
    try {
      await timed("destroy workspace", destroyWorkspace);
    } catch (error) {
      destroyError = error;
    }
    console.log(`PROVIDER_DIRECT_PROOF ${JSON.stringify(providerDirectProof)}`);
    if (destroyError !== null) throw destroyError;
    if (evidenceError !== null) throw evidenceError;
  })();
  return cleanupPromise;
}

function writeResult(ok) {
  const result = {
    ok,
    cpUrl,
    workspaceId,
    workspacePhase,
    machineType: machineType?.id ?? null,
    machineSelection,
    cloudInitExitCode,
    dockerSetupMode,
    createToEndSeconds: createStartedAt === null ? null : (Date.now() - createStartedAt) / 1_000,
    webAppCodes,
    uploadStats,
    preTeardownEvidence,
    controlPlaneTeardownProof,
    providerDirectProof,
    timings,
    errors,
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`RESULT ${JSON.stringify(result)}`);
}

async function main() {
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  validateConfig();
  await Promise.all([outerPort, terminalPort, acpPort, filesPort].map(assertFreePort));
  let succeeded = false;
  try {
    await timed("login", login);
    await timed("select machine type", pickMachineType);
    await timed("create workspace", createWorkspace);
    await timed("wait workspace ready", waitReady);
    prepareVmKnownHosts();
    await timed("wait cloud-init and Docker", waitForDocker);
    await timed("stream compressed image archive", uploadImage);
    await timed("load image archive", loadImage);
    await timed("start box and wait for s6", startBox);
    await ensurePreTeardownEvidence();
    await timed("outer SSH tunnel", startOuterTunnel);
    await timed("pin box host key", pinBoxHostKey);
    await timed("inner SSH tunnel", startInnerTunnel);
    await timed("Mac webapp checks", verifyWebApp);
    succeeded = true;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      succeeded = false;
      if (!errors.some((entry) => entry.includes(errorMessage(error)))) errors.push(`cleanup: ${errorMessage(error)}`);
    }
    writeResult(succeeded && workspacePhase === "destroyed");
  }
  if (!succeeded || workspacePhase !== "destroyed") process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    signalExit = signal;
    void cleanup()
      .catch((error) => console.error(`FAIL signal cleanup: ${errorMessage(error)}`))
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await main();
} catch (error) {
  if (signalExit === null) {
    const message = errorMessage(error);
    if (!errors.some((entry) => entry.includes(message))) errors.push(`fatal: ${message}`);
    console.error(`FATAL ${message}`);
    if (!existsSync(resultPath)) writeResult(false);
    process.exitCode = 1;
  }
}

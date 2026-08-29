#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Overridable with WORK_DIR / WORKSPACE_LEDGER; defaults stay inside the
// repo's gitignored scratchpad.
const DEFAULT_WORK_DIR = join(repoRoot, "scratchpad", "microvm-m3", "e2e");
const DEFAULT_LEDGER = join(repoRoot, "scratchpad", "microvm-m3", "workspace-ids");
const envPath = join(repoRoot, ".env");

function readEnvValue(name) {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const cpUrl = (process.env.CP_URL ?? "").replace(/\/+$/u, "");
const operatorKey = process.env.OPERATOR_API_KEY ?? readEnvValue("OPERATOR_API_KEY") ?? "";
const machineTypeId = process.env.MACHINE_TYPE ?? "mv-2c2g@lab";
const workDir = process.env.WORK_DIR ?? DEFAULT_WORK_DIR;
const ledgerPath = resolve(process.env.WORKSPACE_LEDGER ?? DEFAULT_LEDGER);
const readyObservationTimeoutMs = 30_000;
const readyTargetMs = 5_000;
const results = [];
const sensitiveValues = [operatorKey].filter((value) => value.length > 0);

let cookie = null;
let keyPath = null;
let publicKey = null;
let workspaceId = null;
let sshInfo = null;
let sshConnected = false;
let quickTunnel = null;
let createStartedAt = null;
let createToReadyMs = null;

const pass = (reason, value = undefined) => ({ ok: true, reason, value });
const fail = (reason, value = undefined) => ({ ok: false, reason, value });
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function safeText(value) {
  let text = String(value ?? "unknown error").replace(/[\r\n]+/gu, " ").trim();
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) text = text.split(sensitive).join("[REDACTED]");
  }
  return text.slice(0, 500);
}

async function runStep(id, name, action) {
  const startedAt = performance.now();
  let outcome;
  try {
    outcome = await action();
    if (outcome === undefined || typeof outcome.ok !== "boolean") {
      outcome = pass("completed");
    }
  } catch (error) {
    outcome = fail(error instanceof Error ? error.message : error);
  }
  const reason = safeText(outcome.reason);
  const durationMs = Math.round(performance.now() - startedAt);
  const record = { id, name, ok: outcome.ok, reason, durationMs };
  results.push(record);
  console.log(`${outcome.ok ? "PASS" : "FAIL"} ${id} ${name}: ${reason}; step_ms=${durationMs}`);
  return { ...outcome, reason, durationMs };
}

function endpoint(pathname) {
  return `${cpUrl}${pathname}`;
}

function fetchOptions(init = {}) {
  return { ...init, signal: AbortSignal.timeout(30_000) };
}

async function responseJson(response) {
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

function validateConfig() {
  if (cpUrl.length === 0) return "CP_URL is required";
  let parsed;
  try {
    parsed = new URL(cpUrl);
  } catch {
    return "CP_URL must be an absolute URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "CP_URL must use http or https";
  }
  if (operatorKey.length === 0) return "OPERATOR_API_KEY is missing from the environment and .env";
  return null;
}

function commandFailure(result) {
  if (result.error !== undefined) return safeText(result.error.message);
  const stderr = String(result.stderr ?? "").trim().split(/\r?\n/u)[0];
  return stderr.length > 0 ? safeText(stderr) : `exit ${result.status ?? "unknown"}`;
}

function sshArgs(info, knownHostsPath, remoteCommand) {
  return [
    "-i",
    keyPath,
    "-p",
    String(info.port),
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
    `blitz@${info.host}`,
    remoteCommand,
  ];
}

function stopSurfaceTunnel() {
  if (quickTunnel === null) return;
  if (quickTunnel.exitCode === null && quickTunnel.signalCode === null) {
    quickTunnel.kill("SIGTERM");
  }
  quickTunnel = null;
}

async function mintSession() {
  const response = await fetch(
    endpoint("/sessions"),
    fetchOptions({
      method: "POST",
      headers: { Authorization: `Bearer ${operatorKey}` },
    }),
  );
  if (response.status !== 204) {
    const body = await responseJson(response);
    throw new Error(`session login HTTP ${response.status}; expected 204${apiError(body)}`);
  }
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  const sessionHeader = setCookies.find((value) => value.startsWith("blitz_session="));
  const sessionCookie = sessionHeader?.split(";", 1)[0]?.trim();
  if (sessionCookie === undefined || !sessionCookie.startsWith("blitz_session=")) {
    throw new Error("session login HTTP 204; Set-Cookie did not contain blitz_session");
  }
  return sessionCookie;
}

async function pollWorkspace(id) {
  const response = await fetch(
    endpoint("/workspaces"),
    fetchOptions({ headers: { Cookie: cookie } }),
  );
  const body = await responseJson(response);
  if (response.status !== 200) {
    return { response, body, workspace: null };
  }
  const workspaces = body !== null && typeof body === "object" ? body.workspaces : null;
  if (!Array.isArray(workspaces)) {
    return { response, body, workspace: null, invalidList: true };
  }
  return {
    response,
    body,
    workspace: workspaces.find((workspace) => workspace?.id === id) ?? null,
  };
}

try {
  const login = await runStep("s1", "login", async () => {
    const configError = validateConfig();
    if (configError !== null) return fail(configError);
    const response = await fetch(
      endpoint("/sessions"),
      fetchOptions({
        method: "POST",
        headers: { Authorization: `Bearer ${operatorKey}` },
      }),
    );
    if (response.status !== 204) {
      const body = await responseJson(response);
      return fail(`HTTP ${response.status}; expected 204${apiError(body)}`);
    }
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    const sessionHeader = setCookies.find((value) => value.startsWith("blitz_session="));
    const sessionCookie = sessionHeader?.split(";", 1)[0]?.trim();
    if (sessionCookie === undefined || !sessionCookie.startsWith("blitz_session=")) {
      return fail("HTTP 204; Set-Cookie did not contain blitz_session");
    }
    return pass(`HTTP 204; cookie captured (length=${sessionCookie.length})`, {
      cookie: sessionCookie,
    });
  });
  if (login.ok) {
    cookie = login.value.cookie;
    sensitiveValues.push(cookie);
  }

  await runStep("s2", "machine-types", async () => {
    if (cookie === null) return fail("login prerequisite failed");
    const response = await fetch(
      endpoint("/machine-types"),
      fetchOptions({ headers: { Cookie: cookie } }),
    );
    const body = await responseJson(response);
    if (response.status !== 200) {
      return fail(`HTTP ${response.status}; expected 200${apiError(body)}`);
    }
    const machineTypes = body !== null && typeof body === "object" ? body.machineTypes : null;
    if (!Array.isArray(machineTypes)) {
      return fail("HTTP 200; response.machineTypes is not a list");
    }
    return pass(`HTTP 200; machineTypes=${machineTypes.length}`);
  });

  const keypair = await runStep("s3", "keypair", async () => {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const privateKeyPath = join(workDir, "id_ed25519");
    const publicKeyPath = `${privateKeyPath}.pub`;
    const hasPrivate = existsSync(privateKeyPath);
    const hasPublic = existsSync(publicKeyPath);

    if (!hasPrivate && hasPublic) {
      return fail("public key exists without its private key; refusing to overwrite artifacts");
    }
    if (!hasPrivate) {
      const generated = spawnSync(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath],
        { encoding: "utf8", timeout: 30_000 },
      );
      if (generated.status !== 0) return fail(`ssh-keygen failed: ${commandFailure(generated)}`);
    } else if (!hasPublic) {
      const derived = spawnSync("ssh-keygen", ["-y", "-f", privateKeyPath], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (derived.status !== 0) {
        return fail(`could not derive missing public key: ${commandFailure(derived)}`);
      }
      writeFileSync(publicKeyPath, `${derived.stdout.trim()}\n`, { mode: 0o644 });
    }

    const key = readFileSync(publicKeyPath, "utf8").trim();
    if (!key.startsWith("ssh-ed25519 ")) return fail("public key is not ed25519");
    return pass(hasPrivate ? "reused ed25519 keypair" : "generated ed25519 keypair", {
      keyPath: privateKeyPath,
      publicKey: key,
    });
  });
  if (keypair.ok) {
    keyPath = keypair.value.keyPath;
    publicKey = keypair.value.publicKey;
  }

  const create = await runStep("s4", "create", async () => {
    if (cookie === null) return fail("login prerequisite failed");
    if (publicKey === null) return fail("keypair prerequisite failed");
    createStartedAt = Date.now();
    const response = await fetch(
      endpoint("/workspaces"),
      fetchOptions({
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId, sshPublicKey: publicKey }),
      }),
    );
    const body = await responseJson(response);
    const workspace = body !== null && typeof body === "object" ? body.workspace : null;
    const id = workspace !== null && typeof workspace?.id === "string" ? workspace.id : null;
    const value = id === null ? undefined : { workspaceId: id };
    if (id !== null) {
      mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
      appendFileSync(ledgerPath, `${id} ${cpUrl}\n`, { encoding: "utf8", mode: 0o600 });
      console.log(`JANITOR_RECORDED workspace=${id}; path=${ledgerPath}`);
    }
    if (response.status !== 201) {
      return fail(`HTTP ${response.status}; expected 201${apiError(body)}`, value);
    }
    if (id === null) return fail("HTTP 201; response.workspace.id is missing");
    if (workspace.phase !== "creating" && workspace.phase !== "ready") {
      const error = typeof workspace.error === "string" ? `; error=${workspace.error}` : "";
      return fail(`HTTP 201; workspace=${id}; phase=${workspace.phase ?? "missing"}${error}`, value);
    }
    return pass(`HTTP 201; workspace=${id}; phase=${workspace.phase}`, value);
  });
  if (create.value?.workspaceId !== undefined) workspaceId = create.value.workspaceId;

  const ready = await runStep("s5", "ready", async () => {
    if (workspaceId === null) return fail("create did not return a workspace id");
    if (createStartedAt === null) return fail("create start time was not captured");
    const deadline = Date.now() + readyObservationTimeoutMs;
    let lastPhase = "unknown";
    while (Date.now() <= deadline) {
      const poll = await pollWorkspace(workspaceId);
      if (poll.response.status !== 200) {
        return fail(`GET /workspaces HTTP ${poll.response.status}${apiError(poll.body)}`);
      }
      if (poll.invalidList === true) return fail("GET /workspaces response is not a list");
      if (poll.workspace === null) return fail(`workspace ${workspaceId} is missing from poll`);
      lastPhase = String(poll.workspace.phase ?? "missing");
      if (lastPhase === "ready") {
        createToReadyMs = Date.now() - createStartedAt;
        const ssh = poll.workspace.ssh;
        if (
          ssh === null ||
          typeof ssh !== "object" ||
          typeof ssh.host !== "string" ||
          typeof ssh.port !== "number" ||
          typeof ssh.user !== "string" ||
          typeof ssh.hostPublicKey !== "string" ||
          ssh.hostPublicKey.length === 0
        ) {
          return fail("phase=ready but complete SSH metadata is missing");
        }
        return pass(
          `workspace=${workspaceId}; phase=ready; ssh metadata captured; create_to_ready_ms=${createToReadyMs}`,
          { ssh },
        );
      }
      if (lastPhase === "error") {
        const error = typeof poll.workspace.error === "string" ? poll.workspace.error : "unspecified";
        return fail(`workspace=${workspaceId}; phase=error; error=${error}`);
      }
      if (lastPhase === "destroying" || lastPhase === "destroyed") {
        return fail(`workspace=${workspaceId}; unexpected phase=${lastPhase}`);
      }
      if (Date.now() + 100 > deadline) break;
      await sleep(100);
    }
    return fail(
      `workspace=${workspaceId}; timed out after ${readyObservationTimeoutMs / 1_000}s; last phase=${lastPhase}`,
    );
  });
  if (ready.ok) sshInfo = ready.value.ssh;

  const ssh = await runStep("s6", "ssh", async () => {
    if (sshInfo === null || keyPath === null) return fail("ready SSH metadata prerequisite failed");
    const hostKey = sshInfo.hostPublicKey.split(/\r?\n/u)[0].trim();
    if (!hostKey.startsWith("ssh-")) return fail("SSH host public key has an invalid format");
    const knownHostsPath = join(workDir, "known_hosts");
    const knownHostName = sshInfo.port === 22 ? sshInfo.host : `[${sshInfo.host}]:${sshInfo.port}`;
    writeFileSync(knownHostsPath, `${knownHostName} ${hostKey}\n`, { mode: 0o600 });

    const deadline = Date.now() + 90_000;
    let lastFailure = "not attempted";
    do {
      const attempt = spawnSync(
        "ssh",
        sshArgs(sshInfo, knownHostsPath, "hostname; uname -n; uname -a; test -d /run/s6"),
        { encoding: "utf8", timeout: 15_000 },
      );
      if (attempt.status === 0) {
        const lines = attempt.stdout.trim().split(/\r?\n/u);
        const hostname = lines[0] ?? "";
        const unameNode = lines[1] ?? "";
        const unameAll = lines.slice(2).join(" ");
        if (hostname.length === 0 || unameNode !== hostname || !unameAll.includes(hostname)) {
          return fail("SSH succeeded but uname did not report the container hostname");
        }
        return pass(`box uname succeeded; container hostname=${hostname}; /run/s6 present`, {
          knownHostsPath,
        });
      }
      lastFailure = commandFailure(attempt);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(5_000, remaining));
    } while (Date.now() <= deadline);
    return fail(`sshd did not become reachable within 90s; last failure=${lastFailure}`);
  });
  if (ssh.ok) sshConnected = true;

  await runStep("s7", "box-webapp", async () => {
    if (!sshConnected || sshInfo === null || ssh.value?.knownHostsPath === undefined) {
      return fail("successful SSH prerequisite failed");
    }
    const args = sshArgs(sshInfo, ssh.value.knownHostsPath, "");
    args.splice(args.length - 2, 0,
      "-N", "-o", "ExitOnForwardFailure=yes",
      "-L", "17443:127.0.0.1:7443",
      "-L", "17445:127.0.0.1:7445",
    );
    args.pop();
    quickTunnel = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    let tunnelError = "";
    quickTunnel.stderr.on("data", (chunk) => { tunnelError += String(chunk); });
    try {
      const tunnelDeadline = Date.now() + 20_000;
      let tunnelReady = false;
      while (Date.now() < tunnelDeadline) {
        if (quickTunnel.exitCode !== null || quickTunnel.signalCode !== null) {
          return fail(`SSH tunnel failed: ${safeText(tunnelError)}`);
        }
        tunnelReady = await new Promise((resolve) => {
          const probe = net.connect({ host: "127.0.0.1", port: 17443 }, () => {
            probe.destroy();
            resolve(true);
          });
          probe.on("error", () => resolve(false));
          probe.setTimeout(1_000, () => { probe.destroy(); resolve(false); });
        });
        if (tunnelReady) break;
        await sleep(500);
      }
      if (!tunnelReady) {
        return fail(`SSH tunnel did not bind 17443 within 20s: ${safeText(tunnelError)}`);
      }
      const probes = [
        { name: "ttyd", url: "http://127.0.0.1:17443/", expected: (code) => code === "200" },
        { name: "dufs", url: "http://127.0.0.1:17445/workspace/", expected: (code) => code === "200" },
      ];
      const statuses = [];
      for (const probe of probes) {
        const curlArgs = ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10"];
        for (const header of probe.headers ?? []) curlArgs.push("-H", header);
        curlArgs.push(probe.url);
        const result = spawnSync("curl", curlArgs, { encoding: "utf8", timeout: 15_000 });
        const code = result.stdout.trim();
        statuses.push(`${probe.name}=${code || "missing"}`);
        if (!probe.expected(code)) {
          return fail(`HTTP ${statuses.join(", ")}; ${probe.name} probe failed: ${commandFailure(result)}`);
        }
      }
      return pass(`HTTP ${statuses.join(", ")}`);
    } finally {
      stopSurfaceTunnel();
    }
  });

  await runStep("s9", "credentials", async () => {
    if (!sshConnected || sshInfo === null || ssh.value?.knownHostsPath === undefined) {
      return fail("successful box SSH prerequisite failed");
    }
    const remoteCommand = "test -s /var/lib/blitz/box-credential.json && test -s /var/lib/blitz/origin";
    const deadline = Date.now() + 90_000;
    let lastFailure = "not attempted";

    do {
      const attempt = spawnSync(
        "ssh",
        sshArgs(sshInfo, ssh.value.knownHostsPath, remoteCommand),
        { encoding: "utf8", timeout: 20_000 },
      );
      if (attempt.status === 0) {
        return pass("box SSH found non-empty credential and origin");
      }
      lastFailure = commandFailure(attempt);

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(5_000, remaining));
    } while (Date.now() <= deadline);

    return fail(`credentials were not verifiable through box SSH: ${lastFailure}`);
  });
} finally {
  stopSurfaceTunnel();
  await runStep("s8", "destroy", async () => {
    if (workspaceId === null) return pass("no workspace id; no cleanup required");
    let cleanupCookie;
    try {
      cleanupCookie = await mintSession();
      sensitiveValues.push(cleanupCookie);
      cookie = cleanupCookie;
    } catch (error) {
      return fail(`workspace=${workspaceId}; fresh cleanup session failed: ${safeText(error.message)}`);
    }

    let response;
    let lastNetworkError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(
          endpoint(`/workspaces/${encodeURIComponent(workspaceId)}`),
          fetchOptions({ method: "DELETE", headers: { Cookie: cleanupCookie } }),
        );
        break;
      } catch (error) {
        lastNetworkError = error;
        if (attempt < 3) await sleep(attempt * 1_000);
      }
    }
    if (response === undefined) {
      return fail(`workspace=${workspaceId}; DELETE network error after 3 attempts: ${safeText(lastNetworkError?.message)}`);
    }
    const body = await responseJson(response);
    const deleteOk = response.status >= 200 && response.status < 300;
    const deletePhase =
      body !== null && typeof body === "object" && body.workspace !== null
        ? body.workspace?.phase
        : null;
    const deadline = Date.now() + 120_000;
    let lastPhase = typeof deletePhase === "string" ? deletePhase : "unknown";

    while (Date.now() <= deadline) {
      if (lastPhase === "destroyed") {
        const reason = `DELETE HTTP ${response.status}; workspace=${workspaceId}; phase=destroyed`;
        return deleteOk ? pass(reason) : fail(reason);
      }
      if (lastPhase !== "unknown" && lastPhase !== "destroying") {
        return fail(
          `DELETE HTTP ${response.status}; workspace=${workspaceId}; remained active phase=${lastPhase}`,
        );
      }
      if (Date.now() + 5_000 > deadline) break;
      await sleep(5_000);
      const poll = await pollWorkspace(workspaceId);
      if (poll.response.status !== 200) {
        return fail(
          `DELETE HTTP ${response.status}; cleanup poll HTTP ${poll.response.status}${apiError(poll.body)}`,
        );
      }
      if (poll.invalidList === true) return fail("cleanup poll response is not a list");
      if (poll.workspace === null) return fail("workspace tombstone is missing after DELETE");
      lastPhase = String(poll.workspace.phase ?? "missing");
    }
    return fail(
      `DELETE HTTP ${response.status}; workspace=${workspaceId}; cleanup timed out; last phase=${lastPhase}`,
    );
  });
}

const failed = results.filter((result) => !result.ok).length;
const passed = results.length - failed;
const targetPassed = Number.isInteger(createToReadyMs) && createToReadyMs < readyTargetMs;
console.log(
  JSON.stringify({
    summary: {
      passed,
      failed,
      total: results.length,
      workspaceId,
      cleanupAttempted: workspaceId !== null,
      ledgerPath,
      machineTypeId,
      createToReadyMs,
      stepMs: Object.fromEntries(results.map((result) => [result.id, result.durationMs])),
      steps: Object.fromEntries(results.map((result) => [result.id, result.ok ? "PASS" : "FAIL"])),
    },
  }),
);
process.exitCode = failed > 0 || !targetPassed ? 1 : 0;
console.log(
  `TARGET <5000ms: ${targetPassed ? "PASS" : "FAIL"} createToReadyMs=${createToReadyMs}`,
);

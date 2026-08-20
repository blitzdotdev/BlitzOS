#!/usr/bin/env node

// Successor of e2e/credentials.mjs for the connections product noun.
//
// Discovery-driven: it does not create a grant and it never asks for a
// provider secret. It reads the target instance's catalog and the operator's
// own grants, picks a connected provider, and asserts what that grant puts on
// a real box — environment names, the skill file, the proxy data path, and
// what disappears when the lease is revoked. A run against an instance with no
// grants SKIPs rather than inventing one.
//
// Nightly / on-demand; this is the only tier that costs a VM.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WORK_DIR = join(repoRoot, "scratchpad", "connections");
const DEFAULT_LEDGER = join(DEFAULT_WORK_DIR, "workspace-ids");
const PROTECTED_WORKSPACE_ID = "f8434c15-991a-486d-bd37-6df51c0f0647";
// The box image's HOME. Surfaces are absolute paths; the box does no tilde
// expansion, so this constant is part of the contract, not a convenience.
const BOX_HOME = "/var/lib/blitz/home";
const UNCONNECTED_PROVIDER = "blitz-e2e-never-connected";
const readyTimeoutMs = Number(process.env.READY_TIMEOUT_MS ?? 180_000);
const runToken = randomBytes(6).toString("hex");

const cpUrl = (process.env.CP_URL ?? "").replace(/\/+$/u, "");
const operatorKey = process.env.OPERATOR_API_KEY ?? "";
const machineTypeId = process.env.MACHINE_TYPE ?? "mv-2c2g@lab";
const wantedProvider = process.env.CONNECTION_PROVIDER ?? "";
const workDir = resolve(process.env.WORK_DIR ?? DEFAULT_WORK_DIR);
const ledgerPath = resolve(process.env.WORKSPACE_LEDGER ?? DEFAULT_LEDGER);

const results = [];
const sensitiveValues = [operatorKey].filter((value) => value.length > 0);
const ledgeredWorkspaceIds = new Set();

let cookie = null;
let keyPath = null;
let publicKey = null;
let workspaceId = null;
let workspaceDestroyed = false;
let sshInfo = null;
let knownHostsPath = null;
let catalog = [];
let grants = [];
let subject = null;
let revokedLeaseId = null;
let inboxRequestId = null;

const pass = (reason) => ({ status: "PASS", reason });
const fail = (reason) => ({ status: "FAIL", reason });
const skip = (reason) => ({ status: "SKIP", reason });
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function safeText(value) {
  let text = String(value ?? "unknown error")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\r\n]+/gu, " ")
    .trim();
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) text = text.split(sensitive).join("[REDACTED]");
  }
  text = text.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]");
  return text.slice(0, 700);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function captureOutcome(action) {
  try {
    const outcome = await action();
    if (
      outcome === undefined ||
      (outcome.status !== "PASS" && outcome.status !== "FAIL" && outcome.status !== "SKIP")
    ) {
      return pass("completed");
    }
    return outcome;
  } catch (error) {
    return fail(error instanceof Error ? error.message : error);
  }
}

async function runStep(id, name, action) {
  const outcome = await captureOutcome(action);
  const reason = safeText(outcome.reason);
  const record = { id, name, status: outcome.status, reason };
  results.push(record);
  console.log(`${outcome.status} ${id} ${name}: ${reason}`);
  return record;
}

function endpoint(pathname) {
  return `${cpUrl}${pathname}`;
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

async function requestJson(url, init = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { response, body: await responseJson(response) };
}

async function mintSession() {
  const { response, body } = await requestJson(endpoint("/sessions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${operatorKey}` },
  });
  assert(
    response.status === 204,
    `session login HTTP ${response.status}; expected 204${apiError(body)}`,
  );
  const setCookies = typeof response.headers.getSetCookie === "function"
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
  const headers = { Cookie: cookie, ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return requestJson(endpoint(pathname), { ...init, headers }, timeoutMs);
}

function validateConfig() {
  if (cpUrl.length === 0) return "CP_URL is required";
  let parsed;
  try {
    parsed = new URL(cpUrl);
  } catch {
    return "CP_URL must be an absolute URL";
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== cpUrl) {
    return "CP_URL must be an HTTP(S) origin without a path";
  }
  if (operatorKey.length === 0) return "OPERATOR_API_KEY is required";
  return null;
}

function childEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  delete environment.OPERATOR_API_KEY;
  return environment;
}

function commandFailure(result) {
  if (result.error !== undefined) return safeText(result.error.message);
  const stderr = String(result.stderr ?? "").trim().split(/\r?\n/u)[0];
  return stderr.length > 0 ? safeText(stderr) : `exit ${result.status ?? "unknown"}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function generateKeypair() {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const privateKeyPath = join(workDir, "id_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;
  const hasPrivate = existsSync(privateKeyPath);
  const hasPublic = existsSync(publicKeyPath);
  assert(!(!hasPrivate && hasPublic), "public key exists without its private key");
  if (!hasPrivate) {
    const generated = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", `blitz-connections-${runToken}`, "-f", privateKeyPath],
      { encoding: "utf8", timeout: 30_000, env: childEnvironment() },
    );
    assert(generated.status === 0, `ssh-keygen failed: ${commandFailure(generated)}`);
  } else if (!hasPublic) {
    const derived = spawnSync("ssh-keygen", ["-y", "-f", privateKeyPath], {
      encoding: "utf8",
      timeout: 30_000,
      env: childEnvironment(),
    });
    assert(derived.status === 0, `public-key derivation failed: ${commandFailure(derived)}`);
    writeFileSync(publicKeyPath, `${derived.stdout.trim()}\n`, { mode: 0o644 });
  }
  const key = readFileSync(publicKeyPath, "utf8").trim();
  assert(key.startsWith("ssh-ed25519 "), "public key is not ed25519");
  keyPath = privateKeyPath;
  publicKey = key;
  return hasPrivate ? "reused ed25519 keypair" : "generated ed25519 keypair";
}

function sshArgs(info, hostKeysPath, remoteCommand = undefined) {
  assert(keyPath !== null, "SSH private key is unavailable");
  const args = [
    "-T", "-i", keyPath, "-p", String(info.port),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${hostKeysPath}`,
    `${info.user}@${info.host}`,
  ];
  if (remoteCommand !== undefined) args.push(remoteCommand);
  return args;
}

function runSsh(remoteCommand, timeout = 30_000) {
  assert(sshInfo !== null && knownHostsPath !== null, "ready SSH metadata is unavailable");
  return spawnSync("ssh", sshArgs(sshInfo, knownHostsPath, remoteCommand), {
    encoding: "utf8",
    timeout,
    env: childEnvironment(),
  });
}

/** A fresh login shell is the whole delivery contract: the profile hook syncs
 * and exports without any agent action. */
function runFreshLogin(script, timeout = 45_000) {
  assert(sshInfo !== null && knownHostsPath !== null, "ready SSH metadata is unavailable");
  return spawnSync("ssh", sshArgs(sshInfo, knownHostsPath), {
    encoding: "utf8",
    input: `${script}\n`,
    timeout,
    env: childEnvironment(),
  });
}

async function listWorkspaces() {
  const { response, body } = await controlPlane("/workspaces");
  assert(response.status === 200, `GET /workspaces HTTP ${response.status}${apiError(body)}`);
  assert(
    body !== null && typeof body === "object" && Array.isArray(body.workspaces),
    "GET /workspaces did not return response.workspaces",
  );
  return body.workspaces;
}

async function waitForWorkspace(id, wantedPhase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastPhase = "unknown";
  while (Date.now() <= deadline) {
    const workspace = (await listWorkspaces()).find((candidate) => candidate?.id === id) ?? null;
    assert(workspace !== null, `workspace ${id} is missing from GET /workspaces`);
    lastPhase = String(workspace.phase ?? "missing");
    if (lastPhase === wantedPhase) return workspace;
    if (wantedPhase === "ready" && lastPhase !== "creating") {
      throw new Error(
        `workspace ${id} reached phase=${lastPhase}; error=${workspace.error ?? "unspecified"}`,
      );
    }
    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `workspace ${id} timed out waiting for phase=${wantedPhase}; last phase=${lastPhase}`,
  );
}

function recordWorkspaceId(id) {
  assert(id !== PROTECTED_WORKSPACE_ID, `control plane returned protected workspace id ${id}`);
  if (ledgeredWorkspaceIds.has(id)) return;
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  appendFileSync(ledgerPath, `${id}\n`, { encoding: "utf8", mode: 0o600 });
  ledgeredWorkspaceIds.add(id);
  console.log(`JANITOR_RECORDED workspace=${id}; path=${ledgerPath}`);
}

function captureSshMetadata(workspace) {
  const ssh = workspace?.ssh;
  assert(ssh !== null && typeof ssh === "object", "ready workspace has no SSH object");
  assert(typeof ssh.host === "string" && ssh.host.length > 0, "ready SSH host is missing");
  assert(typeof ssh.port === "number", "ready SSH port is missing");
  assert(typeof ssh.user === "string" && ssh.user.length > 0, "ready SSH user is missing");
  assert(
    typeof ssh.hostPublicKey === "string" && ssh.hostPublicKey.startsWith("ssh-"),
    "ready SSH hostPublicKey is missing or invalid",
  );
  const hostKey = ssh.hostPublicKey.split(/\r?\n/u)[0].trim();
  const path = join(workDir, `known_hosts_${workspace.id}`);
  const hostName = ssh.port === 22 ? ssh.host : `[${ssh.host}]:${ssh.port}`;
  writeFileSync(path, `${hostName} ${hostKey}\n`, { mode: 0o600 });
  sshInfo = ssh;
  knownHostsPath = path;
}

async function listWorkspaceLeases() {
  assert(workspaceId !== null, "workspace id is unavailable");
  const { response, body } = await controlPlane(
    `/workspaces/${encodeURIComponent(workspaceId)}/leases`,
  );
  assert(
    response.status === 200,
    `GET /workspaces/:id/leases HTTP ${response.status}${apiError(body)}`,
  );
  assert(
    body !== null && typeof body === "object" && Array.isArray(body.leases),
    "GET /workspaces/:id/leases did not return response.leases",
  );
  return body.leases;
}

async function destroyCurrentWorkspace() {
  assert(workspaceId !== null, "workspace id is unavailable");
  assert(workspaceId !== PROTECTED_WORKSPACE_ID, "refusing to destroy the protected workspace");
  assert(
    ledgeredWorkspaceIds.has(workspaceId),
    `refusing to destroy workspace ${workspaceId}: id is not in this run's ledger set`,
  );
  const { response, body } = await controlPlane(
    `/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: "DELETE" },
    90_000,
  );
  assert(
    response.status >= 200 && response.status < 300,
    `DELETE /workspaces/:id HTTP ${response.status}${apiError(body)}`,
  );
  const returned = body !== null && typeof body === "object" ? body.workspace : null;
  const destroyed = returned?.phase === "destroyed"
    ? returned
    : await waitForWorkspace(workspaceId, "destroyed", 180_000);
  assert(destroyed.phase === "destroyed", "workspace did not reach phase=destroyed");
  workspaceDestroyed = true;
  return response.status;
}

function skillPathFor(provider) {
  return `${BOX_HOME}/.claude/skills/${provider}/SKILL.md`;
}

/** Reads a variable out of a fresh login shell without echoing its value:
 * length and emptiness are the whole assertion a credential test may make. */
function environmentReport(names) {
  const script = names
    .map((name) => `printf '%s=%s\\n' ${shellQuote(name)} "\${#${name}}"`)
    .join("\n");
  const result = runFreshLogin(script);
  assert(result.status === 0, `login shell failed: ${commandFailure(result)}`);
  const lengths = new Map();
  for (const line of String(result.stdout ?? "").split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    lengths.set(line.slice(0, separator), Number(line.slice(separator + 1)));
  }
  return lengths;
}

const preflight = await runStep("0", "preflight", () => {
  const problem = validateConfig();
  if (problem !== null) return fail(problem);
  const detail = generateKeypair();
  assert(publicKey !== null, "public key is unavailable after generation");
  return pass(`${detail}; cp=${cpUrl}; machine=${machineTypeId}`);
});

if (preflight.status === "PASS") {
  await runStep("1", "discover the catalog and the operator's grants", async () => {
    cookie = await mintSession();
    const catalogResponse = await controlPlane("/connections/catalog");
    assert(
      catalogResponse.response.status === 200,
      `GET /connections/catalog HTTP ${catalogResponse.response.status}${apiError(catalogResponse.body)}`,
    );
    catalog = catalogResponse.body?.providers ?? [];
    assert(Array.isArray(catalog) && catalog.length > 0, "catalog is empty");

    const grantResponse = await controlPlane("/connections/grants");
    assert(
      grantResponse.response.status === 200,
      `GET /connections/grants HTTP ${grantResponse.response.status}${apiError(grantResponse.body)}`,
    );
    grants = grantResponse.body?.grants ?? [];
    const serialized = JSON.stringify({ catalog, grants });
    assert(!/"token"|"refresh|ciphertext/u.test(serialized), "a discovery response carried token material");

    const candidates = wantedProvider.length > 0
      ? grants.filter(({ provider }) => provider === wantedProvider)
      : grants;
    const chosen = candidates[0] ?? null;
    if (chosen === null) {
      return skip(
        `no grant to exercise (catalog=${catalog.length}, grants=${grants.length}${wantedProvider.length > 0 ? `, wanted=${wantedProvider}` : ""})`,
      );
    }
    const entry = catalog.find(({ id }) => id === chosen.manifestId) ?? null;
    assert(entry !== null, `grant ${chosen.provider} names manifest ${chosen.manifestId}, which is not in the catalog`);
    subject = { grant: chosen, entry };
    return pass(
      `provider=${chosen.provider}; manifest=${chosen.manifestId}; custody=${entry.custody}; env=${entry.environmentNames.join(",")}`,
    );
  });
}

/** Every box-side gate needs a discovered grant; without one the suite has
 * nothing honest to assert and says so instead of inventing a provider. */
const gated = (action) => async () => {
  if (subject === null) return skip("no connected provider was discovered");
  return action();
};

if (subject !== null) {
  await runStep("2", "create a workspace enabling the discovered connection", async () => {
    const { response, body } = await controlPlane(
      "/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          machineTypeId,
          sshPublicKey: publicKey,
          connections: [subject.grant.provider],
        }),
      },
      90_000,
    );
    assert(response.status === 201, `POST /workspaces HTTP ${response.status}${apiError(body)}`);
    const created = body?.workspace ?? null;
    assert(typeof created?.id === "string", "create did not return a workspace id");
    workspaceId = created.id;
    recordWorkspaceId(workspaceId);
    const ready = await waitForWorkspace(workspaceId, "ready", readyTimeoutMs);
    captureSshMetadata(ready);
    return pass(`workspace=${workspaceId}; phase=ready`);
  });

  await runStep("3", "the first login shell mints and leaves an active lease", gated(
    async () => {
      // Delivery is the blitz-cred sync the profile hook runs, not a pre-mint
      // at the ready transition: nothing holds a credential the box never
      // received, so nothing is minted before a shell asks.
      const login = runFreshLogin("true");
      assert(login.status === 0, `login shell failed: ${commandFailure(login)}`);
      const leases = await listWorkspaceLeases();
      const active = leases.filter(
        (lease) => lease.connection === subject.grant.provider && lease.state === "active",
      );
      assert(active.length > 0, "the first login shell left no active lease");
      assert(
        active.every((lease) => typeof lease.userId === "string" && lease.userId.length > 0),
        "a lease has no owner recorded; credential_leases.user_id must always be the workspace owner",
      );
      revokedLeaseId = active[0].id;
      return pass(`active leases=${active.length}; mode=${active[0].mode}`);
    },
  ));

  await runStep("4", "a fresh login shell exports the manifest's names", gated(
    () => {
      const lengths = environmentReport(subject.entry.environmentNames);
      const missing = subject.entry.environmentNames.filter(
        (name) => (lengths.get(name) ?? 0) === 0,
      );
      assert(missing.length === 0, `login shell did not export ${missing.join(", ")}`);
      return pass(
        subject.entry.environmentNames.map((name) => `${name}=${lengths.get(name)}B`).join(" "),
      );
    },
  ));

  await runStep("5", "the skill file lands where a harness will read it", gated(
    () => {
      const path = skillPathFor(subject.grant.provider);
      const result = runSsh(`cat ${shellQuote(path)}`);
      assert(result.status === 0, `reading ${path} failed: ${commandFailure(result)}`);
      const text = String(result.stdout ?? "");
      assert(text.length > 0, `${path} is empty`);
      assert(
        text.startsWith(`---\nname: ${subject.grant.provider}\n`),
        `${path} does not open with the skill frontmatter naming the connection`,
      );
      assert(text.includes("description:"), `${path} has no description`);
      for (const name of subject.entry.environmentNames) {
        if (text.includes(`$${name}`)) return pass(`${path}: ${text.length}B, references $${name}`);
      }
      throw new Error(`${path} names none of the connection's environment variables`);
    },
  ));

  await runStep("6", "the proxy authenticates only the lease token", gated(
    () => {
      if (subject.entry.custody !== "proxy") {
        return skip(`custody=${subject.entry.custody}; the proxy data path does not apply`);
      }
      const tokenName = subject.entry.environmentNames[0];
      const baseName = subject.entry.environmentNames.find((name) => /_URL$/u.test(name));
      assert(typeof tokenName === "string", "the connection declares no environment names");
      assert(baseName !== undefined, "proxy custody declared no base-URL variable");
      const script = [
        `set -eu`,
        `url="$${baseName}"`,
        `anon=$(curl -sS -o /dev/null -w '%{http_code}' "$url/" || true)`,
        `auth=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $${tokenName}" "$url/" || true)`,
        `printf 'anon=%s auth=%s\\n' "$anon" "$auth"`,
      ].join("\n");
      const result = runFreshLogin(script);
      assert(result.status === 0, `proxy probe failed: ${commandFailure(result)}`);
      const line = String(result.stdout ?? "").trim().split(/\r?\n/u).at(-1) ?? "";
      const anon = /anon=(\d+)/u.exec(line)?.[1] ?? "";
      const auth = /auth=(\d+)/u.exec(line)?.[1] ?? "";
      assert(anon === "401", `an unauthenticated proxy call returned ${anon}; expected 401`);
      assert(auth !== "401", `the leased proxy call returned 401; the swap did not happen`);
      return pass(`anon=${anon} auth=${auth}`);
    },
  ));

  await runStep("7", "revoking the lease empties the surfaces on the next sync", gated(
    async () => {
      assert(revokedLeaseId !== null, "no lease id was captured");
      const { response, body } = await controlPlane(
        `/leases/${encodeURIComponent(revokedLeaseId)}`,
        { method: "DELETE" },
      );
      assert(response.status === 204, `DELETE /leases/:id HTTP ${response.status}${apiError(body)}`);
      // Every remaining lease has to go too, or the next sync re-mints.
      for (const lease of await listWorkspaceLeases()) {
        if (lease.state !== "active") continue;
        await controlPlane(`/leases/${encodeURIComponent(lease.id)}`, { method: "DELETE" });
      }
      const synced = runSsh("blitz-cred sync", 60_000);
      assert(synced.status === 0, `blitz-cred sync failed: ${commandFailure(synced)}`);

      const path = skillPathFor(subject.grant.provider);
      const skill = runSsh(`wc -c < ${shellQuote(path)}`);
      assert(skill.status === 0, `reading ${path} after revoke failed: ${commandFailure(skill)}`);
      const bytes = Number(String(skill.stdout ?? "").trim());
      assert(bytes === 0, `${path} still holds ${bytes} bytes after revoke`);

      const lengths = environmentReport(subject.entry.environmentNames);
      const surviving = subject.entry.environmentNames.filter(
        (name) => (lengths.get(name) ?? 0) > 0,
      );
      assert(surviving.length === 0, `revoked connection still exports ${surviving.join(", ")}`);
      return pass(`skill emptied; ${subject.entry.environmentNames.length} names unset`);
    },
  ));
}

await runStep("8", "an unconnected provider files a connect-inbox entry", async () => {
  if (workspaceId === null || sshInfo === null) return skip("no ready workspace to ask from");
  const asked = runSsh(`blitz-cred token ${shellQuote(UNCONNECTED_PROVIDER)}`, 45_000);
  assert(asked.status !== 0, "asking for an unconnected provider unexpectedly succeeded");
  const { response, body } = await controlPlane("/requests?state=pending");
  assert(response.status === 200, `GET /requests HTTP ${response.status}${apiError(body)}`);
  const pending = (body?.requests ?? []).filter(
    (request) => request.workspace_id === workspaceId
      && request.connection_name === UNCONNECTED_PROVIDER,
  );
  assert(pending.length === 1, `expected one pending inbox entry, saw ${pending.length}`);
  inboxRequestId = pending[0].id;
  return pass(`inbox entry=${inboxRequestId}; stderr=${safeText(asked.stderr)}`);
});

await runStep("T", "teardown", async () => {
  const needsSession = workspaceId !== null && !workspaceDestroyed;
  if (!needsSession && inboxRequestId === null) return pass("nothing to clean up");

  let usedFreshSession = false;
  try {
    cookie = await mintSession();
    usedFreshSession = true;
  } catch (error) {
    if (cookie === null) {
      return fail(
        `cleanup session failed and no prior session is available: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const problems = [];
  if (inboxRequestId !== null) {
    const denied = await controlPlane(
      `/requests/${encodeURIComponent(inboxRequestId)}/deny`,
      { method: "POST", body: "{}" },
    );
    if (denied.response.status !== 204) {
      problems.push(`deny inbox entry HTTP ${denied.response.status}`);
    }
  }
  if (workspaceId !== null && !workspaceDestroyed) {
    if (workspaceId === PROTECTED_WORKSPACE_ID) {
      problems.push("refused protected workspace cleanup");
    } else if (!ledgeredWorkspaceIds.has(workspaceId)) {
      problems.push(`refused unledgered workspace cleanup id=${workspaceId}`);
    } else {
      try {
        await destroyCurrentWorkspace();
      } catch (error) {
        problems.push(
          `workspace cleanup failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  // The discovered grant belongs to the operator, not to this run. Revoking it
  // would destroy state the suite did not create.
  if (problems.length > 0) return fail(problems.join("; "));
  return pass(
    `workspace=${workspaceId === null ? "none" : "destroyed"}; grant untouched; fresh_session=${usedFreshSession}`,
  );
});

const failed = results.filter((result) => result.status === "FAIL").length;
const passed = results.filter((result) => result.status === "PASS").length;
const skipped = results.filter((result) => result.status === "SKIP").length;
console.log(
  JSON.stringify({
    summary: {
      passed,
      failed,
      skipped,
      total: results.length,
      workspaceId,
      provider: subject?.grant.provider ?? null,
      manifestId: subject?.grant.manifestId ?? null,
      custody: subject?.entry.custody ?? null,
      cleanupAttempted: workspaceId !== null,
      ledgerPath,
      machineTypeId,
      steps: Object.fromEntries(results.map((result) => [result.id, result.status])),
    },
  }),
);
process.exitCode = failed;

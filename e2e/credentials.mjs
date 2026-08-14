#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const DEFAULT_WORK_DIR = join(repoRoot, "scratchpad", "credentials");
const DEFAULT_LEDGER = join(DEFAULT_WORK_DIR, "workspace-ids");
const PROTECTED_WORKSPACE_ID = "f8434c15-991a-486d-bd37-6df51c0f0647";
const INJECT_SENTINEL = "blitz-e2e-inject-sentinel-7f3a";
const RESEND_SENTINEL = "blitz-e2e-resend-sentinel-31c9";
const INTEGRATION_NAMES = ["hetzner-inject", "hetzner", "resend-e2e"];
const readyTimeoutMs = Number(process.env.READY_TIMEOUT_MS ?? 180_000);
const runToken = randomBytes(6).toString("hex");

const cpUrl = (process.env.CP_URL ?? "").replace(/\/+$/u, "");
const operatorKey = process.env.OPERATOR_API_KEY ?? "";
const hetznerKey = process.env.HETZNER_API_KEY ?? "";
const machineTypeId = process.env.MACHINE_TYPE ?? "mv-2c2g@lab";
const workDir = resolve(process.env.WORK_DIR ?? DEFAULT_WORK_DIR);
const ledgerPath = resolve(process.env.WORKSPACE_LEDGER ?? DEFAULT_LEDGER);
const githubEnabled = process.env.GITHUB_E2E === "1";
const githubRepo = process.env.GITHUB_PRIVATE_REPO ?? process.env.GITHUB_REPO ?? "";
const hetznerProbe = hetznerKey.slice(0, 8);

const cliPath = join(workDir, "blitz-cred");
const profileSourcePath = join(repoRoot, "packages/box/rootfs/etc/profile.d/blitz-creds.sh");
const results = [];
const sensitiveValues = [
  operatorKey,
  hetznerKey,
  hetznerProbe,
  githubRepo,
].filter((value) => value.length > 0);
const integrationPutAttempted = new Set();
const integrationUpserted = new Map(INTEGRATION_NAMES.map((name) => [name, false]));
const ledgeredWorkspaceIds = new Set();

let cookie = null;
let keyPath = null;
let publicKey = null;
let workspaceId = null;
let workspaceDestroyed = false;
let sshInfo = null;
let knownHostsPath = null;
let deniedMintAttemptedTwice = false;

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
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
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
  if (hetznerKey.length === 0) return "HETZNER_API_KEY is required";
  if (hetznerProbe.length < 8) return "HETZNER_API_KEY must be at least 8 characters";
  return null;
}

function childEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  delete environment.OPERATOR_API_KEY;
  delete environment.HETZNER_API_KEY;
  return environment;
}

function commandFailure(result) {
  if (result.error !== undefined) return safeText(result.error.message);
  const stderr = String(result.stderr ?? "").trim().split(/\r?\n/u)[0];
  return stderr.length > 0 ? safeText(stderr) : `exit ${result.status ?? "unknown"}`;
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
      ["-q", "-t", "ed25519", "-N", "", "-C", `blitz-credentials-${runToken}`, "-f", privateKeyPath],
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function matchCredentialFailure(stderr, integration, kind) {
  const text = String(stderr ?? "").trim();
  const escapedIntegration = integration.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const requestedPattern = kind === "access"
    ? new RegExp(
      `^blitz: access to ${escapedIntegration} requested \\(([^()\\r\\n]+)\\), awaiting approval$`,
      "u",
    )
    : new RegExp(
      `^blitz: integration ${escapedIntegration} requested \\(([^()\\r\\n]+)\\), not configured yet$`,
      "u",
    );
  const fallbackPattern = kind === "access"
    ? new RegExp(
      `^blitz: access to ${escapedIntegration} denied by workspace policy$`,
      "u",
    )
    : new RegExp(
      `^blitz: integration ${escapedIntegration} is not configured$`,
      "u",
    );
  const requested = text.match(requestedPattern);
  if (requested !== null) return { form: "requested", requestId: requested[1], text };
  if (fallbackPattern.test(text)) return { form: "fallback", requestId: null, text };
  return null;
}

function proxyFetchCommand() {
  const script = [
    "const url = process.env.HETZNER_PROXY_URL;",
    "const token = process.env.HETZNER_PROXY_TOKEN;",
    'if (!url || !token) throw new Error("proxy environment is incomplete");',
    'const endpoint = url.endsWith("/") ? `${url}v1/servers` : `${url}/v1/servers`;',
    "const response = await fetch(endpoint, {",
    "  headers: { Authorization: `Bearer ${token}` },",
    "});",
    "const body = await response.json().catch(() => null);",
    'const servers = Array.isArray(body?.servers) ? body.servers.length : "missing";',
    "process.stdout.write(`status=${response.status} servers=${servers}\\n`);",
  ].join("\n");
  return `node --input-type=module -e ${shellQuote(script)}`;
}

function sshArgs(info, hostKeysPath, remoteCommand = undefined) {
  assert(keyPath !== null, "SSH private key is unavailable");
  const args = [
    "-T",
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
    `UserKnownHostsFile=${hostKeysPath}`,
    `${info.user}@${info.host}`,
  ];
  if (remoteCommand !== undefined) args.push(remoteCommand);
  return args;
}

function scpArgs(info, hostKeysPath, sources, destination) {
  assert(keyPath !== null, "SSH private key is unavailable");
  const remoteHost = info.host.includes(":") ? `[${info.host}]` : info.host;
  return [
    "-i",
    keyPath,
    "-P",
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
    `UserKnownHostsFile=${hostKeysPath}`,
    ...sources,
    `${info.user}@${remoteHost}:${destination}`,
  ];
}

function runSsh(remoteCommand, timeout = 30_000) {
  assert(sshInfo !== null && knownHostsPath !== null, "ready SSH metadata is unavailable");
  return spawnSync("ssh", sshArgs(sshInfo, knownHostsPath, remoteCommand), {
    encoding: "utf8",
    timeout,
    env: childEnvironment(),
  });
}

function runLoginSsh(script, timeout = 30_000) {
  return runSsh(`bash -lc ${shellQuote(script)}`, timeout);
}

function runFreshLogin(script, timeout = 30_000) {
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
    if (wantedPhase === "ready" && lastPhase === "error") {
      throw new Error(`workspace ${id} reached phase=error; error=${workspace.error ?? "unspecified"}`);
    }
    if (
      wantedPhase === "ready" &&
      (lastPhase === "destroying" || lastPhase === "destroyed")
    ) {
      throw new Error(`workspace ${id} reached unexpected phase=${lastPhase}`);
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
  const destroyed =
    returned?.phase === "destroyed"
      ? returned
      : await waitForWorkspace(workspaceId, "destroyed", 180_000);
  assert(destroyed.phase === "destroyed", "workspace did not reach phase=destroyed");
  workspaceDestroyed = true;
  return response.status;
}

function proxyConfiguration() {
  return {
    proxy: {
      base_url: "https://api.hetzner.cloud",
      token_header: "Authorization",
      token_prefix: "Bearer ",
    },
    placements: [
      {
        kind: "env",
        name: "HETZNER_PROXY_URL",
        fill: "proxy-url",
      },
      {
        kind: "env",
        name: "HETZNER_PROXY_TOKEN",
        fill: "token",
      },
    ],
  };
}

try {
  await runStep("0", "preflight", async () => {
    const configError = validateConfig();
    if (configError !== null) return fail(configError);
    const keypairResult = generateKeypair();
    cookie = await mintSession();
    return pass(
      `${keypairResult}; session HTTP 204; operator_key_length=${operatorKey.length}; proxy_root_length=${hetznerKey.length}; cookie_length=${cookie.length}`,
    );
  });

  await runStep("A", "build-box-cli", async () => {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const built = spawnSync("go", ["build", "-o", cliPath, "./cmd/blitz-cred"], {
      cwd: join(repoRoot, "packages/broker"),
      encoding: "utf8",
      timeout: 180_000,
      env: childEnvironment({ GOOS: "linux", GOARCH: "amd64" }),
    });
    if (built.status !== 0) return fail(`cross-compile failed: ${commandFailure(built)}`);
    if (!existsSync(cliPath)) return fail("go build exited 0 but the blitz-cred output is missing");
    return pass("GOOS=linux GOARCH=amd64 blitz-cred cross-compiled");
  });

  await runStep("B", "configure-integrations", async () => {
    if (cookie === null) return fail("preflight session prerequisite failed");
    const definitions = [
      {
        name: "hetzner-inject",
        body: {
          provider: "hetzner",
          kind: "static",
          custody: "cp",
          root: INJECT_SENTINEL,
          config: { placements: [{ kind: "env", name: "HCLOUD_TOKEN" }] },
        },
      },
      {
        name: "hetzner",
        body: {
          provider: "hetzner",
          kind: "static",
          custody: "proxy",
          root: hetznerKey,
          config: proxyConfiguration(),
        },
      },
      {
        name: "resend-e2e",
        body: {
          provider: "resend",
          kind: "static",
          custody: "cp",
          root: RESEND_SENTINEL,
          config: { placements: [{ kind: "env", name: "RESEND_API_KEY" }] },
        },
      },
    ];
    const problems = [];
    for (const definition of definitions) {
      integrationPutAttempted.add(definition.name);
      try {
        const { response, body } = await controlPlane(
          `/integrations/${encodeURIComponent(definition.name)}`,
          { method: "PUT", body: JSON.stringify(definition.body) },
        );
        if (response.status === 204) {
          integrationUpserted.set(definition.name, true);
        } else {
          problems.push(`${definition.name}=HTTP ${response.status}${apiError(body)}`);
        }
      } catch (error) {
        problems.push(`${definition.name}=${error instanceof Error ? error.message : error}`);
      }
    }
    if (problems.length > 0) return fail(`integration upsert failures: ${problems.join("; ")}`);
    return pass("three integration upserts returned HTTP 204; roots were not echoed");
  });

  await runStep("1", "create-ready-ssh", async () => {
    if (cookie === null || publicKey === null) {
      return fail("preflight session/keypair prerequisite failed");
    }
    const manifestIntegrations = {
      "hetzner-inject": {},
      hetzner: {},
      ...(githubEnabled ? { github: {} } : {}),
    };
    const { response, body } = await controlPlane(
      "/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          machineTypeId,
          sshPublicKey: publicKey,
          manifest: { integrations: manifestIntegrations },
        }),
      },
      90_000,
    );
    const workspace = body !== null && typeof body === "object" ? body.workspace : null;
    const id = typeof workspace?.id === "string" ? workspace.id : null;
    if (id !== null) {
      recordWorkspaceId(id);
      workspaceId = id;
    }
    if (response.status !== 201) {
      return fail(`POST /workspaces HTTP ${response.status}; expected 201${apiError(body)}`);
    }
    if (id === null) return fail("POST /workspaces HTTP 201 did not return workspace.id");
    const ready = workspace.phase === "ready"
      ? workspace
      : await waitForWorkspace(id, "ready", readyTimeoutMs);
    captureSshMetadata(ready);

    const deadline = Date.now() + 90_000;
    let lastFailure = "not attempted";
    while (Date.now() <= deadline) {
      const probe = runSsh("hostname; test -d /run/s6", 20_000);
      if (probe.status === 0 && probe.stdout.trim().length > 0) {
        return pass(
          `workspace=${id}; phase=ready; ledger appended; pinned SSH as ready user=${sshInfo.user}; reachability passed`,
        );
      }
      lastFailure = commandFailure(probe);
      await sleep(Math.min(3_000, Math.max(0, deadline - Date.now())));
    }
    return fail(`workspace=${id}; SSH was not reachable within 90s; last=${lastFailure}`);
  });

  await runStep("2", "box-bits", async () => {
    if (sshInfo === null || knownHostsPath === null) {
      return fail("successful step 1 SSH prerequisite failed");
    }
    if (!existsSync(cliPath)) return fail("step A blitz-cred artifact is missing");
    if (process.env.INSTALL_BOX_BITS !== "1") {
      const probe = runSsh(
        [
          "test -x /usr/local/bin/blitz-cred",
          "test -r /etc/profile.d/blitz-creds.sh",
          "test -r /etc/gitconfig",
          "/usr/local/bin/blitz-cred 2>&1 | head -1",
          `node -e ${shellQuote(
            'const{createHash}=require("node:crypto");const{readFileSync}=require("node:fs");console.log(createHash("sha256").update(readFileSync("/usr/local/bin/blitz-cred")).digest("hex"));',
          )}`,
        ].join(" && "),
        30_000,
      );
      if (probe.status !== 0) {
        return fail(
          `image is missing baked box bits (set INSTALL_BOX_BITS=1 for older images): ${commandFailure(probe)}`,
        );
      }
      const probeOut = String(probe.stdout ?? "");
      const usage = probeOut.split("\n")[0] ?? "";
      const bakedSha = probeOut.trim().split("\n").at(-1) ?? "";
      if (!usage.includes("sync") || !usage.includes("git-helper")) {
        return fail(
          `baked blitz-cred predates the credential CLI (usage=${safeText(usage)}); rebake the image`,
        );
      }
      return pass(
        `baked box bits verified in the image, zero install; blitz-cred speaks sync+git-helper (sha256 ${bakedSha.slice(0, 12)})`,
      );
    }
    const remoteDir = `/tmp/blitz-credentials-${runToken}`;
    const prepared = runSsh(`umask 077; mkdir ${shellQuote(remoteDir)}`);
    if (prepared.status !== 0) {
      return fail(`remote staging directory failed: ${commandFailure(prepared)}`);
    }
    const copied = spawnSync(
      "scp",
      scpArgs(
        sshInfo,
        knownHostsPath,
        [cliPath, profileSourcePath],
        `${remoteDir}/`,
      ),
      { encoding: "utf8", timeout: 60_000, env: childEnvironment() },
    );
    if (copied.status !== 0) {
      runSsh(
        `rm -f ${shellQuote(`${remoteDir}/blitz-cred`)} ${shellQuote(`${remoteDir}/blitz-creds.sh`)}; rmdir ${shellQuote(remoteDir)} 2>/dev/null || :`,
      );
      return fail(`scp of box bits failed: ${commandFailure(copied)}`);
    }
    const expectedProfile = 'export PATH="$HOME/bin:$PATH"\n. $HOME/.blitz-creds.sh\n';
    const expectedGitconfig = [
      '[credential "https://github.com"]',
      '    helper = "!/home/blitz/bin/blitz-cred git-helper"',
      "",
    ].join("\n");
    const verifyInstall = [
      'const fs = require("node:fs");',
      "const home = process.env.HOME;",
      `const expectedProfile = ${JSON.stringify(expectedProfile)};`,
      `const expectedGitconfig = ${JSON.stringify(expectedGitconfig)};`,
      "const checks = [",
      '  [`${home}/bin/blitz-cred`, 0o755, null],',
      '  [`${home}/.blitz-creds.sh`, 0o644, null],',
      '  [`${home}/.profile`, 0o644, expectedProfile],',
      '  [`${home}/.gitconfig`, 0o644, expectedGitconfig],',
      "];",
      "for (const [path, mode, contents] of checks) {",
      "  if ((fs.statSync(path).mode & 0o777) !== mode) process.exit(1);",
      '  if (contents !== null && fs.readFileSync(path, "utf8") !== contents) process.exit(1);',
      "}",
    ].join("\n");
    const installScript = [
      "set -e",
      "umask 022",
      'mkdir -p "$HOME/bin"',
      `install -m 0755 ${shellQuote(`${remoteDir}/blitz-cred`)} "$HOME/bin/blitz-cred"`,
      `install -m 0644 ${shellQuote(`${remoteDir}/blitz-creds.sh`)} "$HOME/.blitz-creds.sh"`,
      `printf '%s\\n' ${shellQuote('export PATH="$HOME/bin:$PATH"')} ${shellQuote(". $HOME/.blitz-creds.sh")} > "$HOME/.profile"`,
      `printf '%s\\n' ${shellQuote('[credential "https://github.com"]')} ${shellQuote('    helper = "!/home/blitz/bin/blitz-cred git-helper"')} > "$HOME/.gitconfig"`,
      'chmod 0644 "$HOME/.profile" "$HOME/.gitconfig"',
      `node -e ${shellQuote(verifyInstall)}`,
    ].join("\n");
    const installed = runSsh(`bash -c ${shellQuote(installScript)}`, 60_000);
    runSsh(
      `rm -f ${shellQuote(`${remoteDir}/blitz-cred`)} ${shellQuote(`${remoteDir}/blitz-creds.sh`)}; rmdir ${shellQuote(remoteDir)} 2>/dev/null || :`,
    );
    if (installed.status !== 0) {
      return fail(`user-level install failed: ${commandFailure(installed)}`);
    }
    return pass("user-level install (no root in image)");
  });

  await runStep("3", "zero-agent-action", async () => {
    if (!integrationUpserted.get("hetzner-inject")) {
      return fail("hetzner-inject upsert prerequisite failed");
    }
    if (sshInfo === null || knownHostsPath === null) {
      return fail("successful step 1 SSH prerequisite failed");
    }
    const fresh = runFreshLogin("printenv HCLOUD_TOKEN");
    if (fresh.status !== 0) {
      return fail(`fresh login printenv failed: ${commandFailure(fresh)}`);
    }
    const value = fresh.stdout.trim();
    if (value !== INJECT_SENTINEL) {
      return fail(
        `fresh login HCLOUD_TOKEN mismatch; expected synthetic sentinel length=${INJECT_SENTINEL.length}; actual_length=${value.length}`,
      );
    }
    return pass(
      `fresh login ran only printenv HCLOUD_TOKEN; profile hook delivered the synthetic sentinel (length=${value.length})`,
    );
  });

  await runStep("4", "inject-lease", async () => {
    if (cookie === null || workspaceId === null) {
      return fail("session/workspace prerequisite failed");
    }
    const leases = await listWorkspaceLeases();
    const activeInject = leases.filter(
      (lease) =>
        lease?.integration === "hetzner-inject" &&
        lease?.mode === "inject" &&
        lease?.state === "active",
    );
    if (activeInject.length === 0) {
      return fail("leases route has no active inject lease for hetzner-inject");
    }
    return pass(
      `active hetzner-inject lease count=${activeInject.length}; minted events have no session route, so this is the lease-only assertion`,
    );
  });

  await runStep("5", "denied-mint", async () => {
    if (!integrationUpserted.get("resend-e2e")) {
      return fail("resend-e2e upsert prerequisite failed");
    }
    if (sshInfo === null || knownHostsPath === null) {
      return fail("successful step 1 SSH prerequisite failed");
    }
    const requestIds = [];
    let fallbackForms = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const denied = runLoginSsh("blitz-cred token resend-e2e");
      if (denied.status === 0) {
        return fail(`denied mint attempt ${attempt} unexpectedly exited 0`);
      }
      const matched = matchCredentialFailure(denied.stderr, "resend-e2e", "access");
      if (matched === null) {
        const stderr = String(denied.stderr ?? "").trim() || "<empty>";
        return fail(
          `denied mint attempt ${attempt} stderr matched neither request nor policy-denial form; stderr=${safeText(stderr)}`,
        );
      }
      if (matched.requestId === null) fallbackForms += 1;
      else requestIds.push(matched.requestId);
    }
    deniedMintAttemptedTwice = true;
    const uniqueRequestIds = [...new Set(requestIds)];
    return pass(
      `two denied mints exited non-zero with accepted stderr forms; request_ids=${uniqueRequestIds.length > 0 ? uniqueRequestIds.join(",") : "none"}; fallback_forms=${fallbackForms}`,
    );
  });

  await runStep("6", "proxy-gate", async () => {
    if (!integrationUpserted.get("hetzner")) {
      return fail("hetzner proxy upsert prerequisite failed; phase 3 may not be deployed");
    }
    if (sshInfo === null || knownHostsPath === null) {
      return fail("successful step 1 SSH prerequisite failed");
    }
    const proxyCall = runLoginSsh(proxyFetchCommand(), 60_000);
    const proxyOutput = String(proxyCall.stdout ?? "").trim();
    if (proxyCall.status !== 0) {
      return fail(`in-box proxy call or JSON parse failed: ${commandFailure(proxyCall)}`);
    }
    const proxyStatus = proxyOutput.match(/^status=(\d{3}) servers=(\d+|missing)$/u);
    if (proxyStatus === null) {
      return fail(`in-box proxy output was not a status line; stdout=${safeText(proxyOutput || "<empty>")}`);
    }
    if (proxyStatus[1] !== "200" || !/^\d+$/u.test(proxyStatus[2])) {
      return fail(
        `in-box proxy returned status=${proxyStatus[1]} servers=${proxyStatus[2]}; expected status=200 with numeric count`,
      );
    }

    const leakScript = [
      `env BLITZ_E2E_SECRET_PROBE=${shellQuote(hetznerProbe)} sh -c`,
      shellQuote(
        "printenv | grep -v '^BLITZ_E2E_SECRET_PROBE=' | grep -F -c \"$BLITZ_E2E_SECRET_PROBE\" || true",
      ),
    ].join(" ");
    const leakProbe = runLoginSsh(leakScript);
    if (leakProbe.status !== 0) {
      return fail(`real-key environment probe failed: ${commandFailure(leakProbe)}`);
    }
    if (leakProbe.stdout.trim() !== "0") {
      return fail("real-key prefix was present in the fresh login environment");
    }
    return pass(
      `proxy status=200; servers=${proxyStatus[2]}; real-key prefix environment count=0`,
    );
  });

  await runStep("7", "revoke-kills-token", async () => {
    if (!integrationUpserted.get("hetzner")) {
      return fail("hetzner proxy upsert prerequisite failed; phase 3 may not be deployed");
    }
    const leases = await listWorkspaceLeases();
    const proxyLease = leases.find(
      (lease) =>
        lease?.integration === "hetzner" &&
        lease?.mode === "proxy" &&
        lease?.state === "active" &&
        typeof lease?.id === "string",
    );
    if (proxyLease === undefined) {
      return fail("leases route has no active hetzner proxy lease to revoke");
    }
    const { response, body } = await controlPlane(
      `/leases/${encodeURIComponent(proxyLease.id)}`,
      { method: "DELETE" },
    );
    if (response.status !== 204) {
      return fail(`DELETE /leases/:id HTTP ${response.status}; expected 204${apiError(body)}`);
    }
    const revokedCall = runLoginSsh(proxyFetchCommand(), 60_000);
    if (revokedCall.status !== 0) {
      return fail(`revoked-token fetch failed: ${commandFailure(revokedCall)}`);
    }
    const revokedOutput = String(revokedCall.stdout ?? "").trim();
    const revokedStatus = revokedOutput.match(/^status=(\d{3}) servers=(\d+|missing)$/u);
    if (revokedStatus === null) {
      return fail(
        `revoked-token output was not a status line; stdout=${safeText(revokedOutput || "<empty>")}`,
      );
    }
    if (revokedStatus[1] !== "401") {
      return fail(`revoked proxy token returned HTTP ${revokedStatus[1]}; expected 401`);
    }
    return pass("DELETE lease HTTP 204; cached in-box proxy handle now returns HTTP 401");
  });

  await runStep("8", "request-loop", async () => {
    const pending = await controlPlane("/requests?state=pending");
    if (pending.response.status === 404) {
      return skip("GET /requests returned 404; phase 4 request loop is not deployed");
    }
    if (pending.response.status !== 200) {
      return fail(
        `GET /requests?state=pending HTTP ${pending.response.status}; expected 200 or phase-skip 404${apiError(pending.body)}`,
      );
    }
    if (!deniedMintAttemptedTwice) {
      return fail("step 5 did not complete two denied mints; request dedup cannot be asserted");
    }
    const requests =
      pending.body !== null && typeof pending.body === "object" ? pending.body.requests : null;
    if (!Array.isArray(requests)) {
      return fail("GET /requests HTTP 200 did not return response.requests");
    }
    const mine = requests.filter(
      (row) => (row?.workspaceId ?? row?.workspace_id) === workspaceId,
    );
    if (mine.length !== 1) {
      return fail(
        `pending request count for this workspace=${mine.length}; expected exactly 1 after two denied mints`,
      );
    }
    const request = mine[0];
    const requestIntegration =
      request?.integration ?? request?.integrationName ?? request?.integration_name;
    if (typeof request?.id !== "string" || requestIntegration !== "resend-e2e") {
      return fail("pending request did not identify this workspace and resend-e2e");
    }
    const approved = await controlPlane(
      `/requests/${encodeURIComponent(request.id)}/approve`,
      { method: "POST", body: "{}" },
    );
    if (approved.response.status !== 204) {
      return fail(
        `POST /requests/:id/approve HTTP ${approved.response.status}; expected 204${apiError(approved.body)}`,
      );
    }
    const minted = runLoginSsh("blitz-cred token resend-e2e");
    if (minted.status !== 0 || !/^\d+\s*$/u.test(String(minted.stdout ?? ""))) {
      return fail("approved resend-e2e mint did not exit 0 with a numeric expiry");
    }
    const fresh = runFreshLogin("printenv RESEND_API_KEY");
    if (fresh.status !== 0) {
      return fail(`fresh RESEND_API_KEY shell failed: ${commandFailure(fresh)}`);
    }
    if (fresh.stdout.trim() !== RESEND_SENTINEL) {
      return fail(
        `fresh RESEND_API_KEY mismatch; expected_length=${RESEND_SENTINEL.length}; actual_length=${fresh.stdout.trim().length}`,
      );
    }
    const after = await controlPlane("/requests?state=pending");
    if (after.response.status !== 200) {
      return fail(`post-approval pending GET HTTP ${after.response.status}; expected 200${apiError(after.body)}`);
    }
    const remaining = after.body !== null && typeof after.body === "object"
      ? after.body.requests
      : null;
    if (!Array.isArray(remaining)) {
      return fail("post-approval pending GET did not return response.requests");
    }
    const remainingMine = remaining.filter(
      (row) => (row?.workspaceId ?? row?.workspace_id) === workspaceId,
    );
    if (remainingMine.length !== 0) {
      return fail(
        `post-approval pending request count for this workspace=${remainingMine.length}; expected 0`,
      );
    }
    const missingIntegration = "future-provider";
    const missing = runLoginSsh(`blitz-cred token ${shellQuote(missingIntegration)}`);
    if (missing.status === 0) {
      return fail(`${missingIntegration} mint unexpectedly exited 0`);
    }
    const missingMatch = matchCredentialFailure(
      missing.stderr,
      missingIntegration,
      "integration",
    );
    if (missingMatch === null) {
      const stderr = String(missing.stderr ?? "").trim() || "<empty>";
      return fail(
        `${missingIntegration} stderr matched neither request nor not-configured form; stderr=${safeText(stderr)}`,
      );
    }
    const missingDetail = missingMatch.requestId === null
      ? "integration_request_id=none; integration_form=fallback"
      : `integration_request_id=${missingMatch.requestId}; integration_form=requested`;
    return pass(
      `two denials deduped to one request; approval minted; fresh shell saw synthetic resend value; pending count=0; ${missingDetail}`,
    );
  });

  // The private-repository gate needs a live box. Capture it immediately before
  // the destructive gate, then report it as step 10 after step 9.
  const githubOutcome = await captureOutcome(async () => {
    if (!githubEnabled) return skip("no GitHub App configured");
    if (sshInfo === null || knownHostsPath === null) {
      return fail("successful step 1 SSH prerequisite failed");
    }
    if (githubRepo.length === 0) {
      return fail("GITHUB_PRIVATE_REPO is required when GITHUB_E2E=1");
    }
    let parsed;
    try {
      parsed = new URL(githubRepo);
    } catch {
      return fail("GITHUB_PRIVATE_REPO must be an HTTPS github.com URL");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.pathname.split("/").filter(Boolean).length < 2
    ) {
      return fail("GITHUB_PRIVATE_REPO must be a credential-free HTTPS github.com repository URL");
    }
    const destination = `/tmp/blitz-private-clone-${runToken}`;
    const cloned = runSsh(
      `git clone --quiet ${shellQuote(githubRepo)} ${shellQuote(destination)}`,
      180_000,
    );
    if (cloned.status !== 0) {
      return fail(`plain private git clone failed (exit=${cloned.status ?? "unknown"})`);
    }
    return pass("plain private git clone succeeded before the destructive workspace gate");
  });

  await runStep("9", "destroy-with-active-lease", async () => {
    if (cookie === null || workspaceId === null) {
      return fail("session/workspace prerequisite failed");
    }
    let activeBefore = null;
    let beforeProblem = null;
    try {
      const before = await listWorkspaceLeases();
      activeBefore = before.filter((lease) => lease?.state === "active").length;
      if (activeBefore === 0) beforeProblem = "no active lease existed before destroy";
    } catch (error) {
      beforeProblem = `pre-destroy leases failed: ${error instanceof Error ? error.message : error}`;
    }

    let deleteStatus;
    try {
      deleteStatus = await destroyCurrentWorkspace();
    } catch (error) {
      return fail(`workspace destroy failed: ${error instanceof Error ? error.message : error}`);
    }

    let leases;
    try {
      leases = await listWorkspaceLeases();
    } catch (error) {
      return fail(
        `DELETE HTTP ${deleteStatus} destroyed workspace, but post-destroy leases failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (beforeProblem !== null) {
      return fail(`DELETE HTTP ${deleteStatus} destroyed workspace, but gate prerequisite failed: ${beforeProblem}`);
    }
    if (leases.length === 0) {
      return fail("destroy succeeded but the durable leases route returned no lease rows");
    }
    const invalid = leases.filter(
      (lease) =>
        (lease?.state !== "revoked" && lease?.state !== "expired") || lease?.boxId !== null,
    );
    if (invalid.length > 0) {
      return fail(
        `destroy succeeded but ${invalid.length}/${leases.length} leases were not revoked/expired with boxId=null`,
      );
    }
    return pass(
      `DELETE HTTP ${deleteStatus}; active_before=${activeBefore}; durable_leases=${leases.length}; all state revoked/expired and boxId=null`,
    );
  });

  await runStep("10", "github", async () => githubOutcome);
} finally {
  await runStep("T", "teardown", async () => {
    const needsSession =
      (workspaceId !== null && !workspaceDestroyed) || integrationPutAttempted.size > 0;
    if (!needsSession) return pass("no workspace or attempted integration upserts to clean up");

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
    if (workspaceId !== null && !workspaceDestroyed) {
      if (workspaceId === PROTECTED_WORKSPACE_ID) {
        problems.push("refused protected workspace cleanup");
      } else if (!ledgeredWorkspaceIds.has(workspaceId)) {
        problems.push(`refused unledgered workspace cleanup id=${workspaceId}`);
      } else {
        try {
          await destroyCurrentWorkspace();
        } catch (error) {
          problems.push(`workspace cleanup failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    let requestsDenied = 0;
    if (workspaceId !== null) {
      try {
        const { response, body } = await controlPlane("/requests?state=pending");
        const pendingRows =
          response.status === 200 && body !== null && typeof body === "object"
            ? body.requests
            : null;
        if (Array.isArray(pendingRows)) {
          for (const row of pendingRows) {
            if ((row?.workspaceId ?? row?.workspace_id) !== workspaceId) continue;
            if (typeof row?.id !== "string") continue;
            const denied = await controlPlane(
              `/requests/${encodeURIComponent(row.id)}/deny`,
              { method: "POST", body: "{}" },
            );
            if (denied.response.status === 204) requestsDenied += 1;
          }
        }
      } catch {
        // Best effort; leftovers stay visible in the cockpit inbox.
      }
    }

    let integrationsCleaned = 0;
    for (const name of INTEGRATION_NAMES) {
      if (!integrationPutAttempted.has(name)) continue;
      try {
        const { response, body } = await controlPlane(
          `/integrations/${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        if (response.status === 204 || response.status === 404) {
          integrationsCleaned += 1;
        } else {
          problems.push(
            `DELETE integration ${name} HTTP ${response.status}${apiError(body)}`,
          );
        }
      } catch (error) {
        problems.push(
          `DELETE integration ${name} failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (problems.length > 0) return fail(problems.join("; "));
    return pass(
      `workspace=${workspaceId === null ? "none" : "destroyed"}; integration deletes=${integrationsCleaned}; fresh_session=${usedFreshSession}`,
    );
  });
}

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
      cleanupAttempted: workspaceId !== null,
      ledgerPath,
      machineTypeId,
      steps: Object.fromEntries(results.map((result) => [result.id, result.status])),
    },
  }),
);
process.exitCode = failed;

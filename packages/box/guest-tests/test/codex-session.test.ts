import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const launcherPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-codex-session", import.meta.url),
);

/** The path the broker writes into config.toml as codex's auth hook. The
 * launcher greps for exactly this, so the test has to name the same string the
 * broker does (packages/broker/internal/workspace/harness.go). */
const brokerAuthCommand = "/usr/local/bin/blitz-cred-codex";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  calls: string[][];
  stderr: string;
}

interface LaunchOptions {
  /** Exit code for `codex login status`. 1 means "Not logged in". */
  statusExit?: number;
  /** Exit code for `codex login --device-auth`. */
  deviceExit?: number;
  /** Device auth dies FROM SIGINT, which is what Ctrl-C actually does. */
  deviceSignal?: boolean;
  args?: string[];
  /** Write a broker-style config.toml carrying the auth hook. */
  brokerWired?: boolean;
  /** Set an API key in the environment. */
  apiKey?: string;
}

async function runLauncher(options: LaunchOptions = {}): Promise<RunResult> {
  const {
    statusExit = 0,
    deviceExit = 0,
    deviceSignal = false,
    args = [],
    brokerWired = false,
    apiKey,
  } = options;

  const directory = mkdtempSync(join(tmpdir(), "codex-session-"));
  directories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  const home = join(directory, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const callsPath = join(directory, "calls");
  writeFileSync(callsPath, "");

  if (brokerWired) {
    writeFileSync(join(home, ".codex", "config.toml"), [
      'model_provider = "blitz"',
      "",
      "[model_providers.blitz.auth]",
      `command = "${brokerAuthCommand}"`,
      "refresh_interval_ms = 300000",
      "",
    ].join("\n"));
  }

  // `kill -INT 0` signals the whole process group, the way a pty delivers
  // Ctrl-C. The launcher is spawned detached below so that group contains only
  // the launcher and this stub — never the vitest runner.
  const cancel = deviceSignal ? "kill -INT 0; sleep 5" : 'exit "$CODEX_DEVICE_EXIT"';
  writeFileSync(join(binDirectory, "codex"), `#!/usr/bin/env bash
printf 'codex' >>"$CODEX_SESSION_CALLS"
printf '\\0%s' "$@" >>"$CODEX_SESSION_CALLS"
printf '\\n' >>"$CODEX_SESSION_CALLS"
if [ "\${1-}" = login ] && [ "\${2-}" = status ]; then exit "$CODEX_STATUS_EXIT"; fi
if [ "\${1-}" = login ] && [ "\${2-}" = --device-auth ]; then ${cancel}; fi
exit 0
`);
  writeFileSync(join(binDirectory, "fallback-shell"), `#!/usr/bin/env bash
printf 'shell' >>"$CODEX_SESSION_CALLS"
printf '\\0%s' "$@" >>"$CODEX_SESSION_CALLS"
printf '\\n' >>"$CODEX_SESSION_CALLS"
`);
  chmodSync(join(binDirectory, "codex"), 0o755);
  chmodSync(join(binDirectory, "fallback-shell"), 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    HOME: home,
    SHELL: join(binDirectory, "fallback-shell"),
    CODEX_SESSION_CALLS: callsPath,
    CODEX_STATUS_EXIT: String(statusExit),
    CODEX_DEVICE_EXIT: String(deviceExit),
  };
  // The launcher treats either key as proof of authentication, so a key
  // leaking in from the developer's own shell would mask every probe below.
  delete env.CODEX_HOME;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  if (apiKey !== undefined) env.OPENAI_API_KEY = apiKey;

  return await new Promise((resolve) => {
    const child = spawn("bash", [launcherPath, ...args], { env, detached: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status, signal) => {
      // Read defensively: a launcher that dies before running the stub writes
      // no calls at all, and throwing in this handler would leave the promise
      // unresolved and report a timeout instead of the real failure.
      let raw = "";
      if (existsSync(callsPath)) raw = readFileSync(callsPath, "utf8").trimEnd();
      const calls = raw === "" ? [] : raw.split("\n").map((line) => line.split("\0"));
      resolve({ status, signal, calls, stderr });
    });
  });
}

describe("blitz-codex-session", () => {
  it("is executable and starts with a shebang", () => {
    // tmux execs this path directly on a box; it is not run as `bash <path>`.
    // The Dockerfile's chmod happens to glob it today, but the committed mode
    // is what a fresh checkout and any narrower glob will honour.
    expect(statSync(launcherPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(launcherPath, "utf8").startsWith("#!")).toBe(true);
  });

  it("starts Codex directly when Codex's own auth storage is signed in", async () => {
    const result = await runLauncher({ statusExit: 0, args: ["-m", "gpt-test", "hello"] });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "login", "status"],
      ["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-test", "hello"],
    ]);
  });

  it("starts Codex directly on a broker-wired box, without consulting login status", async () => {
    // The broker authenticates codex through an auth hook in config.toml and
    // deliberately writes no auth.json, so `codex login status` reports "Not
    // logged in" on a workspace that works. Gating on status alone would
    // hijack every hosted codex tab into a device prompt.
    const result = await runLauncher({ brokerWired: true, statusExit: 1 });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    ]);
    expect(result.stderr).not.toContain("Starting device authentication");
  });

  it("starts Codex directly when an API key is present", async () => {
    // codex reads the key itself, but its own status check ignores the
    // environment, so it reports signed out here too.
    const result = await runLauncher({ apiKey: "sk-test", statusExit: 1 });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    ]);
    expect(result.stderr).not.toContain("Starting device authentication");
  });

  it("uses device authentication only when no path is authenticated", async () => {
    const result = await runLauncher({ statusExit: 1, deviceExit: 0 });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "login", "status"],
      ["codex", "login", "--device-auth"],
      ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    ]);
    expect(result.stderr).toContain("Starting device authentication");
  });

  it("keeps the terminal usable when device authentication exits non-zero", async () => {
    const result = await runLauncher({ statusExit: 1, deviceExit: 1 });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "login", "status"],
      ["codex", "login", "--device-auth"],
      ["shell", "-l"],
    ]);
    expect(result.stderr).toContain("codex login --device-auth");
  });

  it("survives Ctrl-C during device authentication and still falls back", async () => {
    // The real cancel is SIGINT, not a non-zero exit. Codex installs no
    // handler, so it dies FROM the signal and bash re-raises for a foreground
    // child killed that way — which would kill this launcher, the tmux
    // session's root process, and close the tab instead of falling back.
    const result = await runLauncher({ statusExit: 1, deviceSignal: true });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "login", "status"],
      ["codex", "login", "--device-auth"],
      ["shell", "-l"],
    ]);
  });
});

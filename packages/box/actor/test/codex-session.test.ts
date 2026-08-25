import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const launcherPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-codex-session", import.meta.url),
);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RunResult {
  status: number | null;
  calls: string[][];
  stderr: string;
}

async function runLauncher(statusExit: number, deviceExit: number, args: string[] = []): Promise<RunResult> {
  const directory = mkdtempSync(join(tmpdir(), "codex-session-"));
  directories.push(directory);
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  const callsPath = join(directory, "calls");

  writeFileSync(join(binDirectory, "codex"), `#!/usr/bin/env bash
printf 'codex' >>"$CODEX_SESSION_CALLS"
printf '\\0%s' "$@" >>"$CODEX_SESSION_CALLS"
printf '\\n' >>"$CODEX_SESSION_CALLS"
if [ "\${1-}" = login ] && [ "\${2-}" = status ]; then exit "$CODEX_STATUS_EXIT"; fi
if [ "\${1-}" = login ] && [ "\${2-}" = --device-auth ]; then exit "$CODEX_DEVICE_EXIT"; fi
exit 0
`);
  writeFileSync(join(binDirectory, "fallback-shell"), `#!/usr/bin/env bash
printf 'shell' >>"$CODEX_SESSION_CALLS"
printf '\\0%s' "$@" >>"$CODEX_SESSION_CALLS"
printf '\\n' >>"$CODEX_SESSION_CALLS"
`);
  chmodSync(join(binDirectory, "codex"), 0o755);
  chmodSync(join(binDirectory, "fallback-shell"), 0o755);

  return await new Promise((resolve) => {
    const child = spawn("bash", [launcherPath, ...args], {
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        SHELL: join(binDirectory, "fallback-shell"),
        CODEX_SESSION_CALLS: callsPath,
        CODEX_STATUS_EXIT: String(statusExit),
        CODEX_DEVICE_EXIT: String(deviceExit),
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status) => {
      const calls = readFileSync(callsPath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => line.split("\0"));
      resolve({ status, calls, stderr });
    });
  });
}

describe("blitz-codex-session", () => {
  it("starts Codex directly when authentication already exists", async () => {
    const result = await runLauncher(0, 99, ["-m", "gpt-test", "hello"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "login", "status"],
      ["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-test", "hello"],
    ]);
  });

  it("uses device authentication before starting a signed-out Codex session", async () => {
    const result = await runLauncher(1, 0);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "login", "status"],
      ["codex", "login", "--device-auth"],
      ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    ]);
    expect(result.stderr).toContain("Starting device authentication");
  });

  it("keeps the terminal usable when device authentication is cancelled", async () => {
    const result = await runLauncher(1, 1);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      ["codex", "login", "status"],
      ["codex", "login", "--device-auth"],
      ["shell", "-l"],
    ]);
    expect(result.stderr).toContain("codex login --device-auth");
  });
});

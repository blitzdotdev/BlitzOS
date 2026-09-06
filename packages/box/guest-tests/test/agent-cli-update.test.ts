import { spawn, spawnSync } from "node:child_process";
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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const updater = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-agent-cli-update", import.meta.url),
);
const serviceRoot = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d/", import.meta.url),
);
const setpriv = "/usr/bin/setpriv";
const sudo = "/usr/bin/sudo";
const hostUid = process.getuid?.() ?? 1000;
const dropFromRoot = process.platform === "linux" && hostUid === 0 && existsSync(setpriv);
const sudoRoot = hostUid !== 0
  && existsSync(sudo)
  && spawnSync(sudo, ["-n", "true"]).status === 0;
const rootIt = hostUid === 0 || sudoRoot ? it : it.skip;
const temporaryDirectories: string[] = [];
const cliNames: ReadonlyArray<"codex" | "claude"> = ["codex", "claude"];

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

class Harness {
  readonly root = mkdtempSync(path.join(tmpdir(), "blitz-agent-cli-update-"));
  readonly bin = path.join(this.root, "bin");
  readonly calls = path.join(this.root, "calls");
  readonly stateDir = path.join(this.root, "state");
  readonly updateDir = path.join(this.root, "update");

  constructor(options: { missing?: "codex" | "claude" } = {}) {
    temporaryDirectories.push(this.root);
    chmodSync(this.root, 0o777);
    writeFileSync(this.calls, "", { mode: 0o666 });
    chmodSync(this.calls, 0o666);
    mkdirSync(this.bin);
    chmodSync(this.bin, 0o777);

    writeExecutable(
      path.join(this.bin, "flock"),
      [
        "#!/bin/sh",
        "[ \"$1\" = -w ] || exit 64",
        "shift 2",
        "lock=$1",
        "shift",
        "command=$1",
        "shift",
        "lock_dir=\"$lock.held\"",
        "while ! mkdir \"$lock_dir\" 2>/dev/null; do sleep 0.02; done",
        "trap 'rmdir \"$lock_dir\" 2>/dev/null || true' EXIT HUP INT TERM",
        "bash \"$command\" \"$@\"",
        "status=$?",
        "rmdir \"$lock_dir\" 2>/dev/null || true",
        "trap - EXIT HUP INT TERM",
        "exit \"$status\"",
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(this.bin, "npm"),
      [
        "#!/bin/sh",
        "printf 'npm|%s|%s|%s|%s\\n' \"$*\" \"$HOME\" \"$USER\" \"$NPM_CONFIG_PREFIX\" >>\"$BLITZ_TEST_CALLS\"",
        "exit 0",
        "",
      ].join("\n"),
    );
    for (const cli of cliNames) {
      if (options.missing === cli) continue;
      const upper = cli.toUpperCase();
      writeExecutable(
        path.join(this.bin, cli),
        [
          "#!/bin/sh",
          `printf '${cli}|%s|%s|%s|%s\\n' "$*" "$HOME" "$USER" "$NPM_CONFIG_PREFIX" >>"$BLITZ_TEST_CALLS"`,
          `if [ "\${BLITZ_TEST_HOLD_${upper}:-0}" = 1 ]; then`,
          `  touch "$BLITZ_TEST_${upper}_READY"`,
          `  while [ ! -e "$BLITZ_TEST_${upper}_RELEASE" ]; do sleep 0.02; done`,
          "fi",
          `if [ "\${BLITZ_TEST_FAIL_${upper}:-0}" = 1 ]; then exit 23; fi`,
          `npm ${cli} "$@"`,
          "",
        ].join("\n"),
      );
    }
  }

  environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${this.bin}:/usr/bin:/bin`,
      BLITZ_STATE_DIR: this.stateDir,
      BLITZ_AGENT_CLI_UPDATE_DIR: this.updateDir,
      BLITZ_AGENT_CLI_UPDATE_LOCK_WAIT: "5",
      BLITZ_TEST_CALLS: this.calls,
      ...extra,
    };
  }

  callLines(): string[] {
    return readFileSync(this.calls, "utf8").trim().split("\n").filter(Boolean);
  }
}

function invocation(asBlitz = true): { command: string; args: string[] } {
  if (!asBlitz && sudoRoot) {
    return { command: sudo, args: ["-n", "/bin/bash", updater] };
  }
  if (asBlitz && dropFromRoot) {
    return {
      command: setpriv,
      args: [
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        "/usr/bin/env",
        "bash",
        updater,
      ],
    };
  }
  return { command: "bash", args: [updater] };
}

function runUpdater(harness: Harness, extra: NodeJS.ProcessEnv = {}, asBlitz = true) {
  const run = invocation(asBlitz);
  return spawnSync(run.command, run.args, {
    encoding: "utf8",
    env: harness.environment(extra),
  });
}

function startUpdater(harness: Harness, extra: NodeJS.ProcessEnv = {}) {
  const run = invocation();
  const child = spawn(run.command, run.args, {
    env: harness.environment(extra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<{ status: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stderr }));
  });
  return { done };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent CLI updater", () => {
  it("refuses root before its first filesystem write", () => {
    const source = readFileSync(updater, "utf8");
    const rootGuard = source.indexOf('if [ "$current_uid" -eq 0 ]');

    expect(rootGuard).toBeGreaterThan(0);
    expect(source.indexOf("exit 77", rootGuard)).toBeLessThan(source.indexOf("mkdir -p"));
    expect(source).toContain("current_uid=$(/usr/bin/id -u)");
  });

  it("is a registered longrun that drops to blitz and sleeps after every tick", () => {
    const runPath = path.join(serviceRoot, "agent-cli-update/run");
    const source = readFileSync(runPath, "utf8");
    const code = source.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(spawnSync("bash", ["-n", runPath]).status).toBe(0);
    expect(spawnSync("bash", ["-n", updater]).status).toBe(0);
    expect(readFileSync(path.join(serviceRoot, "agent-cli-update/type"), "utf8").trim())
      .toBe("longrun");
    expect(statSync(path.join(serviceRoot, "agent-cli-update/dependencies.d/init-state")).isFile())
      .toBe(true);
    expect(statSync(path.join(serviceRoot, "user/contents.d/agent-cli-update")).isFile())
      .toBe(true);
    expect(code).toContain("BLITZ_AGENT_CLI_UPDATE_INTERVAL:-21600");
    expect(code).toContain("BLITZ_AGENT_CLI_UPDATE_BOOT_DELAY:-30");
    expect(code).toContain("s6-setuidgid blitz");
    expect(code).toContain("HOME=\"$state_dir/home\" USER=blitz NPM_CONFIG_PREFIX=/opt/blitz/npm");
    expect(code.indexOf('sleep "$boot_delay"')).toBeLessThan(code.indexOf("while true"));
    expect(code.indexOf("blitz-agent-cli-update || true")).toBeLessThan(
      code.lastIndexOf('sleep "$interval"'),
    );
  });

  it("runs both explicit update commands with the owned npm environment", () => {
    const harness = new Harness();
    const result = runUpdater(harness);

    expect(result.status, result.stderr).toBe(0);
    expect(harness.callLines()).toEqual([
      `codex|update|${harness.stateDir}/home|blitz|/opt/blitz/npm`,
      `npm|codex update|${harness.stateDir}/home|blitz|/opt/blitz/npm`,
      `claude|update|${harness.stateDir}/home|blitz|/opt/blitz/npm`,
      `npm|claude update|${harness.stateDir}/home|blitz|/opt/blitz/npm`,
    ]);
    expect(statSync(harness.updateDir).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(harness.updateDir, "log")).mode & 0o777).toBe(0o644);
  });

  it("runs claude after codex fails", () => {
    const harness = new Harness();
    const result = runUpdater(harness, { BLITZ_TEST_FAIL_CODEX: "1" });

    expect(result.status, result.stderr).toBe(0);
    expect(harness.callLines().filter((line) => !line.startsWith("npm|")))
      .toEqual([
        `codex|update|${harness.stateDir}/home|blitz|/opt/blitz/npm`,
        `claude|update|${harness.stateDir}/home|blitz|/opt/blitz/npm`,
      ]);
    expect(readFileSync(path.join(harness.updateDir, "log"), "utf8"))
      .toContain("codex update failed (exit 23)");
  });

  it("survives a missing CLI and still runs the other one", () => {
    const harness = new Harness({ missing: "codex" });
    const result = runUpdater(harness);

    expect(result.status, result.stderr).toBe(0);
    expect(harness.callLines().some((line) => line.startsWith("claude|update|"))).toBe(true);
    expect(readFileSync(path.join(harness.updateDir, "log"), "utf8"))
      .toContain("codex is missing; skipped");
  });

  it("serializes concurrent ticks with one flock", async () => {
    const harness = new Harness();
    const ready = path.join(harness.root, "codex-ready");
    const release = path.join(harness.root, "codex-release");
    const first = startUpdater(harness, {
      BLITZ_TEST_HOLD_CODEX: "1",
      BLITZ_TEST_CODEX_READY: ready,
      BLITZ_TEST_CODEX_RELEASE: release,
    });
    await waitForFile(ready);
    const second = startUpdater(harness);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.callLines().filter((line) => line.startsWith("codex|"))).toHaveLength(1);
    writeFileSync(release, "release\n");

    const [firstResult, secondResult] = await Promise.all([first.done, second.done]);
    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    expect(harness.callLines()
      .filter((line) => line.startsWith("codex|") || line.startsWith("claude|"))
      .map((line) => line.split("|", 1)[0]))
      .toEqual(["codex", "claude", "codex", "claude"]);
  });

  rootIt("refuses a real root invocation before it touches the npm prefix [root only]", () => {
    const harness = new Harness();
    const result = runUpdater(harness, {}, false);

    expect(result.status).toBe(77);
    expect(result.stderr).toContain("refusing to run as root");
    expect(harness.callLines()).toEqual([]);
    expect(existsSync(harness.updateDir)).toBe(false);
  });
});

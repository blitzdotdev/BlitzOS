import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * blitz-term hands a tab's environment to tmux, which execs the agent without
 * a login shell. No secret rides that hand-off: every credential, the
 * workspace's own variables included, is pulled at the moment of use with
 * `blitz-cred get <name>`, so a tmux session environment can never outlive the
 * grant that authorized it. These drive the real script with stub tmux,
 * blitz-cred and timeout binaries, because the failures that matter here are
 * runtime ones `bash -n` cannot see.
 */

const blitzTermPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-term", import.meta.url),
);

/** Records the argv of whichever tmux verb ran, plus the handful of variables
 * these tests care about — an exec'd child sees exactly what blitz-term
 * exported, so its own environment is the observable outcome. */
const TMUX_STUB = `#!/usr/bin/env bash
set -eu
verb="" target="" prev=""
for arg in "$@"; do
  case "$prev" in
    -t|-s) target=\${arg#=} ;;
  esac
  case "$arg" in
    has-session|new-session|attach-session) verb=$arg ;;
  esac
  prev=$arg
done
case "$verb" in
  has-session)
    [ -e "$TMUX_STUB_STATE/session-$target" ]
    ;;
  new-session|attach-session)
    printf '%s\\0' "$@" >"$TMUX_STUB_STATE/$verb-argv"
    printf '%s\\n' "GH_TOKEN=\${GH_TOKEN-<unset>}" "PROJECT_MODE=\${PROJECT_MODE-<unset>}" \\
      "REGION=\${REGION-<unset>}" >"$TMUX_STUB_STATE/$verb-env"
    ;;
  *)
    exit 9
    ;;
esac
`;

/** Stands in for coreutils `timeout`, so the suite pins blitz-term's behaviour
 * rather than whether the host that runs it happens to ship the binary. */
const TIMEOUT_STUB = "#!/bin/sh\nshift\nexec \"$@\"\n";

interface TermBox {
  stateDir: string;
  binDir: string;
}

const boxes: string[] = [];

afterEach(() => {
  for (const directory of boxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stub(binDir: string, name: string, body: string): void {
  writeFileSync(join(binDir, name), body);
  chmodSync(join(binDir, name), 0o755);
}

function makeTermBox(): TermBox {
  const stateDir = mkdtempSync(join(tmpdir(), "term-creds-"));
  boxes.push(stateDir);
  const binDir = join(stateDir, "stub-bin");
  mkdirSync(binDir);
  stub(binDir, "tmux", TMUX_STUB);
  stub(binDir, "timeout", TIMEOUT_STUB);
  // Logs its argv. blitz-term must never call it: an agent asks for a
  // credential itself, and a tab that pulled one would put a secret in the
  // tmux session environment where it outlives its grant.
  stub(
    binDir,
    "blitz-cred",
    `#!/bin/sh\nprintf '%s\\n' "$*" >>'${join(stateDir, "cred-calls")}'\n`,
  );
  return { stateDir, binDir };
}

function runTerm(box: TermBox, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("bash", [blitzTermPath, ...args], {
      env: {
        ...process.env,
        PATH: `${box.binDir}:${process.env.PATH ?? ""}`,
        BLITZ_STATE_DIR: box.stateDir,
        TMUX_STUB_STATE: box.stateDir,
        // Exactly what the ttyd service hands blitz-term on a real box
        // (rootfs/etc/s6-overlay/s6-rc.d/ttyd/run), so the locale assertions
        // do not follow whichever locale the developer's shell happens to use.
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      stdio: "ignore",
    });
    child.on("close", resolve);
  });
}

function deliveredEnv(box: TermBox, verb: "new-session" | "attach-session"): Record<string, string> {
  const lines = readFileSync(join(box.stateDir, `${verb}-env`), "utf8").trim().split("\n");
  return Object.fromEntries(lines.map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}

function deliveredArgv(box: TermBox, verb: "new-session" | "attach-session"): string[] {
  return readFileSync(join(box.stateDir, `${verb}-argv`), "utf8")
    .split("\0")
    .filter((argument) => argument !== "");
}

/** The `NAME=VALUE` payload of every tmux `-e` flag, in order. */
function sessionEnvFlags(argv: string[]): string[] {
  const flags: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === "-e") flags.push(argv[at + 1] ?? "");
  }
  return flags;
}

function credCalls(box: TermBox): string[] {
  const path = join(box.stateDir, "cred-calls");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

describe("blitz-term carries no credential", () => {
  it("starts a tab with no secret in the tmux session environment", async () => {
    const box = makeTermBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    const delivered = deliveredEnv(box, "new-session");
    expect(delivered.GH_TOKEN).toBe("<unset>");
    expect(delivered.PROJECT_MODE).toBe("<unset>");
    // Pulling one here would put it in a session environment that outlives the
    // grant. The agent asks for its own when it needs one.
    expect(credCalls(box)).toEqual([]);
  });

  it("ignores a creds/env.d left behind by an older box image", async () => {
    // The broker no longer writes this directory, but a box that boots on an
    // upgraded image still has yesterday's file on its state volume. Sourcing
    // it would re-export a value the workspace may already have revoked.
    const box = makeTermBox();
    const envDir = join(box.stateDir, "creds", "env.d");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "00-workspace.sh"), "export PROJECT_MODE='analysis'\n");
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(deliveredEnv(box, "new-session").PROJECT_MODE).toBe("<unset>");
  });
});

describe("blitz-term tmux session environment", () => {
  it("names the locale pair in tmux -e flags, and nothing else", async () => {
    const box = makeTermBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    // A tmux server hands later sessions its own startup snapshot rather than
    // the creating client's environment, and the box's first session is a
    // detached blitz-rc started from a bare `docker exec` with no LANG. So the
    // tab has to state the locale rather than inherit it. PATH and
    // BLITZ_STATE_DIR are deliberately absent: restating them would let a
    // stale tab pin an old PATH.
    expect(sessionEnvFlags(deliveredArgv(box, "new-session")))
      .toEqual(["LANG=C.UTF-8", "LC_ALL=C.UTF-8"]);
  });

  it("passes no -e on the read-only attach path", async () => {
    const box = makeTermBox();
    writeFileSync(join(box.stateDir, "session-claude-obs"), "");
    expect(await runTerm(box, ["claude", "obs", "ro"])).toBe(0);
    // `-e` applies on create only, and an observer never creates.
    expect(sessionEnvFlags(deliveredArgv(box, "attach-session"))).toEqual([]);
  });

  it("still refuses a fourth argument", async () => {
    // The gateway's read-only rewrite (box/gateway/main.go
    // forceReadOnlyTerminalArgs) appends "ro" only to a two-argument request
    // and refuses any other shape. The -e flags are tmux argv, never
    // blitz-term argv, so that contract must stay exactly `<type> <key> [ro]`.
    const box = makeTermBox();
    expect(await runTerm(box, ["claude", "run", "ro", "extra"])).toBe(2);
  });
});

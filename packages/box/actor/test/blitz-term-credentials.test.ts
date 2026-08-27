import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * blitz-term hands a tab's environment to tmux, which execs the agent without
 * a login shell — so whatever this script does not source, the agent does not
 * have. It used to source only `00-workspace.sh` and step over the credential
 * files beside it, which left a claude tab unable to read the very token its
 * workspace had connected. These drive the real script with stub tmux,
 * blitz-cred and timeout binaries, because the failures that matter here are
 * runtime ones `bash -n` cannot see: an unsourced glob, or a `set -e` abort
 * that takes the terminal down with it.
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
  envDir: string;
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
  const envDir = join(stateDir, "creds", "env.d");
  mkdirSync(envDir, { recursive: true });
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
  return { stateDir, envDir, binDir };
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

function writeEnvFile(box: TermBox, file: string, body: string): void {
  writeFileSync(join(box.envDir, file), body);
}

/** A box whose workspace declares variables. Only the workspace entry lives in
 * env.d now: connection secrets are pulled at the moment of use. */
function configuredBox(): TermBox {
  const box = makeTermBox();
  writeEnvFile(box, "00-workspace.sh", "export PROJECT_MODE='analysis'\nexport REGION='eu'\n");
  return box;
}

describe("blitz-term credential delivery", () => {
  it("gives an agent tab the whole env.d glob", async () => {
    const box = configuredBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(deliveredEnv(box, "new-session")).toMatchObject({
      PROJECT_MODE: "analysis",
      REGION: "eu",
    });
  });

  it("gives a plain terminal tab the same environment", async () => {
    const box = configuredBox();
    expect(await runTerm(box, ["terminal", "shell"])).toBe(0);
    expect(deliveredEnv(box, "new-session").PROJECT_MODE).toBe("analysis");
  });

  it("carries no connection secret into the tmux session", async () => {
    // A tab used to inherit every connected provider's token, and a tmux
    // session environment outlives the grant that authorized it. An agent now
    // asks for a credential when it needs one.
    const box = configuredBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(deliveredEnv(box, "new-session").GH_TOKEN).toBe("<unset>");
    expect(credCalls(box)).toEqual([]);
  });

  it("starts the tab anyway when an entry cannot be read", async () => {
    const box = configuredBox();
    // env.d entries are mode 0600 and a stripped or half-migrated box can leave
    // one unreadable. Under `set -euo pipefail` a careless source here would
    // take the whole terminal down instead of one variable.
    writeEnvFile(box, "mm-locked.sh", "export LOCKED='x'\n");
    chmodSync(join(box.envDir, "mm-locked.sh"), 0o000);
    try {
      expect(await runTerm(box, ["claude", "run"])).toBe(0);
      expect(deliveredEnv(box, "new-session").PROJECT_MODE).toBe("analysis");
    } finally {
      chmodSync(join(box.envDir, "mm-locked.sh"), 0o600);
    }
  });

  it("starts the tab when the workspace declares nothing", async () => {
    const box = makeTermBox();
    rmSync(join(box.stateDir, "creds"), { recursive: true, force: true });
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(deliveredEnv(box, "new-session").PROJECT_MODE).toBe("<unset>");
  });
});

describe("blitz-term tmux session environment", () => {
  it("names every sourced variable in a tmux -e flag", async () => {
    const box = configuredBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    const flags = sessionEnvFlags(deliveredArgv(box, "new-session"));
    // Exporting alone reaches the agent only when this client also starts the
    // tmux server. Bootstrap's blitz-rc session usually starts it first, so
    // the tab has to state its environment rather than inherit it.
    expect(flags).toContain("PROJECT_MODE=analysis");
    expect(flags).toContain("REGION=eu");
    expect(flags).toContain("LANG=C.UTF-8");
    expect(flags).toContain("LC_ALL=C.UTF-8");
  });

  it("names only what env.d changed, not the whole inherited environment", async () => {
    // PATH and BLITZ_STATE_DIR reach blitz-term from ttyd, unchanged by the
    // glob. Restating them would let a stale tab pin an old PATH.
    const box = configuredBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    const names = sessionEnvFlags(deliveredArgv(box, "new-session"))
      .map((flag) => flag.slice(0, flag.indexOf("=")));
    expect(names).not.toContain("PATH");
    expect(names).not.toContain("BLITZ_STATE_DIR");
  });

  it("passes no -e on the read-only attach path", async () => {
    const box = configuredBox();
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
    const box = configuredBox();
    expect(await runTerm(box, ["claude", "run", "ro", "extra"])).toBe(2);
  });
});


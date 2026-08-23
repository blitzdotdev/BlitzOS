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
      "RETRACTED=\${RETRACTED-<unset>}" >"$TMUX_STUB_STATE/$verb-env"
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
  // Logs its argv so the create-path-only rule is observable, and writes an
  // env.d entry so "the sync ran before the sourcing" is observable too.
  stub(
    binDir,
    "blitz-cred",
    `#!/bin/sh\nprintf '%s\\n' "$*" >>'${join(stateDir, "cred-calls")}'\n`
      + `printf "export SYNCED='yes'\\n" >'${join(envDir, "zz-synced.sh")}'\n`,
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

function credCalls(box: TermBox): string[] {
  const path = join(box.stateDir, "cred-calls");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

function writeEnvFile(box: TermBox, file: string, body: string): void {
  writeFileSync(join(box.envDir, file), body);
}

function connectedBox(): TermBox {
  const box = makeTermBox();
  writeEnvFile(box, "00-workspace.sh", "export PROJECT_MODE='analysis'\nexport GH_TOKEN='workspace-guess'\n");
  writeEnvFile(box, "github.sh", "export GH_TOKEN='ghs_minted'\n");
  return box;
}

describe("blitz-term credential delivery", () => {
  it("gives an agent tab the whole env.d glob, later files winning", async () => {
    const box = connectedBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(deliveredEnv(box, "new-session")).toMatchObject({
      // The bug this closes: without the glob this read `workspace-guess`, the
      // placeholder the member typed, never the credential the broker minted.
      GH_TOKEN: "ghs_minted",
      PROJECT_MODE: "analysis",
    });
  });

  it("gives a plain terminal tab the same environment", async () => {
    const box = connectedBox();
    expect(await runTerm(box, ["terminal", "shell"])).toBe(0);
    expect(deliveredEnv(box, "new-session").GH_TOKEN).toBe("ghs_minted");
  });

  it("honours an unset tombstone the same way the login shell does", async () => {
    const box = makeTermBox();
    writeEnvFile(box, "00-workspace.sh", "export RETRACTED='stale'\n");
    writeEnvFile(box, "github.sh", "unset RETRACTED\n");
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(deliveredEnv(box, "new-session").RETRACTED).toBe("<unset>");
  });

  it("starts the tab anyway when an entry cannot be read", async () => {
    const box = connectedBox();
    // env.d entries are mode 0600 and a stripped or half-migrated box can leave
    // one unreadable. Under `set -euo pipefail` a careless source here would
    // take the whole terminal down instead of one variable.
    writeEnvFile(box, "mm-locked.sh", "export LOCKED='x'\n");
    chmodSync(join(box.envDir, "mm-locked.sh"), 0o000);
    try {
      expect(await runTerm(box, ["claude", "run"])).toBe(0);
      expect(deliveredEnv(box, "new-session").GH_TOKEN).toBe("ghs_minted");
    } finally {
      chmodSync(join(box.envDir, "mm-locked.sh"), 0o600);
    }
  });

  it("starts the tab when nothing is connected at all", async () => {
    const box = makeTermBox();
    rmSync(join(box.stateDir, "creds"), { recursive: true, force: true });
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(deliveredEnv(box, "new-session").GH_TOKEN).toBe("<unset>");
  });
});

describe("blitz-term pre-session credential sync", () => {
  it("syncs before sourcing, so a first tab sees what the sync just wrote", async () => {
    const box = makeTermBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(credCalls(box)).toEqual(["sync"]);
    // Skills ride the same mint, and the harness scans them once at startup;
    // this variable standing in for them proves the ordering.
    expect(existsSync(join(box.envDir, "zz-synced.sh"))).toBe(true);
  });

  it("never syncs for a plain terminal tab", async () => {
    const box = connectedBox();
    expect(await runTerm(box, ["terminal", "shell"])).toBe(0);
    expect(credCalls(box)).toEqual([]);
  });

  it("never syncs when re-attaching to a live agent session", async () => {
    const box = connectedBox();
    // The harness in there scanned its skills when it started; a sync now buys
    // that session nothing and would stall every single reconnect.
    writeFileSync(join(box.stateDir, "session-claude-run"), "");
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(credCalls(box)).toEqual([]);
  });

  it("never syncs on the read-only observer path", async () => {
    const box = connectedBox();
    writeFileSync(join(box.stateDir, "session-claude-obs"), "");
    expect(await runTerm(box, ["claude", "obs", "ro"])).toBe(0);
    expect(credCalls(box)).toEqual([]);
  });
});

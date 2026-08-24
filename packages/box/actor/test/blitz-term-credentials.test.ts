import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  // Logs its argv, so the create-path-only rule stays observable. It writes
  // nothing into env.d: the sync now runs detached, so a stub that raced the
  // sourcing loop would only make these tests flaky.
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

describe("blitz-term tmux session environment", () => {
  it("names every sourced variable in a tmux -e flag", async () => {
    const box = connectedBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    const flags = sessionEnvFlags(deliveredArgv(box, "new-session"));
    // Exporting alone reaches the agent only when this client also starts the
    // tmux server. Bootstrap's blitz-rc session usually starts it first, so
    // the tab has to state its environment rather than inherit it.
    expect(flags).toContain("GH_TOKEN=ghs_minted");
    expect(flags).toContain("PROJECT_MODE=analysis");
    expect(flags).toContain("LANG=C.UTF-8");
    expect(flags).toContain("LC_ALL=C.UTF-8");
  });

  it("names only what env.d changed, not the whole inherited environment", async () => {
    // PATH and BLITZ_STATE_DIR reach blitz-term from ttyd, unchanged by the
    // glob. Restating them would let a stale tab pin an old PATH.
    const box = connectedBox();
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    const names = sessionEnvFlags(deliveredArgv(box, "new-session"))
      .map((flag) => flag.slice(0, flag.indexOf("=")));
    expect(names).not.toContain("PATH");
    expect(names).not.toContain("BLITZ_STATE_DIR");
  });

  it("passes no -e on the read-only attach path", async () => {
    const box = connectedBox();
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
    const box = connectedBox();
    expect(await runTerm(box, ["claude", "run", "ro", "extra"])).toBe(2);
  });
});

const tmuxBinary = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" })
  .stdout.trim();

/** Real tmux, because the bug was tmux's own inheritance rule and no stub can
 * pin it: a tmux server keeps the environment of the client that started it,
 * and hands that snapshot — not the creating client's — to every session
 * opened afterwards. */
describe.skipIf(tmuxBinary === "")("blitz-term against a foreign tmux server", () => {
  it("reaches a tab whose server was started by somebody else", async () => {
    const root = mkdtempSync(join(tmpdir(), "term-tmux-"));
    boxes.push(root);
    const socketDir = join(root, "s");
    const stateDir = join(root, "state");
    const envDir = join(stateDir, "creds", "env.d");
    const binDir = join(root, "bin");
    const outDir = join(root, "out");
    for (const directory of [socketDir, envDir, binDir, outDir]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(envDir, "00-workspace.sh"), "export PROJECT_MODE='analysis'\n");
    writeFileSync(join(envDir, "github.sh"), "export GH_TOKEN='ghs_minted'\n");
    // Stands in for the agent: whatever tmux execs is the only witness that
    // matters, so it writes its own environment down and stays alive.
    stub(
      binDir,
      "claude",
      "#!/bin/sh\n"
        + `{ printenv GH_TOKEN || echo '<unset>'; } >'${join(outDir, "gh")}'\n`
        + `{ printenv PROJECT_MODE || echo '<unset>'; } >'${join(outDir, "mode")}'\n`
        + `{ printenv LANG || echo '<unset>'; } >'${join(outDir, "lang")}'\n`
        + "sleep 30\n",
    );

    const tmuxDir = dirname(tmuxBinary);
    const clientEnv = { ...process.env, TMUX_TMPDIR: socketDir };
    // The foreign server first, holding a bare environment: no credential, no
    // locale. This is bootstrap's blitz-rc `docker exec` in miniature.
    spawnSync("env", [
      "-i",
      `PATH=${tmuxDir}:/usr/bin:/bin`,
      `HOME=${root}`,
      `TMUX_TMPDIR=${socketDir}`,
      "tmux", "new-session", "-d", "-s", "foreign", "sleep", "120",
    ]);
    try {
      // blitz-term runs in a pane on that same server, so it gets a real tty
      // and its `new-session -A` can attach. `env -u TMUX` keeps tmux from
      // refusing the nested session.
      spawnSync("tmux", [
        "new-session", "-d", "-s", "driver", "-c", root,
        `TMUX_TMPDIR=${socketDir} BLITZ_STATE_DIR=${stateDir}`
          + ` PATH=${binDir}:${tmuxDir}:/usr/bin:/bin`
          + ` env -u TMUX bash ${blitzTermPath} claude probe >${join(outDir, "log")} 2>&1`,
      ], { env: clientEnv });

      for (let attempt = 0; attempt < 100 && !existsSync(join(outDir, "lang")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const observed = (name: string) => readFileSync(join(outDir, name), "utf8").trim();
      // Without the -e flags all three read `<unset>`: the agent inherits the
      // foreign server's snapshot instead of the tab's own environment.
      expect(observed("gh")).toBe("ghs_minted");
      expect(observed("mode")).toBe("analysis");
      expect(observed("lang")).toBe("C.UTF-8");
    } finally {
      spawnSync("tmux", ["kill-server"], { env: clientEnv });
    }
  });
});

describe("blitz-term pre-session credential sync", () => {
  it("starts the sync without waiting for it", async () => {
    const box = makeTermBox();
    // The mint holds ONE sync lock and the gateway's POST /credentials/sync
    // may hold it for 30 seconds, so a tab that waited here waited on
    // somebody else's refresh. This stub blocks until the test releases it:
    // if blitz-term still waited, the run would never return.
    const gate = join(box.stateDir, "sync-gate");
    stub(
      box.binDir,
      "blitz-cred",
      "#!/bin/sh\n"
        + `until [ -e '${gate}' ]; do sleep 0.05; done\n`
        + `printf '%s\\n' "$*" >>'${join(box.stateDir, "cred-calls")}'\n`,
    );
    expect(await runTerm(box, ["claude", "run"])).toBe(0);
    expect(credCalls(box)).toEqual([]);

    // Skills ride the same mint and still land within seconds, racing the
    // harness scan exactly as they did before the sync moved in front of it.
    writeFileSync(gate, "");
    for (let attempt = 0; attempt < 100 && credCalls(box).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(credCalls(box)).toEqual(["sync"]);
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

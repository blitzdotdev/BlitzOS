import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * THE TAB CLOSE, PINNED (QA sweep TABS-1).
 *
 * A tmux session outlives its ttyd socket on purpose: that is what makes a
 * reload, a navigation and a dropped tunnel re-attach to the scrollback they
 * left (plans/LODY-TERMINAL-TABS.md §4.4). Nothing on the box ended one, so a
 * closed terminal tab left `term-<id>` running for good, one leaked shell or
 * agent per close.
 *
 * `kill` is the mode that ends it, and an explicit tab close is its only
 * caller. These drive the real script with a stub tmux, because what matters is
 * which tmux verb runs against which target.
 */

const blitzTermPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-term", import.meta.url),
);

/** Records the argv of every tmux verb, and answers `has-session` and
 * `kill-session` from the session files a case laid down — so "no such
 * session" is a case this suite can write, which is the one a close races. */
const TMUX_STUB = `#!/usr/bin/env bash
set -eu
verb="" target="" prev=""
for arg in "$@"; do
  case "$prev" in
    -t|-s) target=\${arg#=} ;;
  esac
  case "$arg" in
    has-session|new-session|attach-session|kill-session) verb=$arg ;;
  esac
  prev=$arg
done
printf '%s\\0' "$@" >>"$TMUX_STUB_STATE/$verb-argv"
case "$verb" in
  has-session|kill-session)
    [ -e "$TMUX_STUB_STATE/session-$target" ]
    ;;
esac
`;

interface TermBox {
  stateDir: string;
  binDir: string;
}

const boxes: string[] = [];

afterEach(() => {
  for (const directory of boxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeTermBox(): TermBox {
  const stateDir = mkdtempSync(join(tmpdir(), "term-close-"));
  boxes.push(stateDir);
  const binDir = join(stateDir, "stub-bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "tmux"), TMUX_STUB);
  chmodSync(join(binDir, "tmux"), 0o755);
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
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      stdio: "ignore",
    });
    child.on("close", resolve);
  });
}

/** The argv of one tmux verb, or `null` when that verb never ran. */
function verbArgv(box: TermBox, verb: string): string[] | null {
  const path = join(box.stateDir, `${verb}-argv`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").split("\0").filter((argument) => argument !== "");
}

describe("blitz-term kill", () => {
  it("ends the one session the tab named", async () => {
    const box = makeTermBox();
    writeFileSync(join(box.stateDir, "session-term-70"), "");
    expect(await runTerm(box, ["terminal", "70", "kill"])).toBe(0);
    // `=` is the exact-name match: without it tmux would take `term-7` as a
    // prefix of `term-70` and end a tab nobody closed.
    expect(verbArgv(box, "kill-session")).toEqual(["kill-session", "-t", "=term-70"]);
  });

  it("names the session by the same rule an attach does", async () => {
    // The session type decides the prefix, and one script owns that mapping.
    const box = makeTermBox();
    expect(await runTerm(box, ["claude", "9", "kill"])).toBe(0);
    expect(verbArgv(box, "kill-session")).toEqual(["kill-session", "-t", "=claude-9"]);
  });

  it("never creates or attaches anything on its way out", async () => {
    // A close that created the session it is closing would resurrect the tab
    // the member just dismissed, and `new-session -A` creates by default.
    const box = makeTermBox();
    expect(await runTerm(box, ["terminal", "70", "kill"])).toBe(0);
    expect(verbArgv(box, "new-session")).toBeNull();
    expect(verbArgv(box, "attach-session")).toBeNull();
  });

  it("succeeds when the session is already gone", async () => {
    // No session file, so the stub answers the way tmux answers "can't find
    // session". The tab is gone either way, so a close never fails.
    const box = makeTermBox();
    expect(await runTerm(box, ["terminal", "70", "kill"])).toBe(0);
  });

  it("leaves the session alone on every other path", async () => {
    // A reload, a navigation and a lost tunnel all arrive as a plain rw
    // connection, and a read-only observer arrives as `ro`. Neither may end a
    // session: re-attach is the normal path, not a recovery path.
    const attach = makeTermBox();
    expect(await runTerm(attach, ["terminal", "70"])).toBe(0);
    expect(verbArgv(attach, "kill-session")).toBeNull();
    expect(verbArgv(attach, "new-session")?.slice(0, 5))
      .toEqual(["-u", "new-session", "-A", "-s", "term-70"]);

    const observer = makeTermBox();
    writeFileSync(join(observer.stateDir, "session-term-70"), "");
    expect(await runTerm(observer, ["terminal", "70", "ro"])).toBe(0);
    expect(verbArgv(observer, "kill-session")).toBeNull();
  });

  it("still refuses a mode it does not know", async () => {
    const box = makeTermBox();
    expect(await runTerm(box, ["terminal", "70", "destroy"])).toBe(2);
    expect(verbArgv(box, "kill-session")).toBeNull();
  });
});

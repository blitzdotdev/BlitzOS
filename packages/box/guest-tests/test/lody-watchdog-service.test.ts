import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Pins the Lody daemon watchdog. The first rules are the shape of the canary
 * failure of 2026-09-01: the daemon hung without exiting, s6 saw a live
 * longrun, `blitz-healthcheck` saw a live gateway, the browser's `/platform`
 * probe read a file off disk and said `present`, and the member watched
 * "Starting sessions on this workspace…" until someone rebooted the server by
 * hand.
 *
 * The behavioural rules are the shape of the canary failure of 2026-09-03:
 * the daemon answered its probe the whole time, but the box was thrashing
 * under an agent session's test run, so the browser's deadline-less boot sync
 * never completed and the member read the same sentence for hours. They run
 * the real script against a fake cgroup tree and a real probe socket. */

const serviceDirectory = new URL(
  "../../rootfs/etc/s6-overlay/s6-rc.d/lody-watchdog/",
  import.meta.url,
);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, serviceDirectory)), "utf8");
}

const runPath = fileURLToPath(new URL("run", serviceDirectory));
const runScript = read("run");

/** The run script explains each rule in a comment, so a naive match on the
 * whole file finds the prose rather than the command. Absence claims are made
 * against the executable lines only. */
const runCode = runScript
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("lody-watchdog s6 service", () => {
  it("is a longrun registered in the user bundle, after the daemon", () => {
    expect(read("type").trim()).toBe("longrun");
    // Probing a daemon s6 has not been asked to start yet only burns misses.
    expect(read("dependencies.d/lody-daemon")).toBeDefined();
    const bundleEntry = fileURLToPath(
      new URL("../user/contents.d/lody-watchdog", serviceDirectory),
    );
    // An unregistered service never starts, and nothing else would say so.
    expect(statSync(bundleEntry).isFile()).toBe(true);
  });

  it("probes the daemon's own socket, not the bridge's forwarded door", () => {
    // The bridge forwards `/healthz` to this same socket, so probing through it
    // would let a hung BRIDGE be reported as a hung DAEMON and restart the
    // wrong process. The path is derived exactly as blitz-lody-bridge derives
    // it, so a namespace change breaks both together.
    expect(runCode).toMatch(/lody-oss-probe\.sock/u);
    expect(runCode).toMatch(/--unix-socket/u);
    expect(runCode).not.toMatch(/lody-bridge\.sock/u);
  });

  it("bounds the read, because the failure answers the connect", () => {
    // A wedged daemon accepts the connection and then never replies. A connect
    // check passes against it; only a bounded read tells the two apart.
    expect(runCode).toMatch(/--max-time \d+/u);
    expect(runCode).toMatch(/--fail/u);
  });

  it("restarts the daemon and nothing else", () => {
    expect(runCode).toMatch(/s6-svc -r \/run\/service\/lody-daemon/u);
    for (const neighbour of ["lody-bridge", "lody-projects", "gateway"]) {
      expect(runCode).not.toMatch(new RegExp(`/run/service/${neighbour}`, "u"));
    }
  });

  it("escalates a restart the daemon cannot act on", () => {
    // A blocked event loop cannot run the SIGTERM handler `s6-svc -r` relies
    // on, and s6 only escalates by itself for `-d` with a `timeout-kill` file.
    // Twelve hours of an unanswered restart on 2026-09-04 is the reason: the
    // pid is compared before and after, and an unchanged pid gets SIGKILL.
    expect(runCode).toMatch(/s6-svstat -o pid \/run\/service\/lody-daemon/u);
    expect(runCode).toMatch(/s6-svc -k \/run\/service\/lody-daemon/u);
    expect(runCode).toMatch(/BLITZ_WATCHDOG_KILL_GRACE:-([1-9]\d|\d{3,})/u);
  });

  it("never takes the box down with it", () => {
    // A dead sessions surface costs sessions. It must not cost the member their
    // tunnel, their terminal or their files — so no `set -e`, and the restart
    // cannot propagate a failure.
    expect(runCode).not.toMatch(/set -e(?![a-z])/u);
    expect(runCode).toMatch(/s6-svc -r [^\n]*\|\| true/u);
  });

  it("tolerates one slow answer and waits out its own action", () => {
    // Restarting on a single miss costs every open session on the box for what
    // may be a moment of load; restarting again before `lody start` has opened
    // its sockets only moves the box further from a working daemon. The same
    // hold follows a kill, because `avg60` needs a minute to forget the
    // pressure the kill relieved.
    expect(runCode).toMatch(/misses_before_restart=([3-9]|\d{2,})/u);
    expect(runCode).toMatch(/pressure_ticks_before_kill=([3-9]|\d{2,})/u);
    expect(runCode).toMatch(/BLITZ_WATCHDOG_HOLD:-120/u);
  });

  it("kills only a session leaf, never the daemon's own cgroup", () => {
    // `cgroup.kill` on lody.scope would be the restart by another name, and
    // one on the user slice would take the member's terminals too.
    const kills = runCode.match(/[^\n]*cgroup\.kill[^\n]*/gu) ?? [];
    expect(kills.length).toBeGreaterThan(0);
    for (const line of kills) expect(line).toMatch(/\$leaf\/cgroup\.kill/u);
    expect(runCode).toMatch(/sessions_dir="\$user_slice\/lody-sessions"/u);
    expect(runCode).toMatch(/"\$sessions_dir"\/lody-session-\*/u);
  });

  it("idles when the sessions feature is dark", () => {
    // Same gate lody-daemon carries. `sleep infinity` rather than exit: s6
    // restarts a longrun the moment its run script returns.
    expect(runCode).toMatch(/BLITZ_LODY_SESSIONS/u);
    expect(runCode).toMatch(/exec sleep infinity/u);
  });
});

/** One session leaf as the fake cgroup tree carries it. `cgroup.kill` is
 * write-only on cgroupfs; here it is a plain file the script writes into, so
 * the test can read back which leaf was killed. */
interface Leaf {
  id: string;
  currentBytes: number;
}

interface Box {
  stateDir: string;
  cgroupRoot: string;
  sessionsDir: string;
}

function makeBox(options: { fullAvg60: number | null; leaves: Leaf[] }): Box {
  const root = mkdtempSync(join(tmpdir(), "wd-"));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "lody", "run"), { recursive: true });
  const cgroupRoot = join(root, "cg");
  const userSlice = join(cgroupRoot, "blitz-user.slice");
  const sessionsDir = join(userSlice, "lody-sessions");
  mkdirSync(sessionsDir, { recursive: true });
  if (options.fullAvg60 !== null) {
    // The kernel's own format, both lines, so the parser is exercised against
    // the line it must skip as well as the one it reads.
    writeFileSync(
      join(userSlice, "memory.pressure"),
      `some avg10=61.02 avg60=${(options.fullAvg60 + 30).toFixed(2)} avg300=20.11 total=7188313\n` +
        `full avg10=44.90 avg60=${options.fullAvg60.toFixed(2)} avg300=12.00 total=5090187\n`,
    );
  }
  for (const leaf of options.leaves) {
    const dir = join(sessionsDir, `lody-session-${leaf.id}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "memory.current"), `${leaf.currentBytes}\n`);
    writeFileSync(join(dir, "cgroup.kill"), "0\n");
  }
  return { stateDir, cgroupRoot, sessionsDir };
}

function killed(box: Box, id: string): boolean {
  return readFileSync(join(box.sessionsDir, `lody-session-${id}`, "cgroup.kill"), "utf8") === "1\n";
}

const servers: Server[] = [];

/** A stand-in daemon that answers its probe at once: every behavioural case
 * below is about a daemon that is healthy by the probe's lights. */
function listenProbe(box: Box): Promise<void> {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404);
    res.end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(join(box.stateDir, "lody", "run", "lody-oss-probe.sock"), () => resolve());
  });
}

interface RunResult {
  status: number | null;
  stdout: string;
}

function runTicks(box: Box, ticks: number, intervalSeconds = 0): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", [runPath], {
      env: {
        ...process.env,
        BLITZ_LODY_SESSIONS: "1",
        BLITZ_STATE_DIR: box.stateDir,
        BLITZ_WATCHDOG_CGROUP_ROOT: box.cgroupRoot,
        BLITZ_WATCHDOG_INTERVAL: String(intervalSeconds),
        BLITZ_WATCHDOG_HOLD: "0",
        BLITZ_WATCHDOG_TICKS: String(ticks),
      },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("close", (status) => resolve({ status, stdout: stdout.trim() }));
  });
}

const MiB = 1024 * 1024;

describe("lody-watchdog under memory pressure", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  it("kills the heaviest session leaf after three ticks of pressure, and only that one", async () => {
    const box = makeBox({
      fullAvg60: 45,
      leaves: [
        { id: "idle", currentBytes: 270 * MiB },
        { id: "tests", currentBytes: 2900 * MiB },
        { id: "build", currentBytes: 1100 * MiB },
      ],
    });
    await listenProbe(box);
    const result = await runTicks(box, 3);
    expect(result.status).toBe(0);
    expect(killed(box, "tests")).toBe(true);
    expect(killed(box, "build")).toBe(false);
    expect(killed(box, "idle")).toBe(false);
    // The one line the next investigation reads: which session, and how much.
    expect(result.stdout).toMatch(/killed session tests holding 2900 MiB/u);
  });

  it("leaves every session alone while the pressure has not lasted", async () => {
    // Two ticks is the shape of a build's peak, not a thrash.
    const box = makeBox({ fullAvg60: 45, leaves: [{ id: "tests", currentBytes: 2900 * MiB }] });
    await listenProbe(box);
    const result = await runTicks(box, 2);
    expect(result.status).toBe(0);
    expect(killed(box, "tests")).toBe(false);
    expect(result.stdout).toMatch(/full avg60=45% \(2\/3\)/u);
  });

  it("starts the count over when the pressure lifts between ticks", async () => {
    const box = makeBox({ fullAvg60: 45, leaves: [{ id: "tests", currentBytes: 2900 * MiB }] });
    await listenProbe(box);
    // One process, five ticks a second apart. The file reads calm between the
    // second and third reads and is under pressure again by the fourth, so no
    // three consecutive ticks agree and nothing is killed. Half a second of
    // margin on each rewrite keeps a loaded test box from moving the reads.
    const pressureFile = join(box.cgroupRoot, "blitz-user.slice", "memory.pressure");
    const under = readFileSync(pressureFile, "utf8");
    const calm = under.replace(/full avg10=[^\n]*/u, "full avg10=0.00 avg60=0.00 avg300=0.00 total=0");
    const rewrites = [
      new Promise<void>((resolve) => setTimeout(() => { writeFileSync(pressureFile, calm); resolve(); }, 2_500)),
      new Promise<void>((resolve) => setTimeout(() => { writeFileSync(pressureFile, under); resolve(); }, 3_500)),
    ];
    const [result] = await Promise.all([runTicks(box, 5, 1), ...rewrites]);
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "lody-watchdog: memory pressure full avg60=45% (1/3)",
      "lody-watchdog: memory pressure full avg60=45% (2/3)",
      "lody-watchdog: memory pressure full avg60=45% (1/3)",
      "lody-watchdog: memory pressure full avg60=45% (2/3)",
    ]);
    expect(killed(box, "tests")).toBe(false);
  }, 15_000);

  it("does not kill a session that is not the weight", async () => {
    // Pressure with only light sessions means a terminal tab or an inner
    // container is the hog. Those belong to the boundary's memory.max, not to
    // this service.
    const box = makeBox({
      fullAvg60: 60,
      leaves: [
        { id: "a", currentBytes: 200 * MiB },
        { id: "b", currentBytes: 300 * MiB },
      ],
    });
    await listenProbe(box);
    const result = await runTicks(box, 3);
    expect(result.status).toBe(0);
    expect(killed(box, "a")).toBe(false);
    expect(killed(box, "b")).toBe(false);
    expect(result.stdout).toMatch(/heaviest session b holds only 300 MiB/u);
  });

  it("reports pressure with no session to kill and takes no action", async () => {
    const box = makeBox({ fullAvg60: 60, leaves: [] });
    await listenProbe(box);
    const result = await runTicks(box, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/no agent session to kill/u);
  });

  it("is quiet on a calm box", async () => {
    const box = makeBox({ fullAvg60: 3, leaves: [{ id: "tests", currentBytes: 2900 * MiB }] });
    await listenProbe(box);
    const result = await runTicks(box, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(killed(box, "tests")).toBe(false);
  });

  it("falls back to the probe alone on a box with no pressure file", async () => {
    // A flat box (no delegated cgroups) has nothing under blitz-user.slice.
    // The signal is absent, not wrong, and nothing is killed on its account.
    const box = makeBox({ fullAvg60: null, leaves: [{ id: "tests", currentBytes: 2900 * MiB }] });
    await listenProbe(box);
    const result = await runTicks(box, 3);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(killed(box, "tests")).toBe(false);
  });
});

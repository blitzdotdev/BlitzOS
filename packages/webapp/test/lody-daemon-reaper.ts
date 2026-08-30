/**
 * Vitest `globalSetup`: kill any Lody daemon a previous run left behind.
 *
 * PHASE 4 BLOCKER 4, CLOSED. The harness keys its cross-file lock on the owner
 * PID being gone, so a vitest worker killed by the OOM reaper releases the LOCK
 * — but the daemon that worker spawned keeps running, and it keeps the local
 * installation profile's host lease on 127.0.0.1:17789. The next run's daemon
 * then waits 60 s for a lease it cannot have and the harness reports a timeout.
 * Nothing IN-process can prevent that: SIGKILL runs no exit handler. What can
 * fix it is a pass BEFORE any worker starts, which is what this is.
 *
 * WHAT IT WILL KILL, AND ONLY THAT. Every harness daemon runs a COPY of the
 * bundle under its own `os.tmpdir()/lp-XXXXXX/lody/dist/index.js`
 * (`lody-daemon-harness.ts`), and its bridge runs the box's script with
 * `LODY_DATA_DIR` inside the same directory. Both are matched on that full
 * argument path. A daemon installed at `/opt/blitz/npm/...` — the box's own, and
 * a developer's own `lody start` — does not match and is never touched.
 *
 * It is best-effort throughout: `ps` may be absent, a pid may exit between the
 * listing and the signal, and neither is a reason to fail a test run.
 */
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The only path shape the harness ever spawns. */
const HARNESS_BUNDLE = join(tmpdir(), "lp-");

interface StrayProcess {
  pid: number;
  command: string;
}

function listProcesses(): StrayProcess[] {
  let listing: string;
  try {
    listing = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const strays: StrayProcess[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    // The daemon (`<tmp>/lp-XXXX/lody/dist/index.js`) and its bridge, whose
    // command line carries the same directory through LODY_DATA_DIR only if the
    // shell exported it — so the bridge is caught by its parent dying instead.
    if (command.includes(`${HARNESS_BUNDLE}`) && command.includes("/lody/dist/index.js")) {
      strays.push({ pid, command });
    }
  }
  return strays;
}

export default function reapOrphanedLodyDaemons(): void {
  for (const stray of listProcesses()) {
    try {
      process.kill(stray.pid, "SIGKILL");
      console.warn(`lody harness: killed an orphaned daemon (pid ${stray.pid})`);
    } catch {
      // Already gone, or not ours to signal. Either way the next harness start
      // reports the real problem with the hint it already carries.
    }
  }
}

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Pins the Lody daemon watchdog. Every rule below is the shape of the canary
 * failure of 2026-09-01: the daemon hung without exiting, s6 saw a live
 * longrun, `blitz-healthcheck` saw a live gateway, the browser's `/platform`
 * probe read a file off disk and said `present`, and the member watched
 * "Starting sessions on this workspace…" until someone rebooted the server by
 * hand. */

const serviceDirectory = new URL(
  "../../rootfs/etc/s6-overlay/s6-rc.d/lody-watchdog/",
  import.meta.url,
);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, serviceDirectory)), "utf8");
}

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

  it("never takes the box down with it", () => {
    // A dead sessions surface costs sessions. It must not cost the member their
    // tunnel, their terminal or their files — so no `set -e`, and the restart
    // cannot propagate a failure.
    expect(runCode).not.toMatch(/set -e(?![a-z])/u);
    expect(runCode).toMatch(/s6-svc -r [^\n]*\|\| true/u);
  });

  it("tolerates one slow answer and waits out its own restart", () => {
    // Restarting on a single miss costs every open session on the box for what
    // may be a moment of load; restarting again before `lody start` has opened
    // its sockets only moves the box further from a working daemon.
    expect(runCode).toMatch(/misses_before_restart=([3-9]|\d{2,})/u);
    expect(runCode).toMatch(/sleep 120/u);
  });

  it("idles when the sessions feature is dark", () => {
    // Same gate lody-daemon carries. `sleep infinity` rather than exit: s6
    // restarts a longrun the moment its run script returns.
    expect(runCode).toMatch(/BLITZ_LODY_SESSIONS/u);
    expect(runCode).toMatch(/exec sleep infinity/u);
  });
});

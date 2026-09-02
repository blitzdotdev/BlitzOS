import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The gate that keeps cloudflared off a dead tunnel.
 *
 * `/var/lib/blitz` is the member's persistent volume, so on a re-provision the
 * tunnel and webApp token files are already present -- written by the VM this
 * one replaced, naming a tunnel the control plane deleted on the way out. The
 * service used to wait only for those files to exist and be non-empty, which
 * on a reused volume is true immediately: cloudflared started before this
 * instance's cloud-init rewrote them (measured on a canary re-provision:
 * 23:11:27 against a token mtime of 23:11:34.8) and it reads `--token-file`
 * exactly once. The box then held a credential for a deleted tunnel until
 * something restarted it, the new tunnel sat at zero origins, and every
 * browser-facing surface answered Cloudflare 1033.
 *
 * So the wait is on `tokens-ready`, which only this instance's cloud-init
 * writes (`core/cloud-init.ts`) and which the bootstrap script removes before
 * the box container starts (`core/bootstrap.ts`).
 */
const runScript = fileURLToPath(
  new URL("../../rootfs/etc/s6-overlay/s6-rc.d/cloudflared/run", import.meta.url),
);

/** A state dir shaped like a reused volume: both tokens present, marker absent
 * unless the caller asks for one. */
function stateDir(withMarker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "cloudflared-gate-"));
  writeFileSync(join(dir, "tunnel-token"), "stale-tunnel-token\n");
  writeFileSync(join(dir, "webapp-token"), "webapp-token\n");
  if (withMarker) writeFileSync(join(dir, "tokens-ready"), "");
  return dir;
}

/** Runs the real script under bash. It never reaches a live cloudflared here --
 * `/usr/local/bin/blitz-cgroup` does not exist in the test image -- so leaving
 * the wait loop is observable as the process exiting. Still running means still
 * waiting, which is the whole assertion. */
function startGate(dir: string) {
  const child = spawn("bash", [runScript], {
    env: { ...process.env, BLITZ_STATE_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.on("exit", () => { exited = true; });
  return { child, hasExited: () => exited, output: () => stdout };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(gate: ReturnType<typeof startGate>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (gate.hasExited()) return true;
    await sleep(200);
  }
  return gate.hasExited();
}

describe("cloudflared tokens-ready gate", () => {
  it("waits while a reused volume's tokens carry no marker from this instance", async () => {
    const gate = startGate(stateDir(false));
    try {
      expect(await waitForExit(gate, 3_000)).toBe(false);
      expect(gate.output()).toContain("waiting for this instance's tunnel and webApp tokens");
    } finally {
      gate.child.kill("SIGKILL");
    }
  }, 20_000);

  it("proceeds once this instance's cloud-init writes the marker", async () => {
    const dir = stateDir(false);
    const gate = startGate(dir);
    try {
      expect(await waitForExit(gate, 2_000)).toBe(false);
      writeFileSync(join(dir, "tokens-ready"), "");
      expect(await waitForExit(gate, 15_000)).toBe(true);
    } finally {
      gate.child.kill("SIGKILL");
    }
  }, 30_000);

  it("does not wait when the marker is already beside the tokens (a plain reboot)", async () => {
    const gate = startGate(stateDir(true));
    try {
      expect(await waitForExit(gate, 10_000)).toBe(true);
      expect(gate.output()).not.toContain("waiting for");
    } finally {
      gate.child.kill("SIGKILL");
    }
  }, 20_000);
});

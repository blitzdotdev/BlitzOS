/**
 * MEASUREMENT, not a gate. Answers one question before any caching is written:
 * of the time a workspace switch costs, how much is the agent-config bootstrap
 * that `LodyAgentConfigGate` holds the whole surface behind?
 *
 * Run explicitly (the env gate keeps its ~75 s daemon boot out of `npm test`
 * on boxes that have the bundle):
 *   BLITZ_LODY_SWITCH_PROBE=1 npx vitest run test/lody-switch-cost.probe.test.tsx
 *
 * Measured 2026-09-02 on the box (daemon RTT ~0): cold 1456 ms, remount 751 ms,
 * remount with the bootstrap stubbed 774 ms — the gate's bootstrap is FREE
 * locally; its field cost is the serialized tunnel round trips, which is what
 * the gate memo in `agent-config-gate.tsx` removes on revisits.
 */
import "fake-indexeddb/auto";
import { act, type ReactNode } from "react";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import type { LodySessionSurfaceProps } from "../src/lody/SessionSurface";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { lodyDaemonAvailable, startLodyHarness } from "./lody-daemon-harness.js";
import { render, settle } from "./dom.js";

type Harness = Awaited<ReturnType<typeof startLodyHarness>>;
let harness: Harness | undefined;

const SHUT = "Starting sessions";

/** Mounts the real surface and returns ms until the gate opens. */
async function timeToGateOpen(mock: "real" | "stubbed"): Promise<number> {
  vi.resetModules();
  if (mock === "stubbed") {
    // Everything else identical; only the gating await is removed.
    vi.doMock("../src/lody/agent-configs.js", () => ({
      bootstrapLodyAgentConfigs: async () => [],
      refreshLodyAcpCapabilities: async () => undefined,
    }));
  }
  const { SessionSurface } = (await import("../src/lody/SessionSurface")) as {
    SessionSurface: (props: LodySessionSurfaceProps) => ReactNode;
  };
  const started = performance.now();
  const mounted = await render(
    <SessionSurface
      endpoints={{
        ...harness!.endpoints,
        webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
      }}
      viewer={{ name: "probe", avatarUrl: null }}
      workspaceTitle="probe"
    />,
  );
  let elapsed = -1;
  for (let i = 0; i < 600; i += 1) {
    const text = mounted.container.textContent ?? "";
    if (text !== "" && !text.includes(SHUT)) {
      elapsed = performance.now() - started;
      break;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  }
  await mounted.unmount();
  vi.doUnmock("../src/lody/agent-configs.js");
  return elapsed;
}

describe.skipIf(!lodyDaemonAvailable() || process.env["BLITZ_LODY_SWITCH_PROBE"] !== "1")(
  "what a workspace switch costs",
  () => {
  beforeAll(async () => {
    installLodyDomStubs();
    harness = await startLodyHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.stop();
  }, 60_000);

  it("attributes mount time to the gating bootstrap", async () => {
    const cold = await timeToGateOpen("real");
    await settle();
    const warm = await timeToGateOpen("real");
    await settle();
    const stubbed = await timeToGateOpen("stubbed");

    const report = [
      "",
      "=== SWITCH COST (ms to gate open) ===",
      `  cold mount, real bootstrap : ${cold.toFixed(0)}`,
      `  remount,    real bootstrap : ${warm.toFixed(0)}   <- what a switch costs`,
      `  remount,    no bootstrap   : ${stubbed.toFixed(0)}   <- floor if we memoize it`,
      `  attributable to bootstrap  : ${(warm - stubbed).toFixed(0)}`,
      "",
    ].join("\n");
    // Straight to stdout AND a file: the harness's console capture eats
    // `console.info`, and a measurement nobody can read measured nothing.
    process.stdout.write(`${report}\n`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/lody-switch-cost.json", JSON.stringify({ cold, warm, stubbed }));
  }, 300_000);
});

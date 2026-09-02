/**
 * Opt-in Phase C measurement: two real daemon identities, two retained full
 * renderer trees, and five A→B→A cycles.
 *
 *   BLITZ_LODY_SWITCH_PROBE=1 npx vitest run --maxWorkers=1 \
 *     test/lody-keepalive-activation.probe.test.tsx
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createStore } from "jotai";
import { act } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { bootstrapLodyAgentConfigs, BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { LodySurfacePool, type LodySurfacePoolTarget } from "../src/lody/LodySurfacePool.js";
import { lodyLiveDataPlaneSocketCount } from "../src/lody/data-plane-connection.js";
import { fetchLodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import {
  createLodyRuntime,
  mountLodyRuntimeAtoms,
  unmountLodyRuntimeAtoms,
} from "../src/lody/runtime.js";
import { startLodySession } from "../src/lody/session.js";
import { lodyLiveRepoCount } from "../src/lody/surface-runtime-stats.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import {
  HARNESS_BOOT_TIMEOUT_MS,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness.js";
import { render, settle } from "./dom.js";

interface MemorySample {
  rss: number;
  heapUsed: number;
  external: number;
  sockets: number;
  repos: number;
}

function memorySample(): MemorySample {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    sockets: lodyLiveDataPlaneSocketCount(),
    repos: lodyLiveRepoCount(),
  };
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? -1;
}

function targetFor(harness: LodyHarness, title: string): LodySurfacePoolTarget {
  return {
    kind: "owned",
    endpoints: {
      ...harness.endpoints,
      // SAFETY: ws implements the handler properties, readyState, send and
      // close used by the browser transport; only unrelated DOM members differ.
      webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
    },
    workspaceTitle: title,
    readOnly: false,
    desiredSessionId: null,
    desiredArchive: false,
  };
}

async function seedSession(harness: LodyHarness, title: string): Promise<void> {
  const snapshot = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
  if (snapshot === null) throw new Error("the daemon served no catalog");
  const store = createStore();
  const handle = await createLodyRuntime({
    endpoints: {
      ...harness.endpoints,
      // SAFETY: same injected transport contract as targetFor above.
      webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
    },
    snapshot,
  });
  try {
    mountLodyRuntimeAtoms(store, handle.runtime);
    await bootstrapLodyAgentConfigs(store, handle.runtime, snapshot.machineId);
    await startLodySession(handle.runtime, {
      sessionId: randomUUID(),
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: BLITZ_CLAUDE_CONFIG_ID,
      agentType: "claude",
      prompt: "seed",
      title,
    });
  } finally {
    unmountLodyRuntimeAtoms(store);
    await handle.dispose();
  }
}

async function waitFor(
  what: string,
  check: () => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

describe.skipIf(!lodyDaemonAvailable() || process.env["BLITZ_LODY_SWITCH_PROBE"] !== "1")(
  "retained Lody activation cost",
  () => {
    let harnessA: LodyHarness | undefined;
    let harnessB: LodyHarness | undefined;

    beforeAll(async () => {
      installLodyDomStubs();
      process.stdout.write("keepalive probe: starting daemon A\n");
      harnessA = await startLodyHarness();
      process.stdout.write("keepalive probe: seeding daemon A\n");
      await seedSession(harnessA, "identity A marker");
      process.stdout.write("keepalive probe: starting daemon B\n");
      harnessB = await startLodyHarness();
      process.stdout.write("keepalive probe: seeding daemon B\n");
      await seedSession(harnessB, "identity B marker");
      process.stdout.write("keepalive probe: both identities seeded\n");
    }, HARNESS_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await harnessA?.stop();
      await harnessB?.stop();
    }, 120_000);

    it("activates retained route content and the correct identity rail under 200 ms", async () => {
      if (harnessA === undefined || harnessB === undefined) throw new Error("harnesses not ready");
      const { default: SessionSurfacePoolHost } = await import("../src/lody/SessionSurface.js");
      const railHost = document.createElement("div");
      railHost.className = "session-list session-list--vendor";
      document.body.append(railHost);
      const targetA = targetFor(harnessA, "workspace A");
      const targetB = targetFor(harnessB, "workspace B");
      const viewer = { name: "probe", avatarUrl: null };
      const rail = { terminals: [], activeTerminalId: "", onSelectTerminal: () => {} };
      const tree = (target: LodySurfacePoolTarget) => (
        <LodySurfacePool
          Surface={SessionSurfacePoolHost}
          target={target}
          viewer={viewer}
          visible
          railHost={railHost}
          rail={rail}
        />
      );
      const view = await render(tree(targetA));
      const ready = (marker: string): boolean => {
        const visible = view.container.querySelector<HTMLElement>(".lody-surface:not([hidden])");
        return visible?.querySelector("textarea") !== null && railHost.textContent?.includes(marker) === true;
      };
      await waitFor("A route and rail", () => ready("identity A marker"));
      const before = memorySample();

      const activate = async (target: LodySurfacePoolTarget, marker: string): Promise<number> => {
        const started = performance.now();
        await act(async () => view.root.render(tree(target)));
        await waitFor(`${marker} route and rail`, () => ready(marker));
        return performance.now() - started;
      };

      const coldB = await activate(targetB, "identity B marker");
      await waitFor(
        "two retained runtimes",
        () => lodyLiveRepoCount() === 2 && lodyLiveDataPlaneSocketCount() === 2,
      );
      const twoLive = memorySample();
      await activate(targetA, "identity A marker");
      const activations: number[] = [];
      const cycles: number[] = [];
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const toB = await activate(targetB, "identity B marker");
        const toA = await activate(targetA, "identity A marker");
        activations.push(toB, toA);
        cycles.push(toB + toA);
      }
      const p50 = percentile(activations, 0.5);
      const p95 = percentile(activations, 0.95);

      // Finish on B, then kill hidden A. Its socket-close continuity edge must
      // evict the whole retained tree before this measurement settles.
      await activate(targetB, "identity B marker");
      await harnessA.stop();
      harnessA = undefined;
      await waitFor(
        "hidden A eviction",
        () => lodyLiveRepoCount() === 1 && lodyLiveDataPlaneSocketCount() === 1,
      );
      await settle();
      const afterEviction = memorySample();

      const report = {
        identities: "two independent daemons",
        cycles: 5,
        coldB,
        activations,
        activationP50: p50,
        activationP95: p95,
        cycleP50: percentile(cycles, 0.5),
        cycleP95: percentile(cycles, 0.95),
        memory: { before, twoLive, afterEviction },
      };
      process.stdout.write(`\n=== LODY KEEPALIVE ACTIVATION ===\n${JSON.stringify(report, null, 2)}\n`);
      writeFileSync("/tmp/lody-keepalive-activation.json", JSON.stringify(report, null, 2));
      expect(twoLive.sockets).toBe(2);
      expect(twoLive.repos).toBe(2);
      expect(p95).toBeLessThan(200);

      await view.unmount();
      railHost.remove();
    }, 300_000);
  },
);

vi.setConfig({ hookTimeout: HARNESS_BOOT_TIMEOUT_MS, testTimeout: 300_000 });

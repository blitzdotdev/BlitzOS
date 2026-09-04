/**
 * Opt-in Phase C measurement: two real daemon identities, two retained full
 * renderer trees, and five A to B to A cycles.
 *
 * The probe observes DOM commits and WebSocket readiness. Product code carries
 * no benchmark marks or counters.
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { act } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { LodySurfacePool, type LodySurfacePoolTarget } from "../src/lody/LodySurfacePool.js";
import { fetchLodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import { createLodyRuntime } from "../src/lody/runtime.js";
import { startLodySession } from "../src/lody/session.js";
import { createLodySurfaceIdentityClaims } from "../src/lody/surface-identity-claims.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import {
  HARNESS_BOOT_TIMEOUT_MS,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness.js";
import { render } from "./dom.js";

interface MemorySample {
  rss: number;
  heapUsed: number;
  external: number;
  openSockets: number;
  gcExposed: boolean;
}

interface ActivationSample {
  target: "A" | "B";
  visible: number;
  ready: number;
  socketUsable: number;
}

interface SocketTracker {
  webSocketConstructor: typeof WebSocket;
  openCount(): number;
  liveCount(): number;
}

interface MarkerObservation {
  visibleAt: number | null;
  readyAt: number | null;
  socketUsableAt: number | null;
  sample(): void;
  disconnect(): void;
}

function createSocketTracker(): SocketTracker {
  const sockets = new Set<NodeWebSocket>();
  function TrackedWebSocket(url: string | URL): NodeWebSocket {
    const socket = new NodeWebSocket(url);
    sockets.add(socket);
    return socket;
  }
  // SAFETY: the constructor returns ws's WebSocket implementation. It exposes
  // every handler, readyState, send, and close member used by the data plane.
  const webSocketConstructor = TrackedWebSocket as unknown as typeof WebSocket;
  return {
    webSocketConstructor,
    openCount: () => [...sockets].filter((socket) => socket.readyState === NodeWebSocket.OPEN).length,
    liveCount: () => [...sockets].filter(
      (socket) => socket.readyState === NodeWebSocket.CONNECTING
        || socket.readyState === NodeWebSocket.OPEN,
    ).length,
  };
}

function runOptionalGc(): boolean {
  const candidate: unknown = Reflect.get(globalThis, "gc");
  if (typeof candidate !== "function") return false;
  candidate();
  return true;
}

function memorySample(trackers: readonly SocketTracker[]): MemorySample {
  const gcExposed = runOptionalGc();
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    openSockets: trackers.reduce((total, tracker) => total + tracker.openCount(), 0),
    gcExposed,
  };
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? -1;
}

function targetFor(
  harness: LodyHarness,
  title: string,
  tracker: SocketTracker,
): LodySurfacePoolTarget {
  return {
    kind: "owned",
    endpoints: {
      ...harness.endpoints,
      webSocketConstructor: tracker.webSocketConstructor,
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
  const handle = await createLodyRuntime({
    endpoints: {
      ...harness.endpoints,
      // SAFETY: ws exposes the WebSocket subset used by the browser transport.
      webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
    },
    snapshot,
  });
  try {
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
    await handle.dispose();
  }
}

async function waitFor(
  what: string,
  check: () => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The observer timestamps the commit delivery without any product marker. */
function observeActivation(
  container: HTMLElement,
  railHost: HTMLElement,
  marker: string,
  tracker: SocketTracker,
): MarkerObservation {
  const observation: MarkerObservation = {
    visibleAt: null,
    readyAt: null,
    socketUsableAt: null,
    sample: () => undefined,
    disconnect: () => observer.disconnect(),
  };
  const sample = (): void => {
    const now = performance.now();
    const socketUsable = tracker.openCount() > 0;
    if (socketUsable && observation.socketUsableAt === null) observation.socketUsableAt = now;
    const root = container.querySelector<HTMLElement>(
      '.lody-surface[data-lody-active="true"]:not([hidden])',
    );
    const rail = railHost.querySelector<HTMLElement>('[data-lody-rail-active="true"]');
    const targetCommitted = root !== null && rail?.textContent?.includes(marker) === true;
    if (targetCommitted && observation.visibleAt === null) observation.visibleAt = now;
    if (
      targetCommitted
      && root.querySelector("textarea") !== null
      && socketUsable
      && observation.readyAt === null
    ) {
      observation.readyAt = now;
    }
  };
  observation.sample = sample;
  const observer = new MutationObserver(sample);
  observer.observe(container, { subtree: true, childList: true, attributes: true });
  observer.observe(railHost, { subtree: true, childList: true, attributes: true });
  sample();
  return observation;
}

function outputPath(): string {
  return process.env["BLITZ_LODY_PROBE_OUTPUT"] ?? "/tmp/lody-keepalive-activation.json";
}

function probeCommand(path: string): string {
  const bundle = process.env["LODY_BUNDLE"] ?? "<source-built-lody-bundle>";
  return `LODY_BUNDLE=${bundle} BLITZ_LODY_SWITCH_PROBE=1 `
    + `BLITZ_LODY_PROBE_OUTPUT=${path} npx vitest run --config vite.wt-test.config.ts `
    + "--maxWorkers=1 test/lody-keepalive-activation.probe.test.tsx";
}

function table(report: {
  coldB: ActivationSample;
  activationP50: { visible: number; ready: number };
  activationP95: { visible: number; ready: number };
  cycleP50: number;
  cycleP95: number;
  artifactPath: string;
}): string {
  return [
    "",
    "=== LODY KEEPALIVE JSDOM COMMIT BENCHMARK ===",
    "| Measurement | ms from activation |",
    "|---|---:|",
    `| cold B visible | ${report.coldB.visible.toFixed(3)} |`,
    `| cold B ready | ${report.coldB.ready.toFixed(3)} |`,
    `| retained visible p50 | ${report.activationP50.visible.toFixed(3)} |`,
    `| retained visible p95 | ${report.activationP95.visible.toFixed(3)} |`,
    `| retained ready p50 | ${report.activationP50.ready.toFixed(3)} |`,
    `| retained ready p95 | ${report.activationP95.ready.toFixed(3)} |`,
    `| cycle p50 | ${report.cycleP50.toFixed(3)} |`,
    `| cycle p95 | ${report.cycleP95.toFixed(3)} |`,
    "",
    `Artifact: ${report.artifactPath}`,
    "",
  ].join("\n");
}

describe.skipIf(!lodyDaemonAvailable() || process.env["BLITZ_LODY_SWITCH_PROBE"] !== "1")(
  "retained Lody activation cost",
  () => {
    let harnessA: LodyHarness | undefined;
    let harnessB: LodyHarness | undefined;

    beforeAll(async () => {
      installLodyDomStubs();
      Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 8 });
      process.stdout.write("keepalive probe: starting daemon A\n");
      harnessA = await startLodyHarness();
      process.stdout.write("keepalive probe: seeding daemon A\n");
      await seedSession(harnessA, "identity A marker");
      process.stdout.write("keepalive probe: starting daemon B\n");
      harnessB = await startLodyHarness();
      process.stdout.write("keepalive probe: seeding daemon B\n");
      await seedSession(harnessB, "identity B marker");
    }, HARNESS_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await harnessA?.stop();
      await harnessB?.stop();
    }, 120_000);

    it("activates retained route content and the correct identity rail", async () => {
      if (harnessA === undefined || harnessB === undefined) throw new Error("harnesses not ready");
      const { default: SessionSurfacePoolHost } = await import("../src/lody/SessionSurface.js");
      const railHost = document.createElement("div");
      railHost.className = "session-list session-list--vendor";
      document.body.append(railHost);
      const trackerA = createSocketTracker();
      const trackerB = createSocketTracker();
      const trackers = [trackerA, trackerB];
      const targetA = targetFor(harnessA, "workspace A", trackerA);
      const targetB = targetFor(harnessB, "workspace B", trackerB);
      const identityClaims = createLodySurfaceIdentityClaims();
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
          identityClaims={identityClaims}
          claimantId="activation-probe"
        />
      );
      const view = await render(tree(targetA));
      const markerReady = (marker: string, tracker: SocketTracker): boolean => {
        const root = view.container.querySelector<HTMLElement>(
          '.lody-surface[data-lody-active="true"]:not([hidden])',
        );
        const activeRail = railHost.querySelector<HTMLElement>('[data-lody-rail-active="true"]');
        return root !== null
          && root.querySelector("textarea") !== null
          && activeRail?.textContent?.includes(marker) === true
          && tracker.openCount() === 1;
      };
      await waitFor("A route, rail, and socket", () => markerReady("identity A marker", trackerA));
      const before = memorySample(trackers);

      const activate = async (
        target: LodySurfacePoolTarget,
        targetName: "A" | "B",
        marker: string,
        tracker: SocketTracker,
      ): Promise<ActivationSample> => {
        const started = performance.now();
        const observation = observeActivation(view.container, railHost, marker, tracker);
        await act(async () => view.root.render(tree(target)));
        await waitFor(`${marker} visible commit`, () => {
          observation.sample();
          return observation.visibleAt !== null;
        });
        await waitFor(`${marker} ready commit`, () => {
          observation.sample();
          return observation.readyAt !== null;
        });
        observation.disconnect();
        if (
          observation.visibleAt === null
          || observation.readyAt === null
          || observation.socketUsableAt === null
        ) {
          throw new Error(`incomplete activation observation for ${marker}`);
        }
        return {
          target: targetName,
          visible: observation.visibleAt - started,
          ready: observation.readyAt - started,
          socketUsable: observation.socketUsableAt - started,
        };
      };

      const coldB = await activate(targetB, "B", "identity B marker", trackerB);
      await waitFor("two retained sockets", () => trackerA.openCount() + trackerB.openCount() === 2);
      const twoLive = memorySample(trackers);
      await activate(targetA, "A", "identity A marker", trackerA);
      const activations: ActivationSample[] = [];
      const cycles: number[] = [];
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const toB = await activate(targetB, "B", "identity B marker", trackerB);
        const toA = await activate(targetA, "A", "identity A marker", trackerA);
        activations.push(toB, toA);
        cycles.push(toB.ready + toA.ready);
      }

      await activate(targetB, "B", "identity B marker", trackerB);
      await harnessA.stop();
      harnessA = undefined;
      await waitFor("hidden A socket eviction", () => trackerA.liveCount() === 0);
      const afterEviction = memorySample(trackers);
      const visible = activations.map((sample) => sample.visible);
      const ready = activations.map((sample) => sample.ready);
      const artifactPath = outputPath();
      const report = {
        benchmark: "jsdom React commit with installLodyDomStubs fixed element sizes",
        command: probeCommand(artifactPath),
        artifactPath,
        identities: "two independent source-built daemons",
        cycles: 5,
        coldB,
        activations,
        activationP50: {
          visible: percentile(visible, 0.5),
          ready: percentile(ready, 0.5),
        },
        activationP95: {
          visible: percentile(visible, 0.95),
          ready: percentile(ready, 0.95),
        },
        cycleP50: percentile(cycles, 0.5),
        cycleP95: percentile(cycles, 0.95),
        memory: { before, twoLive, afterEviction },
      };
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(table(report));

      await view.unmount();
      railHost.remove();
      expect(activations).toHaveLength(10);
      expect(twoLive.openSockets).toBe(2);
      expect(afterEviction.openSockets).toBe(1);
    }, 300_000);
  },
);

vi.setConfig({ hookTimeout: HARNESS_BOOT_TIMEOUT_MS, testTimeout: 300_000 });

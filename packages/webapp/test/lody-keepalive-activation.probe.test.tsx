/**
 * Opt-in Phase C measurement: two real daemon identities, two retained full
 * renderer trees, and five A→B→A cycles.
 *
 *   BLITZ_LODY_SWITCH_PROBE=1 npx vitest run --maxWorkers=1 \
 *     test/lody-keepalive-activation.probe.test.tsx
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { act } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { LodySurfacePool, type LodySurfacePoolTarget } from "../src/lody/LodySurfacePool.js";
import { lodyLiveDataPlaneSocketCount } from "../src/lody/data-plane-connection.js";
import { fetchLodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import { createLodyRuntime } from "../src/lody/runtime.js";
import { startLodySession } from "../src/lody/session.js";
import {
  beginLodyActivationTrace,
  lodyActivationTraceHasPhase,
  readLodyActivationTrace,
  type LodyActivationPhase,
  type LodyActivationTrace,
} from "../src/lody/surface-activation-performance.js";
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
  gcExposed: boolean;
}

interface ActivationSample {
  target: "A" | "B";
  visible: number;
  ready: number;
  observerDelivery: { visible: number; ready: number };
  trace: LodyActivationTrace;
}

interface MarkerObservation {
  visibleAt: number | null;
  readyAt: number | null;
  disconnect: () => void;
}

const RETAINED_PHASES: readonly LodyActivationPhase[] = [
  "active-flip-commit",
  "activity-reveal-commit",
  "effects-settled",
  "rail-portal-mount-commit",
  "address-reconciliation",
  "identity-revalidation-start",
  "identity-revalidation-end",
  "surface-visible-commit",
  "focus-restore",
];

function runOptionalGc(): boolean {
  const candidate: unknown = Reflect.get(globalThis, "gc");
  if (typeof candidate !== "function") return false;
  candidate();
  return true;
}

function memorySample(): MemorySample {
  const gcExposed = runOptionalGc();
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    sockets: lodyLiveDataPlaneSocketCount(),
    repos: lodyLiveRepoCount(),
    gcExposed,
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
  const handle = await createLodyRuntime({
    endpoints: {
      ...harness.endpoints,
      // SAFETY: same injected transport contract as targetFor above.
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

/** Mutation timestamps, independent of the loop that lets React flush work. */
function observeMarkers(
  container: HTMLElement,
  railHost: HTMLElement,
  marker: string,
  targetKey: string,
): MarkerObservation {
  const observation: MarkerObservation = {
    visibleAt: null,
    readyAt: null,
    disconnect: () => observer.disconnect(),
  };
  const check = (): void => {
    const root = [...container.querySelectorAll<HTMLElement>(
      '.lody-surface[data-lody-active="true"]:not([hidden])',
    )].find((candidate) => candidate.dataset["lodyPerformanceTarget"] === targetKey) ?? null;
    const now = performance.now();
    if (root !== null && observation.visibleAt === null) observation.visibleAt = now;
    const rail = railHost.querySelector<HTMLElement>('[data-lody-rail-active="true"]');
    if (
      root !== null
      && root.querySelector("textarea") !== null
      && rail?.textContent?.includes(marker) === true
      && observation.readyAt === null
    ) {
      observation.readyAt = now;
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(container, { subtree: true, childList: true, attributes: true });
  observer.observe(railHost, { subtree: true, childList: true, attributes: true });
  check();
  return observation;
}

function nextArtifactPath(): string {
  mkdirSync("/tmp/codex", { recursive: true });
  for (let sequence = 1; sequence < 10_000; sequence += 1) {
    const path = `/tmp/codex/perf-run-${sequence}.json`;
    if (!existsSync(path)) return path;
  }
  throw new Error("no unique performance artifact path remains");
}

function phaseElapsed(sample: ActivationSample, phase: LodyActivationPhase): number {
  return sample.trace.marks.find((mark) => mark.phase === phase)?.elapsed ?? -1;
}

function tracePhaseElapsed(trace: LodyActivationTrace, phase: LodyActivationPhase): number {
  const elapsed = trace.marks.find((mark) => mark.phase === phase)?.elapsed;
  if (elapsed === undefined) throw new Error(`activation trace omitted ${phase}`);
  return elapsed;
}

function table(report: {
  artifactPath: string;
  coldB: ActivationSample;
  activationP50: { visible: number; ready: number };
  activationP95: { visible: number; ready: number };
  cycleP50: number;
  cycleP95: number;
  phaseMedians: Readonly<Record<LodyActivationPhase, number>>;
  addressNavigations: number;
  memory: {
    before: MemorySample;
    twoLive: MemorySample;
    afterEviction: MemorySample;
  };
}): string {
  const rows: Array<readonly [string, number]> = [
    ["cold B visible", report.coldB.visible],
    ["cold B ready", report.coldB.ready],
    ["retained visible p50", report.activationP50.visible],
    ["retained visible p95", report.activationP95.visible],
    ["retained ready p50", report.activationP50.ready],
    ["retained ready p95", report.activationP95.ready],
    ["cycle p50", report.cycleP50],
    ["cycle p95", report.cycleP95],
    ...RETAINED_PHASES.map(
      (phase): readonly [string, number] => [`median ${phase}`, report.phaseMedians[phase]],
    ),
  ];
  return [
    "",
    "=== LODY KEEPALIVE ACTIVATION ===",
    "| Measurement | ms from activation |",
    "|---|---:|",
    ...rows.map(([label, value]) => `| ${label} | ${value.toFixed(3)} |`),
    `| address reconciliations that navigated | ${report.addressNavigations} / 10 |`,
    "",
    "| Memory point | RSS | heap used | external | sockets | repos | forced GC |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.memory).map(([label, sample]) =>
      `| ${label} | ${sample.rss} | ${sample.heapUsed} | ${sample.external} | `
      + `${sample.sockets} | ${sample.repos} | ${sample.gcExposed ? "yes" : "no"} |`),
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

    it("activates retained route content and the correct identity rail with margin", async () => {
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
      const initialReady = (): boolean => {
        const root = view.container.querySelector<HTMLElement>(
          '.lody-surface[data-lody-active="true"]:not([hidden])',
        );
        const activeRail = railHost.querySelector<HTMLElement>('[data-lody-rail-active="true"]');
        return root !== null
          && root.querySelector("textarea") !== null
          && activeRail?.textContent?.includes("identity A marker") === true;
      };
      await waitFor("A route and rail", initialReady);
      const before = memorySample();

      const activate = async (
        target: LodySurfacePoolTarget,
        targetName: "A" | "B",
        marker: string,
        retained: boolean,
      ): Promise<ActivationSample> => {
        const observation = observeMarkers(
          view.container,
          railHost,
          marker,
          target.endpoints.platformUrl,
        );
        let started = -1;
        let traceId = -1;
        await act(async () => {
          started = performance.now();
          traceId = beginLodyActivationTrace(target.endpoints.platformUrl, started);
          view.root.render(tree(target));
        });
        await waitFor(`${marker} visible marker`, () => observation.visibleAt !== null);
        await waitFor(`${marker} ready marker`, () => observation.readyAt !== null);
        if (retained) {
          await waitFor(
            `${marker} activation marks`,
            () => RETAINED_PHASES.every((phase) => lodyActivationTraceHasPhase(traceId, phase)),
          );
        }
        observation.disconnect();
        const trace = readLodyActivationTrace(traceId);
        if (trace === null || observation.visibleAt === null || observation.readyAt === null) {
          throw new Error(`incomplete activation trace for ${marker}`);
        }
        const observerDelivery = {
          visible: observation.visibleAt - started,
          ready: observation.readyAt - started,
        };
        // MutationObserver validates the target identity, composer and active
        // rail wrapper. For a retained tree those nodes already exist, so the
        // exact first-ready instant is the commit that reveals both wrappers,
        // not the later microtask in which MutationObserver delivers records.
        const visible = retained
          ? tracePhaseElapsed(trace, "surface-visible-commit")
          : observerDelivery.visible;
        const ready = retained
          ? Math.max(visible, tracePhaseElapsed(trace, "rail-portal-mount-commit"))
          : observerDelivery.ready;
        return {
          target: targetName,
          visible,
          ready,
          observerDelivery,
          trace,
        };
      };

      const coldB = await activate(targetB, "B", "identity B marker", false);
      await waitFor(
        "two retained runtimes",
        () => lodyLiveRepoCount() === 2 && lodyLiveDataPlaneSocketCount() === 2,
      );
      const twoLive = memorySample();
      await activate(targetA, "A", "identity A marker", true);
      const activations: ActivationSample[] = [];
      const cycles: number[] = [];
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const toB = await activate(targetB, "B", "identity B marker", true);
        const toA = await activate(targetA, "A", "identity A marker", true);
        activations.push(toB, toA);
        cycles.push(toB.ready + toA.ready);
      }
      const visible = activations.map((sample) => sample.visible);
      const ready = activations.map((sample) => sample.ready);
      // SAFETY: every key comes from the exhaustive LodyActivationPhase list.
      const phaseMedians = Object.fromEntries(
        RETAINED_PHASES.map((phase) => [
          phase,
          percentile(activations.map((sample) => phaseElapsed(sample, phase)), 0.5),
        ]),
      ) as Record<LodyActivationPhase, number>;

      // Finish on B, then kill hidden A. Its socket-close continuity edge must
      // evict the whole retained tree before this measurement settles.
      await activate(targetB, "B", "identity B marker", true);
      await harnessA.stop();
      harnessA = undefined;
      await waitFor(
        "hidden A eviction",
        () => lodyLiveRepoCount() === 1 && lodyLiveDataPlaneSocketCount() === 1,
      );
      await settle();
      const afterEviction = memorySample();

      const artifactPath = nextArtifactPath();
      const addressNavigations = activations.filter((sample) =>
        sample.trace.marks.some(
          (mark) => mark.phase === "address-reconciliation" && mark.detail?.navigated === true,
        )).length;
      const report = {
        label: process.env["BLITZ_LODY_PERF_LABEL"] ?? "measurement",
        artifactPath,
        identities: "two independent daemons",
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
        phaseMedians,
        addressNavigations,
        memory: { before, twoLive, afterEviction },
      };
      writeFileSync(artifactPath, JSON.stringify(report, null, 2), { flag: "wx" });
      process.stdout.write(table(report));

      await view.unmount();
      railHost.remove();
      expect(twoLive.sockets).toBe(2);
      expect(twoLive.repos).toBe(2);
      expect(report.activationP50.ready).toBeLessThan(100);
      expect(report.activationP95.ready).toBeLessThan(150);
    }, 300_000);
  },
);

vi.setConfig({ hookTimeout: HARNESS_BOOT_TIMEOUT_MS, testTimeout: 300_000 });

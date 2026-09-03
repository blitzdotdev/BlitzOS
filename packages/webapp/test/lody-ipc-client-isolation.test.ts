/**
 * FAILING-FIRST PROOF FOR TIER 2 IPC ISOLATION.
 *
 * Before seam 18, the first data-plane case failed: connection A subscribed on
 * bridge A but sent its later frame through the poison page global. These tests
 * exercise the real vendor factories and hooks, then add a source audit so an
 * unthreaded helper call cannot quietly reintroduce the singleton.
 */
import "fake-indexeddb/auto";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Provider as JotaiProvider, createStore } from "jotai";
import { EphemeralStore } from "loro-crdt";
import { LoroRepo } from "loro-repo";
import { PlatformContext } from "@lody/platform/react";
import {
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  bytesToBase64,
  getLodySessionViewingPresenceKey,
} from "@lody/shared";
import {
  createBoundIpcClient,
  getIpcServices,
  onIpcEvent,
  sendIpc,
} from "@lody/components/lib/electron-ipc-client";
import { IpcClientProvider } from "@lody/components/providers/ipc-client-provider";
import { createLocalLoroDataPlaneConnection } from "@lody/components/providers/local-loro-data-plane-connection";
import {
  getLocalPlatformProvider,
  resetLocalPlatformSnapshotState,
  useImplicitLocalWorkspace,
} from "@lody/components/providers/local-platform-provider";
import { RuntimeProvider } from "@lody/components/providers/runtime-provider";
import { createWorkspaceMachineRpcFacade } from "@lody/components/providers/workspace-machine-rpc-facade";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { userAtom } from "@lody/components/atoms";
import { localProbeResultAtom } from "@lody/components/atoms/local-probe";
import { setWorkspaceContextAtom } from "@lody/components/atoms/workspace-context";
import { lodyPresenceStatesAtom } from "@lody/components/atoms/presence";
import {
  BlitzPlatformProviders,
  createBlitzPlatformProvider,
} from "../src/lody/platform.js";
import type { LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import { render, settle } from "./dom.js";
import {
  findUnscopedIpcCalls,
  mountedSourceClosure,
  workspacePath,
} from "./lody-ipc-source-closure.js";
import {
  createLodySurfaceRuntimeLifecycle,
  type LodyRuntimeLifecycleEvent,
} from "../src/lody/surface-runtime-lifecycle.js";
import { createLodySurfaceIdentityClaims } from "../src/lody/surface-identity-claims.js";

type IpcBridge = NonNullable<Window["ipc"]>;
type Listener = (payload: unknown) => void;
type TestStore = ReturnType<typeof createStore>;
type TestIpcClient = {
  readonly signal: AbortSignal;
  dispose: () => void;
};
type TestWorkspaceRuntime = {
  setLocalMachineId: (machineId: string | null) => void;
  requestSessionDispatchTurn: (
    machineId: string,
    args: {
      sessionId: string;
      userTurnId: string;
      userId: string;
      timestamp: string;
      inputConfig: object;
    },
  ) => Promise<object | null>;
  requestMachineAcpCapabilitiesRefresh: (request: {
    type: "machine/acp-capabilities-refresh";
    machineId: string;
    configId: string;
    cliType: "builtin";
    agentType: string;
  }) => Promise<object | null>;
  dispose: () => Promise<void>;
};

interface BoxSnapshot {
  userId: string;
  workspace: { workspaceId: string; name: string; slug: string; role: string };
}

function snapshotFor(tag: string): BoxSnapshot {
  return {
    userId: `local:${tag}`,
    workspace: { workspaceId: `lw_${tag}`, name: tag, slug: tag, role: "owner" },
  };
}

function fakeBridge(tag: string, options: { snapshotPending?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === "localPlatform.getSnapshot") {
        return options.snapshotPending === true ? null : snapshotFor(tag);
      }
      if (channel === "loro.isConnected") return true;
      if (channel === "machineRpc.send") {
        return {
          ok: true,
          result: {
            type: "session/dispatch-turn_response",
            sessionId: `session-${tag}`,
            userTurnId: `turn-${tag}`,
            accepted: true,
            disposition: "accepted",
          },
        };
      }
      if (channel === "sessionControl.send") {
        return {
          ok: true,
          responses: [
            {
              type: "machine/acp-capabilities-refresh_response",
              machineId: `machine-${tag}`,
              configId: `config-${tag}`,
              cliType: "builtin",
              agentType: "claude",
              success: true,
            },
          ],
        };
      }
      return undefined;
    }),
    on: vi.fn((channel: string, listener: Listener) => {
      let channelListeners = listeners.get(channel);
      if (!channelListeners) {
        channelListeners = new Set();
        listeners.set(channel, channelListeners);
      }
      channelListeners.add(listener);
      return () => channelListeners?.delete(listener);
    }),
    send: vi.fn(),
    emit(channel: string, payload: unknown): void {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
    listenerCount(channel: string): number {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

function asIpcBridge(bridge: ReturnType<typeof fakeBridge>): IpcBridge {
  // SAFETY: the fake implements the production invoke/on/send bridge; `emit`
  // is an additional test-only method and the window declaration is stricter
  // about each channel's overloads than a recording fake can usefully be.
  return bridge as unknown as IpcBridge;
}

const clientsToReset: TestIpcClient[] = [];

function bind(bridge: ReturnType<typeof fakeBridge>): TestIpcClient {
  const client = createBoundIpcClient(asIpcBridge(bridge));
  clientsToReset.push(client);
  return client;
}

function detach(workspaceId: string): {
  type: "detach";
  protocolVersion: number;
  workspaceId: string;
  peerId: string;
} {
  return {
    type: "detach",
    protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
    workspaceId,
    peerId: `peer-${workspaceId}`,
  };
}

function PlatformProbe(props: { report: (workspaceId: string | null) => void }) {
  const workspace = useImplicitLocalWorkspace();
  props.report(workspace?.id ?? null);
  return null;
}

function runtimeSnapshotFor(tag: string): LodyPlatformSnapshot {
  return {
    machineId: `machine-${tag}`,
    ...snapshotFor(tag),
  };
}

function seedRuntimeStore(store: TestStore, tag: string): () => void {
  const snapshot = runtimeSnapshotFor(tag);
  store.set(setWorkspaceContextAtom, {
    slug: snapshot.workspace.slug,
    workspaceId: snapshot.workspace.workspaceId,
  });
  store.set(userAtom, {
    id: snapshot.userId,
    email: `${tag.toLowerCase()}@lody.local`,
    name: tag,
    image: null,
  });
  const identity = {
    ok: true,
    machineId: snapshot.machineId,
    workspaceId: snapshot.workspace.workspaceId,
  };
  const repair = (): void => {
    if (store.get(localProbeResultAtom) === null) store.set(localProbeResultAtom, identity);
  };
  repair();
  return store.sub(localProbeResultAtom, repair);
}

async function waitForRuntime(store: TestStore): Promise<TestWorkspaceRuntime> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // SAFETY: RuntimeProvider writes the vendored WorkspaceRuntime contract to
    // this atom; the test exercises every member in this local narrowing.
    const runtime = store.get(runtimeAtom) as TestWorkspaceRuntime | null;
    if (runtime !== null) return runtime;
    await settle();
  }
  throw new Error("timed out waiting for RuntimeProvider");
}

function runtimeTree(
  tag: string,
  store: TestStore,
  client: TestIpcClient,
  options: {
    localIpcHost?: boolean;
    cloudMode?: boolean;
    onRuntimeLifecycle?: (event: LodyRuntimeLifecycleEvent) => void;
  } = {},
) {
  const snapshot = runtimeSnapshotFor(tag);
  const runtime = createElement(
    RuntimeProvider,
    options.onRuntimeLifecycle === undefined
      ? null
      : { onRuntimeLifecycle: options.onRuntimeLifecycle },
    null,
  );
  const runtimeForMode = options.cloudMode === true
    ? createElement(
        PlatformContext.Provider,
        {
          value: {
            ...createBlitzPlatformProvider({
              snapshot,
              viewer: { name: tag, avatarUrl: null },
              workspaceTitle: `Workspace ${tag}`,
            }),
            sync: { mode: "cloud" },
          },
        },
        runtime,
      )
    : runtime;
  return createElement(
    JotaiProvider,
    { store },
    createElement(
      IpcClientProvider,
      { client, localIpcHost: options.localIpcHost ?? true },
      createElement(
        BlitzPlatformProviders,
        {
          snapshot,
          viewer: { name: tag, avatarUrl: null },
          workspaceTitle: `Workspace ${tag}`,
          children: runtimeForMode,
        },
      ),
    ),
  );
}

async function waitForLifecycle(
  events: readonly LodyRuntimeLifecycleEvent[],
  phase: LodyRuntimeLifecycleEvent["phase"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.some((event) => event.phase === phase)) return;
    await settle();
  }
  throw new Error(`timed out waiting for runtime lifecycle ${phase}`);
}

function presenceFrame(tag: string) {
  const instanceId = `instance-${tag}`;
  const sessionId = `session-${tag}`;
  const userId = `user-${tag}`;
  const now = Date.now();
  const ephemeral = new EphemeralStore();
  ephemeral.set(getLodySessionViewingPresenceKey(userId, instanceId), {
    kind: "session-viewing",
    userId,
    instanceId,
    sessionId,
    since: now,
    updatedAt: now,
  });
  const frame = {
    type: "presence",
    protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
    workspaceId: `lw_${tag}`,
    dataBase64: bytesToBase64(ephemeral.encodeAll()),
  };
  ephemeral.destroy();
  return { frame, key: getLodySessionViewingPresenceKey(userId, instanceId) };
}

function readPresenceStates(store: TestStore): Record<string, object> {
  // SAFETY: lodyPresenceStatesAtom always contains the parsed presence map;
  // RuntimeProvider is the only writer in this harness.
  return store.get(lodyPresenceStatesAtom) as Record<string, object>;
}

afterEach(() => {
  for (const client of clientsToReset.splice(0)) {
    resetLocalPlatformSnapshotState(client);
    client.dispose();
  }
  resetLocalPlatformSnapshotState();
  // SAFETY: cleanup intentionally narrows the test-owned optional global so it
  // can remove only that property without changing the Window declaration.
  delete (window as { ipc?: unknown }).ipc;
  vi.restoreAllMocks();
});

describe("per-surface IPC ownership", () => {
  it("starts no lifecycle attempt without a workspace identity", async () => {
    const store = createStore();
    const events: LodyRuntimeLifecycleEvent[] = [];
    const lifecycle = createLodySurfaceRuntimeLifecycle();
    const mounted = await render(runtimeTree(
      "missing-workspace",
      store,
      bind(fakeBridge("missing-workspace")),
      {
        onRuntimeLifecycle: (event) => {
          events.push(event);
          lifecycle.onRuntimeLifecycle(event);
        },
      },
    ));
    await settle();
    await mounted.unmount();
    const release = vi.fn();
    lifecycle.releaseAfterRuntime(release);
    expect(events).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves Electron's lazy page-global default", async () => {
    const bridgeA = fakeBridge("A");
    const bridgeB = fakeBridge("B");
    const received: unknown[] = [];

    window.ipc = asIpcBridge(bridgeA);
    await getIpcServices()?.loro.isConnected();
    const stop = onIpcEvent("loro.event", (message: unknown) => received.push(message));
    window.ipc = asIpcBridge(bridgeB);
    await getIpcServices()?.loro.isConnected();
    sendIpc("loro.send", detach("lw_B"));
    bridgeA.emit("loro.event", detach("lw_A"));

    expect(bridgeA.invoke).toHaveBeenCalledWith("loro.isConnected");
    expect(bridgeB.invoke).toHaveBeenCalledWith("loro.isConnected");
    expect(bridgeB.send).toHaveBeenCalledWith("loro.send", detach("lw_B"));
    expect(received).toEqual([detach("lw_A")]);
    stop();
  });

  it("keeps two live data planes on their captured bridges", async () => {
    const bridgeA = fakeBridge("A");
    const bridgeB = fakeBridge("B");
    const poison = fakeBridge("poison");
    const connectionA = createLocalLoroDataPlaneConnection(bind(bridgeA));
    const connectionB = createLocalLoroDataPlaneConnection(bind(bridgeB));
    expect(connectionA).not.toBeNull();
    expect(connectionB).not.toBeNull();

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    connectionA?.connection.onMessage((message: unknown) => receivedA.push(message));
    connectionB?.connection.onMessage((message: unknown) => receivedB.push(message));

    // Neither connection may rediscover this global after construction.
    window.ipc = asIpcBridge(poison);
    connectionA?.connection.send(detach("lw_A"));
    connectionB?.connection.send(detach("lw_B"));
    bridgeA.emit("loro.event", detach("lw_A"));
    bridgeB.emit("loro.event", detach("lw_B"));
    poison.emit("loro.event", detach("lw_poison"));
    await settle();

    expect(bridgeA.send).toHaveBeenNthCalledWith(1, "loro.subscribe", null);
    expect(bridgeA.send).toHaveBeenCalledWith("loro.send", detach("lw_A"));
    expect(bridgeB.send).toHaveBeenNthCalledWith(1, "loro.subscribe", null);
    expect(bridgeB.send).toHaveBeenCalledWith("loro.send", detach("lw_B"));
    expect(receivedA).toEqual([detach("lw_A")]);
    expect(receivedB).toEqual([detach("lw_B")]);
    expect(poison.send).not.toHaveBeenCalled();
    expect(poison.on).not.toHaveBeenCalled();

    connectionA?.dispose();
    connectionB?.dispose();
    bridgeA.emit("loro.event", detach("lw_A-after-dispose"));
    bridgeB.emit("loro.event", detach("lw_B-after-dispose"));
    await settle();
    expect(receivedA).toEqual([detach("lw_A")]);
    expect(receivedB).toEqual([detach("lw_B")]);
  });

  it("settles two simultaneous platform consumers on different daemon identities", async () => {
    const bridgeA = fakeBridge("A");
    const bridgeB = fakeBridge("B");
    const poison = fakeBridge("poison");
    const clientA = bind(bridgeA);
    const clientB = bind(bridgeB);
    const observed: { A: string | null; B: string | null } = { A: null, B: null };

    window.ipc = asIpcBridge(poison);
    const mounted = await render(
      createElement(
        "div",
        null,
        createElement(
          IpcClientProvider,
          { client: clientA },
          createElement(PlatformProbe, { report: (id) => (observed.A = id) }),
        ),
        createElement(
          IpcClientProvider,
          { client: clientB },
          createElement(PlatformProbe, { report: (id) => (observed.B = id) }),
        ),
      ),
    );
    await settle();

    expect(observed).toEqual({ A: "lw_A", B: "lw_B" });
    expect(bridgeA.invoke).toHaveBeenCalledWith("localPlatform.getSnapshot");
    expect(bridgeB.invoke).toHaveBeenCalledWith("localPlatform.getSnapshot");
    expect(poison.invoke).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it("routes concurrent session dispatches through each runtime's client", async () => {
    const bridgeA = fakeBridge("A");
    const bridgeB = fakeBridge("B");
    const poison = fakeBridge("poison");
    const targetRouter = {
      getPlaneForMachine: (): "local" => "local",
      resolvePlaneForMachine: async (): Promise<"local"> => "local",
    };
    const noCloudClient = vi.fn(async () => {
      throw new Error("cloud RPC must not be constructed");
    });
    const facadeA = createWorkspaceMachineRpcFacade({
      workspaceId: "lw_A",
      targetRouter,
      getMachineRpcClient: noCloudClient,
      ipcClient: bind(bridgeA),
      localIpcHost: true,
    });
    const facadeB = createWorkspaceMachineRpcFacade({
      workspaceId: "lw_B",
      targetRouter,
      getMachineRpcClient: noCloudClient,
      ipcClient: bind(bridgeB),
      localIpcHost: true,
    });

    window.ipc = asIpcBridge(poison);
    const responseA = await facadeA.requestSessionDispatchTurn("machine-A", {
      sessionId: "session-A",
      userTurnId: "turn-A",
      userId: "user-A",
      timestamp: "2026-09-02T00:00:00.000Z",
      inputConfig: {},
    });
    const responseB = await facadeB.requestSessionDispatchTurn("machine-B", {
      sessionId: "session-B",
      userTurnId: "turn-B",
      userId: "user-B",
      timestamp: "2026-09-02T00:00:00.000Z",
      inputConfig: {},
    });

    expect(responseA).toMatchObject({ sessionId: "session-A", userTurnId: "turn-A" });
    expect(responseB).toMatchObject({ sessionId: "session-B", userTurnId: "turn-B" });
    expect(bridgeA.invoke).toHaveBeenCalledWith(
      "machineRpc.send",
      expect.objectContaining({ workspaceId: "lw_A", method: "session/dispatch-turn" }),
    );
    expect(bridgeB.invoke).toHaveBeenCalledWith(
      "machineRpc.send",
      expect.objectContaining({ workspaceId: "lw_B", method: "session/dispatch-turn" }),
    );
    expect(poison.invoke).not.toHaveBeenCalled();
    expect(noCloudClient).not.toHaveBeenCalled();
  });

  it("mounts two real RuntimeProvider trees and keeps every local plane isolated", async () => {
    const bridgeA = fakeBridge("A");
    const bridgeB = fakeBridge("B");
    const poison = fakeBridge("poison");
    const clientA = bind(bridgeA);
    const clientB = bind(bridgeB);
    const storeA = createStore();
    const storeB = createStore();
    const releaseSeedA = seedRuntimeStore(storeA, "A");
    const releaseSeedB = seedRuntimeStore(storeB, "B");
    const lifecycleA: LodyRuntimeLifecycleEvent[] = [];
    const lifecycleB: LodyRuntimeLifecycleEvent[] = [];

    window.ipc = asIpcBridge(poison);
    const mounted = await render(
      createElement(
        "div",
        null,
        runtimeTree("A", storeA, clientA, {
          onRuntimeLifecycle: (event) => lifecycleA.push(event),
        }),
        runtimeTree("B", storeB, clientB, {
          onRuntimeLifecycle: (event) => lifecycleB.push(event),
        }),
      ),
    );
    const runtimeA = await waitForRuntime(storeA);
    const runtimeB = await waitForRuntime(storeB);
    const machineA = "machine-A";
    const machineB = "machine-B";
    runtimeA.setLocalMachineId(machineA);
    runtimeB.setLocalMachineId(machineB);

    const responseA = await runtimeA.requestSessionDispatchTurn(machineA, {
      sessionId: "session-A",
      userTurnId: "turn-A",
      userId: "user-A",
      timestamp: "2026-09-02T00:00:00.000Z",
      inputConfig: {},
    });
    const responseB = await runtimeB.requestSessionDispatchTurn(machineB, {
      sessionId: "session-B",
      userTurnId: "turn-B",
      userId: "user-B",
      timestamp: "2026-09-02T00:00:00.000Z",
      inputConfig: {},
    });
    const controlA = await runtimeA.requestMachineAcpCapabilitiesRefresh({
      type: "machine/acp-capabilities-refresh",
      machineId: machineA,
      configId: "config-A",
      cliType: "builtin",
      agentType: "claude",
    });
    const controlB = await runtimeB.requestMachineAcpCapabilitiesRefresh({
      type: "machine/acp-capabilities-refresh",
      machineId: machineB,
      configId: "config-B",
      cliType: "builtin",
      agentType: "claude",
    });

    const presenceA = presenceFrame("A");
    const presenceB = presenceFrame("B");
    bridgeA.emit("loro.event", presenceA.frame);
    bridgeB.emit("loro.event", presenceB.frame);
    poison.emit("loro.event", presenceFrame("poison").frame);
    await settle();

    expect(responseA).toMatchObject({ sessionId: "session-A", userTurnId: "turn-A" });
    expect(responseB).toMatchObject({ sessionId: "session-B", userTurnId: "turn-B" });
    expect(controlA).toMatchObject({ machineId: "machine-A", configId: "config-A" });
    expect(controlB).toMatchObject({ machineId: "machine-B", configId: "config-B" });
    expect(readPresenceStates(storeA)).toHaveProperty(presenceA.key);
    expect(readPresenceStates(storeA)).not.toHaveProperty(presenceB.key);
    expect(readPresenceStates(storeB)).toHaveProperty(presenceB.key);
    expect(readPresenceStates(storeB)).not.toHaveProperty(presenceA.key);
    expect(bridgeA.send).toHaveBeenCalledWith("loro.subscribe", null);
    expect(bridgeB.send).toHaveBeenCalledWith("loro.subscribe", null);
    expect(bridgeA.invoke).toHaveBeenCalledWith("machineRpc.send", expect.any(Object));
    expect(bridgeB.invoke).toHaveBeenCalledWith("machineRpc.send", expect.any(Object));
    expect(bridgeA.invoke).toHaveBeenCalledWith("sessionControl.send", expect.any(Object));
    expect(bridgeB.invoke).toHaveBeenCalledWith("sessionControl.send", expect.any(Object));
    expect(poison.invoke).not.toHaveBeenCalled();
    expect(poison.send).not.toHaveBeenCalled();
    expect(poison.on).not.toHaveBeenCalled();
    expect(lifecycleA.some((event) => event.phase === "created")).toBe(true);
    expect(lifecycleB.some((event) => event.phase === "created")).toBe(true);

    await mounted.unmount();
    await Promise.all([
      waitForLifecycle(lifecycleA, "disposed"),
      waitForLifecycle(lifecycleB, "disposed"),
    ]);
    await Promise.all([runtimeA.dispose(), runtimeB.dispose()]);
    expect(lifecycleA.at(-1)?.phase).toBe("disposed");
    expect(lifecycleB.at(-1)?.phase).toBe("disposed");
    clientA.dispose();
    clientB.dispose();
    releaseSeedA();
    releaseSeedB();
    bridgeA.emit("loro.event", presenceFrame("A-after-dispose").frame);
    bridgeB.emit("loro.event", presenceFrame("B-after-dispose").frame);
    await settle();
    expect(bridgeA.listenerCount("loro.event")).toBe(0);
    expect(bridgeB.listenerCount("loro.event")).toBe(0);
    expect(readPresenceStates(storeA)).toEqual({});
    expect(readPresenceStates(storeB)).toEqual({});
  }, 30_000);

  it("rolls a partial repo back before failure releases its identity", async () => {
    const order: string[] = [];
    let rejectFirstAttach = (_error: Error): void => undefined;
    const firstAttach = new Promise<void>((_resolve, reject) => {
      rejectFirstAttach = reject;
    });
    let rejectSecondAttach = (_error: Error): void => undefined;
    const secondAttach = new Promise<void>((_resolve, reject) => {
      rejectSecondAttach = reject;
    });
    const createFakeRepo = (attach: Promise<void>) => {
      const destroy = vi.fn(async () => {
        order.push("repo-destroyed");
      });
      const repo = {
        addTransport: vi.fn(async () => await attach),
        destroy,
        removeTransport: vi.fn(async () => undefined),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      };
      // SAFETY: construction reaches only these four LoroRepo members before
      // the injected addTransport failure; the test asserts that exact rollback path.
      return { destroy, repo: repo as unknown as LoroRepo };
    };
    const firstRepo = createFakeRepo(firstAttach);
    const secondRepo = createFakeRepo(secondAttach);
    const createRepo = vi.spyOn(LoroRepo, "create")
      .mockResolvedValueOnce(firstRepo.repo)
      .mockResolvedValueOnce(secondRepo.repo);
    const lifecycle = createLodySurfaceRuntimeLifecycle();
    const claims = createLodySurfaceIdentityClaims();
    const identity = { machineId: "machine-retry", lwWorkspaceId: "lw_retry" };
    expect(await claims.claim(identity, "first", new AbortController().signal)).toBe(true);
    const firstStore = createStore();
    const releaseFirstSeed = seedRuntimeStore(firstStore, "retry");
    const firstEvents: LodyRuntimeLifecycleEvent[] = [];
    const mounted = await render(runtimeTree("retry", firstStore, bind(fakeBridge("retry")), {
      onRuntimeLifecycle: (event) => {
        firstEvents.push(event);
        lifecycle.onRuntimeLifecycle(event);
        order.push(event.phase);
      },
    }));
    await waitForLifecycle(firstEvents, "starting");
    await mounted.unmount();
    lifecycle.releaseAfterRuntime(() => {
      order.push("identity-released");
      claims.release("first");
    });
    let secondGranted = false;
    const secondClaim = claims.claim(identity, "second", new AbortController().signal)
      .then((granted) => {
        secondGranted = granted;
        return granted;
      });
    await settle();
    expect(secondGranted).toBe(false);

    rejectFirstAttach(new Error("post-repo step failed"));
    await waitForLifecycle(firstEvents, "failed");
    expect(firstRepo.destroy).toHaveBeenCalledTimes(1);
    expect(order.indexOf("failed")).toBeGreaterThan(order.indexOf("repo-destroyed"));
    expect(order.indexOf("identity-released")).toBeGreaterThan(order.indexOf("failed"));
    expect(await secondClaim).toBe(true);

    const secondStore = createStore();
    const releaseSecondSeed = seedRuntimeStore(secondStore, "retry");
    const secondEvents: LodyRuntimeLifecycleEvent[] = [];
    const remounted = await render(runtimeTree(
      "retry",
      secondStore,
      bind(fakeBridge("retry-remount")),
      { onRuntimeLifecycle: (event) => secondEvents.push(event) },
    ));
    await waitForLifecycle(secondEvents, "starting");
    rejectSecondAttach(new Error("second attach failed"));
    await waitForLifecycle(secondEvents, "failed");
    expect(createRepo).toHaveBeenCalledTimes(2);
    expect(secondRepo.destroy).toHaveBeenCalledTimes(1);
    await remounted.unmount();
    claims.release("second");
    releaseFirstSeed();
    releaseSecondSeed();
  });

  it("releases a never-settling platform poll when its client is disposed", async () => {
    vi.useFakeTimers();
    try {
      const bridge = fakeBridge("pending", { snapshotPending: true });
      const client = bind(bridge);
      getLocalPlatformProvider(client);
      await Promise.resolve();
      expect(bridge.invoke).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_500);
      expect(bridge.invoke).toHaveBeenCalledTimes(4);
      const capturedServices = getIpcServices(client);
      client.dispose();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(bridge.invoke).toHaveBeenCalledTimes(4);
      expect(getIpcServices(client)).toBeNull();
      await expect(capturedServices?.loro.isConnected()).rejects.toThrow("IPC client is disposed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains bound-client listeners idempotently on dispose", () => {
    const bridge = fakeBridge("listener-drain");
    const client = bind(bridge);
    const received: unknown[] = [];
    const stop = onIpcEvent("loro.event", (payload: unknown) => received.push(payload), client);
    bridge.emit("loro.event", detach("lw_before_dispose"));
    expect(received).toEqual([detach("lw_before_dispose")]);

    client.dispose();
    client.dispose();
    stop();
    bridge.emit("loro.event", detach("lw_after_dispose"));
    expect(received).toEqual([detach("lw_before_dispose")]);
    expect(bridge.listenerCount("loro.event")).toBe(0);
  });

  it("does not infer a local host from a client supplied to a cloud assembly", async () => {
    const bridge = fakeBridge("cloud");
    const cloudResponse: {
      type: "session/dispatch-turn_response";
      sessionId: string;
      userTurnId: string;
      accepted: boolean;
      disposition: "accepted";
    } = {
      type: "session/dispatch-turn_response",
      sessionId: "session-cloud",
      userTurnId: "turn-cloud",
      accepted: true,
      disposition: "accepted",
    };
    const cloudRequest = vi.fn(async () => cloudResponse);
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId: "lw_cloud",
      targetRouter: {
        getPlaneForMachine: (): "local" => "local",
        resolvePlaneForMachine: async (): Promise<"local"> => "local",
      },
      getMachineRpcClient: async () => ({ requestSessionDispatchTurn: cloudRequest }),
      ipcClient: bind(bridge),
    });

    const response = await facade.requestSessionDispatchTurn("machine-cloud", {
      sessionId: "session-cloud",
      userTurnId: "turn-cloud",
      userId: "user-cloud",
      timestamp: "2026-09-02T00:00:00.000Z",
      inputConfig: {},
    });

    expect(response).toEqual(cloudResponse);
    expect(cloudRequest).toHaveBeenCalledTimes(1);
    expect(bridge.invoke).not.toHaveBeenCalledWith("machineRpc.send", expect.anything());
  });

  it("keeps an actual cloud-mode RuntimeProvider off a supplied local client", async () => {
    const bridge = fakeBridge("cloud-runtime");
    const poison = fakeBridge("poison");
    const client = bind(bridge);
    const store = createStore();
    const releaseSeed = seedRuntimeStore(store, "cloud-runtime");
    window.ipc = asIpcBridge(poison);

    const mounted = await render(
      runtimeTree("cloud-runtime", store, client, {
        localIpcHost: false,
        cloudMode: true,
      }),
    );
    const runtime = await waitForRuntime(store);
    runtime.setLocalMachineId("machine-cloud-runtime");
    await runtime.requestSessionDispatchTurn("machine-cloud-runtime", {
      sessionId: "session-cloud-runtime",
      userTurnId: "turn-cloud-runtime",
      userId: "user-cloud-runtime",
      timestamp: "2026-09-02T00:00:00.000Z",
      inputConfig: {},
    });

    expect(bridge.invoke).not.toHaveBeenCalledWith("machineRpc.send", expect.anything());
    expect(poison.invoke).not.toHaveBeenCalled();
    await mounted.unmount();
    await runtime.dispose();
    releaseSeed();
  });
});

describe("mounted Lody IPC conversion inventory", () => {
  it("contains no ambient helper calls in the runtime or Blitz-mounted route tree", async () => {
    const closure = await mountedSourceClosure();
    expect(closure.map(workspacePath)).toContain(
      "vendor/lody/packages/components/src/components/sessions/public-browser-surface.tsx",
    );
    expect(closure.map(workspacePath)).toContain(
      "vendor/lody/packages/components/src/components/sessions/session-browser-panel.tsx",
    );
    expect(closure.flatMap((file) => findUnscopedIpcCalls(file))).toEqual([]);
  });

  it("rejects an unguarded replacement even when the file/helper count is unchanged", () => {
    const file = resolve(
      process.cwd(),
      "../../vendor/lody/packages/components/src/lib/clear-local-cache.ts",
    );
    const source = readFileSync(file, "utf8");
    const moved = source
      .replace("if (getIpcServices()) {", "if (true) {")
      .concat("\nfunction unguardedAmbientIpc() { return getIpcServices(); }\n");
    const failures = findUnscopedIpcCalls(file, moved);
    expect(failures.some((failure) => failure.includes("unguardedAmbientIpc"))).toBe(true);
  });

  it("binds and provides the client at both Blitz runtime entry points", () => {
    const sessionSurface = readFileSync(
      resolve(process.cwd(), "src/lody/SessionSurface.tsx"),
      "utf8",
    );
    const surfaceIpc = readFileSync(resolve(process.cwd(), "src/lody/surface-ipc.ts"), "utf8");
    const headlessRuntime = readFileSync(resolve(process.cwd(), "src/lody/runtime.ts"), "utf8");

    expect(surfaceIpc).toMatch(/createBoundIpcClient\(bridge\.ipc\)/u);
    expect(surfaceIpc).toMatch(/if \(!active\) return undefined;\s+return publishLodyLocalBridge/u);
    expect(sessionSurface).toMatch(
      /useLodySurfaceIpc\([\s\S]+props\.onContinuityLost,[\s\S]+props\.onSurfaceReleased,/u,
    );
    expect(sessionSurface).toMatch(/<IpcClientProvider client=\{ipcClient\} localIpcHost>/u);
    expect(sessionSurface).toMatch(
      /<LodySurfaceThemeRoot>[\s\S]+surfaces\.map\(\(\{ surfaceKey, \.\.\.props \}\)/u,
    );
    expect(sessionSurface).not.toMatch(/resetLocalPlatformSnapshotState/u);
    expect(headlessRuntime).toMatch(/createBoundIpcClient\(bridge\.ipc\)/u);
    expect(headlessRuntime).toMatch(/eagerSyncSurface: "web",\s+ipcClient,\s+localIpcHost: true,/u);
  });
});

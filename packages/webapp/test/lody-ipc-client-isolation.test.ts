/**
 * FAILING-FIRST PROOF FOR TIER 2 IPC ISOLATION.
 *
 * Before seam 18, the first data-plane case failed: connection A subscribed on
 * bridge A but sent its later frame through the poison page global. These tests
 * exercise the real vendor factories and hooks, then add a source audit so an
 * unthreaded helper call cannot quietly reintroduce the singleton.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION } from "@lody/shared";
import {
  createBoundIpcClient,
  getIpcServices,
  onIpcEvent,
  sendIpc,
} from "@lody/components/lib/electron-ipc-client";
import { IpcClientProvider } from "@lody/components/providers/ipc-client-provider";
import { createLocalLoroDataPlaneConnection } from "@lody/components/providers/local-loro-data-plane-connection";
import {
  resetLocalPlatformSnapshotState,
  useImplicitLocalWorkspace,
} from "@lody/components/providers/local-platform-provider";
import { createWorkspaceMachineRpcFacade } from "@lody/components/providers/workspace-machine-rpc-facade";
import { render, settle } from "./dom.js";

type IpcBridge = NonNullable<Window["ipc"]>;
type Listener = (payload: unknown) => void;

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

function fakeBridge(tag: string) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    invoke: vi.fn(async (channel: string) => {
      if (channel === "localPlatform.getSnapshot") return snapshotFor(tag);
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
  };
}

function asIpcBridge(bridge: ReturnType<typeof fakeBridge>): IpcBridge {
  // SAFETY: the fake implements the production invoke/on/send bridge; `emit`
  // is an additional test-only method and the window declaration is stricter
  // about each channel's overloads than a recording fake can usefully be.
  return bridge as unknown as IpcBridge;
}

const clientsToReset: object[] = [];

function bind(bridge: ReturnType<typeof fakeBridge>) {
  const client = createBoundIpcClient(asIpcBridge(bridge));
  clientsToReset.push(client);
  return client;
}

function detach(workspaceId: string) {
  return {
    type: "detach" as const,
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

afterEach(() => {
  for (const client of clientsToReset.splice(0)) {
    resetLocalPlatformSnapshotState(client);
  }
  resetLocalPlatformSnapshotState();
  delete (window as { ipc?: unknown }).ipc;
  vi.restoreAllMocks();
});

describe("per-surface IPC ownership", () => {
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
  });

  it("settles two simultaneous platform consumers on different daemon identities", async () => {
    const bridgeA = fakeBridge("A");
    const bridgeB = fakeBridge("B");
    const poison = fakeBridge("poison");
    const clientA = bind(bridgeA);
    const clientB = bind(bridgeB);
    const observed = { A: null as string | null, B: null as string | null };

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
    });
    const facadeB = createWorkspaceMachineRpcFacade({
      workspaceId: "lw_B",
      targetRouter,
      getMachineRpcClient: noCloudClient,
      ipcClient: bind(bridgeB),
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
});

const SURFACE_SCOPED_SOURCE_FILES = [
  "providers/ipc-client-provider.tsx",
  "providers/local-platform-provider.ts",
  "providers/local-loro-data-plane-connection.ts",
  "providers/create-workspace-runtime.ts",
  "providers/runtime-provider.tsx",
  "providers/workspace-machine-rpc-facade.ts",
  "components/chat/chat-landing.tsx",
  "components/mentions/mention-project-file-source.ts",
  "components/sessions/session-file-content-view.tsx",
  "components/sessions/session-detail.tsx",
  "components/sessions/session-chat-input-area.tsx",
  "hooks/use-chat-landing-file-draft.ts",
  "hooks/use-local-project-file-paths.ts",
  "hooks/use-local-projects-admin.ts",
  "hooks/use-session-actions.ts",
  "lib/electron-session-file-sender.ts",
  "lib/local-project-rpc-file-provider.ts",
  "lib/project-history-control-client.ts",
] as const;

const IPC_HELPER_NAMES = [
  "getIpcServices",
  "onIpcEvent",
  "sendIpc",
  "sendLocalSessionControl",
] as const;

/** Find the closing parenthesis while ignoring parentheses in strings/comments. */
function findCallEnd(source: string, openingParenthesis: number): number {
  let depth = 1;
  let quote: "\"" | "'" | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingParenthesis + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function findUnscopedIpcCalls(relativePath: string): string[] {
  const file = resolve(
    process.cwd(),
    "../../vendor/lody/packages/components/src",
    relativePath,
  );
  const sourceText = readFileSync(file, "utf8");
  const failures: string[] = [];
  for (const helperName of IPC_HELPER_NAMES) {
    const callPattern = new RegExp(`\\b${helperName}\\s*\\(`, "gu");
    for (const match of sourceText.matchAll(callPattern)) {
      const matchIndex = match.index;
      const openingParenthesis = sourceText.indexOf("(", matchIndex);
      const closingParenthesis = findCallEnd(sourceText, openingParenthesis);
      const argumentsText = sourceText.slice(openingParenthesis + 1, closingParenthesis);
      if (!/\bipcClient\b/u.test(argumentsText)) {
        const line = sourceText.slice(0, matchIndex).split("\n").length;
        failures.push(`${relativePath}:${line} ${helperName}`);
      }
    }
  }
  return failures;
}

describe("mounted Lody IPC conversion inventory", () => {
  it("contains no ambient helper calls in the runtime or Blitz-mounted route tree", () => {
    expect(SURFACE_SCOPED_SOURCE_FILES.flatMap(findUnscopedIpcCalls)).toEqual([]);
  });

  it("binds and provides the client at both Blitz runtime entry points", () => {
    const sessionSurface = readFileSync(
      resolve(process.cwd(), "src/lody/SessionSurface.tsx"),
      "utf8",
    );
    const headlessRuntime = readFileSync(resolve(process.cwd(), "src/lody/runtime.ts"), "utf8");

    expect(sessionSurface).toMatch(/createBoundIpcClient\(bridge\.ipc\)/u);
    expect(sessionSurface).toMatch(/<IpcClientProvider client=\{ipcClient\}>/u);
    expect(sessionSurface).not.toMatch(/resetLocalPlatformSnapshotState/u);
    expect(headlessRuntime).toMatch(/createBoundIpcClient\(bridge\.ipc\)/u);
    expect(headlessRuntime).toMatch(/eagerSyncSurface: "web",\s+ipcClient,/u);
  });
});

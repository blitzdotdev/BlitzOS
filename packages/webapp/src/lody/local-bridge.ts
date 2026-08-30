/**
 * `window.ipc`, backed by the box gateway instead of Electron
 * (plans/LODY-RUNTIME-DESIGN.md §2.1).
 *
 * THE SEAM IS `window.ipc`, NOT A SOURCE PATCH. `createLocalLoroDataPlaneConnection`
 * (`vendor/lody/packages/components/src/providers/local-loro-data-plane-connection.ts:8`)
 * gates only on `getIpcServices()`, and `getIpcServices()`
 * (`components/src/lib/electron-ipc-client.ts:50`) is a generic proxy over
 * `window.ipc`: `createLodyIpcProxy` dispatches `groupName.methodName` by string
 * (`:22`). Nothing about it is Electron-specific. So installing `window.ipc`
 * before the runtime mounts makes the whole local plane work with NO vendor edit
 * on the data path at all.
 *
 * DO NOT SET `window.__LODY_ELECTRON__`. Forty-four sites read it — window
 * controls in `routes/__root.tsx`, `electron-menu-handler`,
 * `use-electron-updater-state`, the native theme bridge
 * (`theme-provider.tsx:87`), OneSignal, `loro-app-sidebar.tsx:510` — and a
 * browser satisfies none of them. `window.__LODY_LOCAL_BRIDGE__` is set instead,
 * and the five guards that gate the LOCAL planes take the declared seam patch
 * recorded in `vendor/lody/BLITZ-PATCHES.md`.
 *
 * THE CHANNEL ALLOWLIST IS EXPLICIT. Every channel not listed rejects with
 * `lody_ipc_channel_unsupported`. An upstream call site that appears at the next
 * merge therefore fails loudly rather than hanging on a promise nobody resolves
 * (design doc risk 10) — and every refusal is recorded, so a phase-3 round trip
 * can assert the set is empty.
 */
import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "@blitzos/schema";
import { LocalLoroDataPlaneClientMessageSchema } from "@lody/shared/local-loro-data-plane";
import { LocalMachineRpcRequestSchema } from "@lody/shared/local-machine-rpc";
import { LocalProjectControlRequestSchema, LocalSessionControlRequestSchema } from "@lody/shared/message-schemas";
import {
  createLodyDataPlaneConnection,
  type LodyDataPlaneConnectionHandle,
  type LodyDataPlaneStats,
} from "./data-plane-connection.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformFetchOptions } from "./platform-snapshot.js";
import {
  sendMachineRpc,
  sendProjectControl,
  sendSessionControl,
  type LodyHttpPlaneEndpoints,
} from "./rpc-client.js";
import type {
  LodyDataPlaneFrame,
  LodyIpcArgument,
  LodyIpcPush,
  LodyIpcReply,
  LodyIpcSendPayload,
  LodyMachineRpcRequest,
  LodyProjectControlRequest,
  LodySessionControlMessage,
  LodySessionControlPush,
} from "./wire-types.js";

/** Rejection code for any channel outside the allowlist. */
export const UNSUPPORTED_CHANNEL = "lody_ipc_channel_unsupported";

type IpcBridge = NonNullable<Window["ipc"]>;

export interface LodyLocalBridge {
  /** The object installed at `window.ipc`. Exposed for tests that drive it
   * without touching the global. */
  ipc: IpcBridge;
  /** Data-plane counters, for the phase-3 assertion that nothing is dropped. */
  dataPlaneStats: () => LodyDataPlaneStats;
  /** Every channel a caller asked for that this bridge does not serve. */
  unsupportedChannels: () => readonly string[];
  dispose: () => void;
}

export interface LodyLocalBridgeEndpoints extends LodyHttpPlaneEndpoints {
  syncUrl: string;
  webSocketConstructor?: typeof WebSocket;
}

interface PushListeners {
  loroEvent: Set<(payload: LodyDataPlaneFrame) => void>;
  loroStatus: Set<(payload: boolean) => void>;
  sessionControlResponse: Set<(payload: LodySessionControlPush) => void>;
}

/** How `local-projects-ipc.ts` reports a failure on each helper. The four
 * conventions are not interchangeable: each has a caller written against it. */
type ProjectFailureStyle = "error" | "throw" | "null" | "success";

/**
 * Builds the bridge. `installLodyLocalBridge` puts it on `window`; a test can
 * hold it instead.
 *
 * The data-plane socket is opened lazily on the first `loro.subscribe`, which is
 * what `createLocalLoroDataPlaneConnection` sends before anything else. Opening
 * it in the constructor would dial the box for a member who never opens a
 * session.
 */
export function createLodyLocalBridge(endpoints: LodyLocalBridgeEndpoints): LodyLocalBridge {
  const listeners: PushListeners = {
    loroEvent: new Set(),
    loroStatus: new Set(),
    sessionControlResponse: new Set(),
  };
  const unsupported: string[] = [];
  let dataPlane: LodyDataPlaneConnectionHandle | null = null;
  let unsubscribeMessages: (() => void) | null = null;
  let unsubscribeStatus: (() => void) | null = null;

  const openDataPlane = (): LodyDataPlaneConnectionHandle => {
    if (dataPlane !== null) return dataPlane;
    const handle = createLodyDataPlaneConnection(
      endpoints.webSocketConstructor === undefined
        ? { url: endpoints.syncUrl }
        : { url: endpoints.syncUrl, webSocketConstructor: endpoints.webSocketConstructor },
    );
    unsubscribeMessages = handle.connection.onMessage((message: LodyDataPlaneFrame) => {
      for (const listener of listeners.loroEvent) listener(message);
    });
    unsubscribeStatus = handle.connection.onStatusChange((status: boolean) => {
      for (const listener of listeners.loroStatus) listener(status);
    });
    dataPlane = handle;
    return handle;
  };

  const recordUnsupported = (channel: string): void => {
    if (!unsupported.includes(channel)) unsupported.push(channel);
  };

  function projectFailure(style: ProjectFailureStyle, message: string): LodyIpcReply {
    if (style === "throw") throw new Error(message);
    if (style === "null") return null;
    if (style === "success") return { success: false, error: message };
    return { error: message };
  }

  /** One `local-project/*` or `worktree/*` request and one unwrap, mirroring
   * `apps/electron/src/main/ipc/services/local-projects-ipc.ts` field for field.
   * The four failure styles are that file's, reproduced because the callers in
   * `@lody/components` are written against those return shapes rather than
   * against the raw response union. */
  async function projectResult(
    type: string,
    fields: Record<string, JsonValue | undefined>,
    onError: ProjectFailureStyle,
  ): Promise<LodyIpcReply> {
    const entries: [string, JsonValue][] = [["type", type]];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) entries.push([key, value]);
    }
    const parsed = LocalProjectControlRequestSchema.safeParse(Object.fromEntries(entries));
    if (!parsed.success) return projectFailure(onError, `invalid ${type} request`);
    // SAFETY: the request union's own schema just accepted this object, and
    // every member of it carries the `type` discriminant; the assertion crosses
    // the vendor type seam, where every `@lody/*` name is a namespace.
    const request = parsed.data as LodyProjectControlRequest;
    const response = await sendProjectControl(endpoints, request);
    if (response.ok && response.type === type) return response.result;
    const message = response.ok ? `Unexpected response type: ${response.type}` : response.message;
    // `cli_not_running` is the exact string the vendored file tree branches on.
    const dead = !response.ok && response.error === "daemon_unavailable";
    return projectFailure(onError, dead ? "cli_not_running" : message);
  }

  const invoke = async (channel: string, ...args: LodyIpcArgument[]): Promise<LodyIpcReply> => {
    switch (channel) {
      case "loro.isConnected":
        return dataPlane?.connection.isConnected() ?? false;

      case "localPlatform.getSnapshot": {
        // Load-bearing beyond our own platform provider: `RuntimeProvider`
        // resolves its workspace id through `useImplicitLocalWorkspace()`
        // (`providers/local-platform-provider.ts:143`), which polls THIS channel
        // on a module-level singleton store — not through `PlatformContext`. So
        // without it the runtime never gets a workspace id and never mounts.
        // `null` means "not provisioned yet" and the poller retries; a throw is
        // terminal there, so a transport failure must return null too.
        const options: LodyPlatformFetchOptions = {};
        if (endpoints.fetchImpl !== undefined) options.fetchImpl = endpoints.fetchImpl;
        try {
          const snapshot = await fetchLodyPlatformSnapshot(endpoints.platformUrl, options);
          if (snapshot === null) return null;
          return { userId: snapshot.userId, workspace: snapshot.workspace };
        } catch {
          return null;
        }
      }

      case "machineRpc.send": {
        // Parsed at the boundary even though the caller is our own vendored
        // renderer: the request is `.strict()` upstream and the daemon answers a
        // 400 for a malformed one, which surfaces far from the caller.
        const parsed = LocalMachineRpcRequestSchema.safeParse(args[0]);
        if (!parsed.success) return { ok: false, error: "lody_machine_rpc_invalid_request" };
        // SAFETY: the daemon's own `.strict()` request schema just accepted this
        // object, so it carries the fields named on our side of the seam.
        const request = parsed.data as LodyMachineRpcRequest;
        return await sendMachineRpc(endpoints, request);
      }

      case "sessionControl.send": {
        const payload = args[0];
        if (payload === undefined || !isJsonObject(payload)) {
          return { ok: false, error: "lody_session_control_invalid_request" };
        }
        const rawId = payload.requestId;
        const message = LocalSessionControlRequestSchema.safeParse(payload.message);
        if (rawId === undefined || !isJsonString(rawId) || !message.success) {
          return { ok: false, error: "lody_session_control_invalid_request" };
        }
        const requestId = rawId;
        // SAFETY: the daemon's own request union just accepted this object, and
        // every member carries the `type` discriminant our side names.
        const request = message.data as LodySessionControlMessage;
        // Electron pushes each response as it streams; `/session-control`
        // answers the whole batch at the end, so replay it through the push
        // channel BEFORE resolving — `sendLocalSessionControl` unsubscribes in
        // its `finally`, so a response emitted after this resolves is lost.
        return await sendSessionControl(endpoints, request, (response) => {
          for (const listener of listeners.sessionControlResponse) {
            listener({ requestId, response });
          }
        });
      }

      case "localProjects.control": {
        const parsed = LocalProjectControlRequestSchema.safeParse(args[0]);
        if (!parsed.success) {
          return {
            ok: false,
            type: "local-project/list",
            error: "invalid_request",
            message: "lody_project_control_invalid_request",
          };
        }
        // SAFETY: as above — the request union's schema accepted it, so the
        // `type` discriminant this side reads is present.
        const request = parsed.data as LodyProjectControlRequest;
        return await sendProjectControl(endpoints, request);
      }

      // The positional `localProjects.*` helpers. Electron's service builds a
      // `LocalProjectControlRequest` from loose arguments and unwraps the
      // result; ours reproduces the same request bodies and the same unwrapping.
      case "localProjects.getGitState":
        return await projectResult(
          "local-project/git-state",
          { workspaceId: args[0], localProjectId: args[1] },
          "error",
        );
      case "localProjects.listFiles":
        return await projectResult(
          "local-project/list-files",
          { workspaceId: args[0], localProjectId: args[1], maxFiles: optionNumber(args[2], "maxFiles") },
          "throw",
        );
      case "localProjects.listDir":
        return await projectResult(
          "local-project/list-dir",
          {
            workspaceId: args[0],
            localProjectId: args[1],
            relativePath: args[2],
            limit: optionNumber(args[3], "limit"),
          },
          "throw",
        );
      case "localProjects.readFile":
        return await projectResult(
          "local-project/read-file",
          {
            workspaceId: args[0],
            localProjectId: args[1],
            relativePath: args[2],
            maxBytes: optionNumber(args[3], "maxBytes"),
          },
          "null",
        );
      case "localProjects.listSessionWorktreeFiles":
        return await projectResult(
          "worktree/list-files",
          { repoFullName: args[0], sessionId: args[1], maxFiles: optionNumber(args[2], "maxFiles") },
          "throw",
        );
      case "localProjects.readSessionWorktreeFile":
        return await projectResult(
          "worktree/read-file",
          {
            repoFullName: args[0],
            sessionId: args[1],
            relativePath: args[2],
            maxBytes: optionNumber(args[3], "maxBytes"),
          },
          "null",
        );
      case "localProjects.checkoutBranch":
        return await projectResult(
          "local-project/checkout-branch",
          { workspaceId: args[0], localProjectId: args[1], branchName: args[2] },
          "success",
        );

      default:
        recordUnsupported(channel);
        throw new Error(`${UNSUPPORTED_CHANNEL}: ${channel}`);
    }
  };

  const send = (channel: string, payload?: LodyIpcSendPayload): void => {
    switch (channel) {
      case "loro.subscribe":
        openDataPlane();
        return;
      case "loro.send": {
        const parsed = LocalLoroDataPlaneClientMessageSchema.safeParse(payload);
        if (!parsed.success) return;
        // SAFETY: the protocol-v7 client-message union just accepted this
        // frame, so it carries the `type` and `protocolVersion` our side names.
        const frame = parsed.data as LodyDataPlaneFrame;
        openDataPlane().connection.send(frame);
        return;
      }
      default:
        recordUnsupported(channel);
    }
  };

  const on = (channel: string, listener: (payload: LodyIpcPush) => void): (() => void) => {
    switch (channel) {
      case "loro.event": {
        listeners.loroEvent.add(listener);
        return () => listeners.loroEvent.delete(listener);
      }
      case "loro.status": {
        listeners.loroStatus.add(listener);
        return () => listeners.loroStatus.delete(listener);
      }
      case "sessionControl.response": {
        listeners.sessionControlResponse.add(listener);
        return () => listeners.sessionControlResponse.delete(listener);
      }
      default:
        recordUnsupported(channel);
        return () => {};
    }
  };

  return {
    ipc: { invoke, on, send },
    dataPlaneStats: () =>
      dataPlane?.stats() ?? {
        unparseable: 0,
        rejected: 0,
        oversizedOutbound: 0,
        oversizedInbound: 0,
        redials: 0,
      },
    unsupportedChannels: () => [...unsupported],
    dispose: () => {
      unsubscribeMessages?.();
      unsubscribeStatus?.();
      dataPlane?.dispose();
      dataPlane = null;
      listeners.loroEvent.clear();
      listeners.loroStatus.clear();
      listeners.sessionControlResponse.clear();
    },
  };
}

/** Reads one numeric field out of a vendored options bag. */
function optionNumber(options: LodyIpcArgument, key: string): number | undefined {
  if (options === undefined || !isJsonObject(options)) return undefined;
  const value = options[key];
  return value !== undefined && isJsonNumber(value) ? value : undefined;
}

/**
 * Installs the bridge on `window` and returns a disposer that removes it.
 *
 * `window.__LODY_LOCAL_BRIDGE__` is what the five patched guards in
 * `vendor/lody` read. It is set here rather than at module load so the flag can
 * gate it: with Lody sessions off, no global is touched and no socket is opened.
 *
 * The default target is the DOM `window`, not `globalThis`: this module only
 * ever runs in a browser (it loads behind the Lody flag from the webapp entry,
 * and the exit test runs it under jsdom), and taking `window` directly keeps the
 * declared type honest instead of asserting `globalThis` into it.
 */
export function installLodyLocalBridge(
  bridge: LodyLocalBridge,
  target: Window & typeof globalThis = window,
): () => void {
  target.ipc = bridge.ipc;
  target.__LODY_LOCAL_BRIDGE__ = true;
  return () => {
    delete target.ipc;
    delete target.__LODY_LOCAL_BRIDGE__;
    bridge.dispose();
  };
}

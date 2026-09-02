/**
 * `window.ipc`, backed by the box gateway instead of Electron
 * (plans/LODY-RUNTIME-DESIGN.md §2.1).
 *
 * THE TRANSPORT SHAPE IS ELECTRON'S IPC SEAM. `createLodyIpcProxy` dispatches
 * `groupName.methodName` by string, so nothing about the bridge itself is
 * Electron-specific. A `SessionSurface` now captures this object in a bound IPC
 * client and injects that authority into its renderer subtree. The active
 * surface still installs `window.ipc` for unchanged Electron/default callers,
 * but it is no longer the authority used by a Blitz runtime after construction;
 * see seam patch 18.
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
import { isJsonArray, isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "@blitzos/schema";
import { FILES_DAV_ROOT } from "../resolver.js";
import { LocalLoroDataPlaneClientMessageSchema } from "@lody/shared/local-loro-data-plane";
import { LocalMachineRpcRequestSchema } from "@lody/shared/local-machine-rpc";
import { LocalProjectControlRequestSchema, LocalSessionControlRequestSchema } from "@lody/shared/message-schemas";
import {
  createLodyDataPlaneConnection,
  type LodyDataPlaneContinuityEvent,
  type LodyDataPlaneConnectionHandle,
  type LodyDataPlaneStats,
} from "./data-plane-connection.js";
import {
  fetchLodyPlatformSnapshot,
  type LodyPlatformFetchOptions,
  type LodyPlatformSnapshot,
} from "./platform-snapshot.js";
import {
  sendMachineRpc,
  sendProjectControl,
  sendSessionControl,
  type LodyHttpPlaneEndpoints,
} from "./rpc-client.js";
import {
  isSendSessionFileLocalInput,
  removeSessionAttachments,
  uploadSessionAttachments,
  type LodyAttachmentEndpoints,
} from "./session-attachments.js";
import type {
  LodyDataPlaneFrame,
  LodyIpcArgument,
  LodyIpcPush,
  LodyIpcReply,
  LodyIpcSendPayload,
  LodyMachineRpcRequest,
  LodyProjectControlRequest,
  LodyProjectControlResponse,
  LodySendSessionFileLocalInput,
  LodySessionControlMessage,
  LodySessionControlPush,
} from "./wire-types.js";

/** Rejection code for any channel outside the allowlist. */
export const UNSUPPORTED_CHANNEL = "lody_ipc_channel_unsupported";

/**
 * WHERE THE "Add a local project" FOLDER BROWSER OPENS.
 *
 * `useRemoteDirectoryPicker` browses to `listRoots().homeDir` the moment a
 * machine is chosen (`use-remote-directory-picker.ts:241`), and that is the ONLY
 * reader of the field in the whole renderer. The daemon answers it with
 * `os.homedir()` (`local-project-control-service.ts:298`), which on a box is
 * `/var/lib/blitz/home` — the s6 service's `HOME`
 * (`rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run`). So the picker opened on the
 * daemon's state directory, which holds one folder and none of the member's
 * repositories, and the member had to type a path to get anywhere.
 *
 * The daemon's answer is CORRECT and must stay correct: `HOME` is where it keeps
 * its data dir, its `.lody` skills path (`:1284`, `:1322`) and its agent
 * credentials, and moving it would move all three
 * (plans/LODY-RUNTIME-DESIGN.md §2.3). What is wrong is only which directory a
 * BOX should open a project picker at, and that is a fact about the box, not
 * about the daemon — so it is answered here, on the way back through the seam
 * that already turns Electron's IPC into box calls.
 *
 * Every other `local-project/*` response passes through untouched.
 */
export function withBoxBrowseRoot(
  request: LodyProjectControlRequest,
  response: LodyProjectControlResponse,
  workspaceRoot: string,
): LodyProjectControlResponse {
  if (request.type !== "local-project/list-roots") return response;
  if (!response.ok || response.type !== "local-project/list-roots") return response;
  if (!isJsonObject(response.result)) return response;
  return { ...response, result: { ...response.result, homeDir: workspaceRoot } };
}

type IpcBridge = NonNullable<Window["ipc"]>;

export interface LodyLocalBridge {
  /** Captured by the surface client and also installed at `window.ipc` for
   * compatibility. Exposed for tests that drive it without touching globals. */
  ipc: IpcBridge;
  /** Data-plane counters, for the phase-3 assertion that nothing is dropped. */
  dataPlaneStats: () => LodyDataPlaneStats;
  /** Every channel a caller asked for that this bridge does not serve. */
  unsupportedChannels: () => readonly string[];
  dispose: () => void;
}

export interface LodyLocalBridgeEndpoints extends LodyHttpPlaneEndpoints {
  syncUrl: string;
  /** `BoxEndpoints.filesBase` — where `+` attachments are staged before the
   * daemon copies them into its blob store. */
  filesBase: string;
  /** The box path `filesBase` serves; see `LodyAttachmentEndpoints`. */
  filesRoot?: string;
  webSocketConstructor?: typeof WebSocket;
  /** The retained surface must revalidate or evict after any broken link. */
  onContinuity?: (event: LodyBridgeContinuityEvent) => void;
}

export type LodyBridgeContinuityEvent = LodyDataPlaneContinuityEvent | "identity-change";

interface PushListeners {
  loroEvent: Set<(payload: LodyDataPlaneFrame) => void>;
  loroStatus: Set<(payload: boolean) => void>;
  sessionControlResponse: Set<(payload: LodySessionControlPush) => void>;
}

/** How `local-projects-ipc.ts` reports a failure on each helper. The four
 * conventions are not interchangeable: each has a caller written against it. */
type ProjectFailureStyle = "error" | "throw" | "null" | "success";

/**
 * Builds the bridge. `publishLodyLocalBridge` or the compatibility installer
 * puts it on `window`; a test can hold it instead.
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
  let disposed = false;

  const openDataPlane = (): LodyDataPlaneConnectionHandle => {
    if (dataPlane !== null) return dataPlane;
    const connectionOptions = endpoints.webSocketConstructor === undefined
      ? { url: endpoints.syncUrl }
      : { url: endpoints.syncUrl, webSocketConstructor: endpoints.webSocketConstructor };
    const handle = createLodyDataPlaneConnection({
      ...connectionOptions,
      onContinuity: (event) => endpoints.onContinuity?.(event),
    });
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

  /**
   * The box's machineId, resolved once and remembered.
   *
   * EVERY positional helper below needs it and NONE of their callers pass it:
   * `requestLocalProjectGitState` (`workspace-machine-rpc-facade.ts:1006`) calls
   * `localProjects.getGitState(workspaceId, localProjectId)` with two arguments,
   * because in Electron the MAIN process is the machine and fills its own id in.
   * Here the main process is the box, and the browser learns its id from
   * `/lody/platform` — the same door `localPlatform.getSnapshot` reads. Without
   * this every one of those requests fails the daemon's `.strict()` schema at
   * the boundary, and the landing's branch picker sits on "Checking whether this
   * project is a git repository" forever.
   *
   * Cached rather than re-fetched: the id is minted once by the daemon and
   * cannot change while the surface is mounted. A failed read is NOT cached, so
   * a call made before the daemon has written its catalog retries on the next
   * one.
   */
  let machineId: string | null = null;
  let daemonIdentity: string | null = null;
  const observeIdentity = (snapshot: LodyPlatformSnapshot): void => {
    const next = `${snapshot.machineId}\u0000${snapshot.workspace.workspaceId}`;
    if (daemonIdentity !== null && daemonIdentity !== next) {
      endpoints.onContinuity?.("identity-change");
    }
    daemonIdentity = next;
  };
  async function resolveMachineId(): Promise<string | null> {
    if (machineId !== null) return machineId;
    const options: LodyPlatformFetchOptions = {};
    if (endpoints.fetchImpl !== undefined) options.fetchImpl = endpoints.fetchImpl;
    try {
      const snapshot = await fetchLodyPlatformSnapshot(endpoints.platformUrl, options);
      if (snapshot !== null) observeIdentity(snapshot);
      machineId = snapshot?.machineId ?? null;
    } catch {
      // Not cached: a transport failure before the daemon has written its
      // catalog must not make every later call fail too.
      return null;
    }
    return machineId;
  }

  /** One `local-project/*` or `worktree/*` request and one unwrap, mirroring
   * `apps/electron/src/main/ipc/services/local-projects-ipc.ts` field for field.
   * The four failure styles are that file's, reproduced because the callers in
   * `@lody/components` are written against those return shapes rather than
   * against the raw response union. */
  async function projectResult(
    type: string,
    fields: Record<string, LodyIpcArgument>,
    onError: ProjectFailureStyle,
  ): Promise<LodyIpcReply> {
    const machine = await resolveMachineId();
    if (machine === null) return projectFailure(onError, "cli_not_running");
    const entries: [string, LodyIpcArgument][] = [["type", type], ["machineId", machine]];
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

  const attachmentEndpoints = (): LodyAttachmentEndpoints => {
    const attachment: LodyAttachmentEndpoints = { filesBase: endpoints.filesBase };
    if (endpoints.filesRoot !== undefined) attachment.filesRoot = endpoints.filesRoot;
    if (endpoints.fetchImpl !== undefined) attachment.fetchImpl = endpoints.fetchImpl;
    return attachment;
  };

  /** The second half of the attachment handoff: the paths are on the box, so
   * this is the same `session/file-send-local` call Electron's main process
   * makes, and the same unwrapping (`local-projects-ipc.ts:100`). */
  async function handoffStagedAttachments(
    input: LodySendSessionFileLocalInput,
    paths: readonly string[],
  ): Promise<LodyIpcReply> {
    const parsed = LocalSessionControlRequestSchema.safeParse({
      type: "session/file-send-local",
      machineId: input.machineId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      paths: [...paths],
    });
    if (!parsed.success) return { ok: false, error: "invalid_request" };
    // SAFETY: the daemon's own request union just accepted this object, and
    // every member of it carries the `type` discriminant our side reads.
    const request = parsed.data as LodySessionControlMessage;
    const result = await sendSessionControl(endpoints, request, () => {});
    if (!result.ok) return { ok: false, error: result.error };
    const response = result.responses.find(
      (item) => item.type === "session/file-send-local_response",
    );
    if (response === undefined) return { ok: false, error: "invalid_response" };
    if (response.success !== true) {
      const reason = response.error;
      const named = reason !== undefined && isJsonString(reason);
      return { ok: false, error: named ? reason : "local_handoff_failed" };
    }
    const files = response.files;
    if (files === undefined || !isJsonArray(files) || files.length === 0) {
      return { ok: false, error: "local_handoff_empty" };
    }
    const note = response.message;
    return note !== undefined && isJsonString(note)
      ? { ok: true, files, message: note }
      : { ok: true, files };
  }

  const invoke = async (channel: string, ...args: LodyIpcArgument[]): Promise<LodyIpcReply> => {
    if (disposed) throw new Error("lody_ipc_bridge_disposed");
    switch (channel) {
      case "loro.isConnected":
        return dataPlane?.connection.isConnected() ?? false;

      // Accepted and ignored. `theme-provider.tsx:155` calls it on every theme
      // change with no Electron guard at all, and it asks the MAIN PROCESS to
      // repaint the OS window chrome — a browser has no window chrome to
      // repaint. Rejecting it produced an unhandled rejection on every mount
      // (design-doc risk 10, seen for real in the phase-3 exit test), and
      // guarding the call site would be a vendor edit outside the declared
      // seams. `null` is what `ipcMain.handle` returns for a void handler.
      case "app.setNativeTheme":
        return null;

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
          observeIdentity(snapshot);
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
        const payload = jsonArgument(args[0]);
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
        // Electron pushes each response as it streams, and so does this: the
        // POST negotiates the daemon's NDJSON stream and `sendSessionControl`
        // calls back per frame (`rpc-client.ts`). The push must happen BEFORE
        // this resolves either way — `sendLocalSessionControl` unsubscribes in
        // its `finally`, so a response emitted after that is lost. That
        // ordering is what carries `machine/acp-authentication-progress`, the
        // only frame the Claude sign-in URL ever travels in.
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
        return withBoxBrowseRoot(
          request,
          await sendProjectControl(endpoints, request),
          endpoints.filesRoot ?? FILES_DAV_ROOT,
        );
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
      // The `+` attachment handoff (plans/LODY-RUNTIME-DESIGN.md §10.4). Where
      // Electron writes the bytes to a temp file the daemon then reads, this
      // stages them on the box over WebDAV and hands the daemon those paths —
      // the daemon copies each into its blob store and answers with the
      // `transport: 'local'` blocks the composer attaches to the message.
      case "localProjects.sendSessionFileLocal": {
        const input = args[0];
        if (!isSendSessionFileLocalInput(input)) return { ok: false, error: "invalid_request" };
        const staged = await uploadSessionAttachments(
          attachmentEndpoints(),
          input.sessionId,
          input.files,
        );
        if (!staged.ok) return { ok: false, error: staged.error };
        try {
          return await handoffStagedAttachments(input, staged.paths);
        } finally {
          // The daemon has copied the bytes by now, so the staging directory is
          // rubbish whether the handoff succeeded or the daemon refused it —
          // which is why this is a `finally` and not a success branch.
          await removeSessionAttachments(attachmentEndpoints(), staged.staged);
        }
      }

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
    if (disposed) return;
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
    if (disposed) return () => {};
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

      // Accepted and never fired, the subscribe half of `app.setNativeTheme`
      // above. Electron's main process pushes the OS-resolved theme here
      // (`theme-provider.tsx:139`); a browser has no such push, and their own
      // fallback for its absence is `prefers-color-scheme`, which is the right
      // answer. Accepting it keeps the unsupported-channel set — which the
      // phase-3 exit test asserts is empty — meaningful.
      case "app.nativeTheme":
        return () => {};
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
      if (disposed) return;
      disposed = true;
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

/**
 * Every channel but the attachment handoff takes JSON. This narrows to that by
 * EXCLUDING the one arm that is not, so the widening `LodyIpcArgument` took for
 * `sendSessionFileLocal` costs no assertion anywhere else.
 */
function jsonArgument(value: LodyIpcArgument): JsonValue | undefined {
  return isSendSessionFileLocalInput(value) ? undefined : value;
}

/** Reads one numeric field out of a vendored options bag. */
function optionNumber(options: LodyIpcArgument, key: string): number | undefined {
  const bag = jsonArgument(options);
  if (bag === undefined || !isJsonObject(bag)) return undefined;
  const value = bag[key];
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
  const unpublish = publishLodyLocalBridge(bridge, target);
  return () => {
    unpublish();
    bridge.dispose();
  };
}

/** Publishes compatibility globals without owning the bridge's lifetime. */
export function publishLodyLocalBridge(
  bridge: LodyLocalBridge,
  target: Window & typeof globalThis = window,
): () => void {
  target.ipc = bridge.ipc;
  target.__LODY_LOCAL_BRIDGE__ = true;
  return () => {
    // ONLY CLEAR THE GLOBAL IF IT IS STILL OURS.
    //
    // `window.ipc` is a singleton and activation HANDS IT OVER between retained
    // surfaces. React may publish the incoming bridge before the outgoing
    // layout-effect cleanup runs; an unconditional delete would then remove the
    // incoming owner and leave compatibility callers with no bridge.
    if (target.ipc === bridge.ipc) {
      delete target.ipc;
      delete target.__LODY_LOCAL_BRIDGE__;
    }
  };
}

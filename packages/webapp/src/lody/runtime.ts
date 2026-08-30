/**
 * The Lody workspace runtime, assembled for a BlitzOS box
 * (plans/LODY-RUNTIME-DESIGN.md §1.1, §2, §3).
 *
 * `createWorkspaceRuntime` takes no platform object. It takes `syncMode`, and
 * everything else about "which plane" follows from that:
 *
 * - `syncMode: 'local'` sets `cloudPlaneEnabled = false`
 *   (`create-workspace-runtime.ts:445`): no Streams member, no token provider,
 *   no cloud presence, no cloud RPC. Zero cloud I/O is a construction property,
 *   not a configuration one.
 * - It also makes `WorkspaceTargetRouter.getPlaneForMachine` answer `'local'`
 *   for every machine immediately (`workspace-target-router.ts:174`), with no
 *   machine-meta probe and no identity wait. That answers design-doc risk 3:
 *   `useVisibleMachineMetas` returning nothing cannot strand the box, because
 *   nothing consults it on this path.
 * - And it makes the local data plane MANDATORY: boot attaches it and THROWS
 *   `local_loro_data_plane_bridge_unavailable` if `window.ipc` is missing
 *   (`:2679`). So the bridge is installed before the runtime is created, never
 *   after.
 *
 * `apiBaseUrl` is required by the type but unreachable in this mode — every
 * caller of it sits behind `cloudPlaneEnabled`. It is set to the loopback
 * address that refuses connections rather than to a real origin, so a future
 * upstream call site that escapes the gate fails loudly instead of reaching a
 * BlitzOS API by accident.
 */
import type { JsonObject, JsonValue } from "@blitzos/schema";
import { createStore } from "jotai";
import { createWorkspaceRuntime } from "@lody/components/providers/create-workspace-runtime";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { setWorkspaceContextAtom } from "@lody/components/atoms/workspace-context";
import {
  createLodyLocalBridge,
  installLodyLocalBridge,
  type LodyLocalBridge,
  type LodyLocalBridgeEndpoints,
} from "./local-bridge.js";
import type { LodyPlatformSnapshot } from "./platform-snapshot.js";
import type { LodySessionDocState } from "./wire-types.js";

/** Unreachable by construction; see the module comment. */
const NO_CLOUD_API_BASE_URL = "http://127.0.0.1:1";

export interface LodyRuntimeEndpoints {
  syncUrl: string;
  rpcUrl: string;
  controlUrl: string;
  projectUrl: string;
  platformUrl: string;
  fetchImpl?: typeof fetch;
  webSocketConstructor?: typeof WebSocket;
}

export interface LodyRuntimeHandle {
  /** The vendored `WorkspaceRuntime`, seen through the narrow contract below.
   * `vendor-modules.d.ts` keeps the vendor tree out of our typecheck on purpose,
   * so the shape is stated on this side rather than imported. */
  runtime: LodyWorkspaceRuntime;
  bridge: LodyLocalBridge;
  /** Tears down the runtime, the bridge and the `window` globals, in that
   * order. Reversed, the runtime's dispose path would find no `window.ipc`. */
  dispose: () => Promise<void>;
}

/** The slice of the vendored runtime this package actually calls. Hand-written
 * because the vendor seam is untyped; every member here is checked against
 * `vendor/lody/packages/components/src/atoms/runtime.ts`. */
export interface LodyDispatchArgs {
  sessionId: string;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: JsonObject;
}

/** The renderer's authored-write seam
 * (`vendor/lody/packages/components/src/providers/workspace-writer.ts:12`). */
export interface LodyWorkspaceWriter {
  startSession(
    sessionId: string,
    meta: JsonObject,
    entry: JsonObject,
    dispatch: LodyDispatchArgs,
  ): Promise<void>;
  upsertDocMeta(roomId: string, patch: JsonObject): Promise<void>;
  flockRowPut(flockDocId: string, key: readonly string[], value: JsonValue): Promise<void>;
}

/** The mirrored session document store `withSessionStore` hands to its callback. */
export interface LodySessionStore {
  getState(): LodySessionDocState;
}

export interface LodyWorkspaceRuntime {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly writer: LodyWorkspaceWriter;
  setLocalMachineId(machineId: string | null): void;
  resolveMachineTargetPlane(machineId: string, options?: { timeoutMs?: number }): Promise<"local" | "cloud">;
  requestSessionDispatchTurn(
    machineId: string,
    args: LodyDispatchArgs,
    options?: { timeoutMs?: number },
  ): Promise<JsonValue>;
  ensureDocStream(roomId: string): Promise<void>;
  withSessionStore<T>(sessionId: string, fn: (store: LodySessionStore) => T | Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

/**
 * Installs the bridge, then builds the runtime on top of it.
 *
 * `setLocalMachineId` is called with the daemon's own machineId even though
 * local-only mode does not need it to route: it is what makes the router's
 * `rememberSessionTarget` bookkeeping name the right machine, and it costs one
 * call. The id comes from `/lody/platform` (design-doc risk 4) — the browser
 * cannot mint it, and the agent-config bootstrap keys rows by it.
 */
export async function createLodyRuntime(options: {
  endpoints: LodyRuntimeEndpoints;
  snapshot: LodyPlatformSnapshot;
  /** Set `false` in a test that wants the bridge without touching `window`. */
  installGlobals?: boolean;
}): Promise<LodyRuntimeHandle> {
  const { endpoints, snapshot } = options;
  const bridgeEndpoints: LodyLocalBridgeEndpoints = {
    syncUrl: endpoints.syncUrl,
    rpcUrl: endpoints.rpcUrl,
    controlUrl: endpoints.controlUrl,
    projectUrl: endpoints.projectUrl,
    platformUrl: endpoints.platformUrl,
  };
  if (endpoints.fetchImpl !== undefined) bridgeEndpoints.fetchImpl = endpoints.fetchImpl;
  if (endpoints.webSocketConstructor !== undefined) {
    bridgeEndpoints.webSocketConstructor = endpoints.webSocketConstructor;
  }
  const bridge = createLodyLocalBridge(bridgeEndpoints);
  const uninstall = options.installGlobals === false ? () => bridge.dispose() : installLodyLocalBridge(bridge);

  let runtime: LodyWorkspaceRuntime;
  try {
    // SAFETY: `createWorkspaceRuntime` is untyped across the vendor seam
    // (`vendor-modules.d.ts`). Every member of `LodyWorkspaceRuntime` is checked
    // by hand against `vendor/lody/packages/components/src/atoms/runtime.ts`, and
    // the phase-2 exit test calls each of them against a real daemon.
    runtime = (await createWorkspaceRuntime({
      workspaceSlug: snapshot.workspace.slug ?? "local",
      workspaceId: snapshot.workspace.workspaceId,
      apiBaseUrl: NO_CLOUD_API_BASE_URL,
      syncMode: "local",
      eagerSyncSurface: "web",
    })) as LodyWorkspaceRuntime;
  } catch (cause) {
    uninstall();
    throw cause;
  }
  runtime.setLocalMachineId(snapshot.machineId);

  return {
    runtime,
    bridge,
    dispose: async () => {
      await runtime.dispose();
      uninstall();
    },
  };
}

/** The jotai store the vendored atoms are read and written in.
 *
 * Jotai's own store type, not a hand-written narrowing: the atoms crossing this
 * seam are `any` (see `vendor-modules.d.ts`), and a narrower local interface
 * would only fail to accept the real `createStore()` result. */
export type LodyAtomStore = ReturnType<typeof createStore>;

/**
 * Publishes the runtime into the atoms every vendored hook reads.
 *
 * `activeWorkspaceRuntimeAtom` (`atoms/runtime.ts:515`) is derived, and it
 * answers `null` unless the runtime AND the workspace context agree
 * (`resolveActiveWorkspaceRuntimeState`, `:470`): a slug mismatch resolves to
 * `stale`, not `ready`, and every command atom then throws `Runtime not ready`.
 * So both are set here, in that order.
 *
 * The context goes through `setWorkspaceContextAtom` as ONE call
 * (`atoms/workspace-context.ts:21`). Never set `currentWorkspaceIdAtom` and
 * `currentWorkspaceSlugAtom` separately — those compatibility setters clear each
 * other, so the second would erase the first.
 */
export function mountLodyRuntimeAtoms(store: LodyAtomStore, runtime: LodyWorkspaceRuntime): void {
  store.set(runtimeAtom, runtime);
  store.set(setWorkspaceContextAtom, {
    slug: runtime.workspaceSlug,
    workspaceId: runtime.workspaceId,
  });
}

/** Drops the runtime from the atoms. Call before `dispose`, so nothing reads a
 * runtime whose repo is closing. */
export function unmountLodyRuntimeAtoms(store: LodyAtomStore): void {
  store.set(runtimeAtom, null);
}

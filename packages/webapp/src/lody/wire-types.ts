/**
 * The BlitzOS side of the vendor type seam.
 *
 * `vendor-modules.d.ts` declares `@lody/*` as SHORTHAND ambient modules, so
 * TypeScript reads every name imported from them as a namespace, not a type:
 * `import type { LocalMachineRpcRequest } from "@lody/shared"` is a compile
 * error the moment it is used in a type position ("Cannot use namespace ... as a
 * type"). Typechecking the vendor tree instead would mean adopting their ~140
 * dependencies and their compiler options, and would turn every upstream merge
 * into a type-repair job on code we do not own — that trade is `vendor-bridge`'s
 * whole premise and it still holds.
 *
 * So the contracts are stated HERE, deliberately narrow. Each one names only the
 * fields BlitzOS code actually reads, and the real shapes are enforced at
 * RUNTIME by Lody's own zod schemas at every boundary — which is stronger than a
 * hand-copied structural type would be, because a copy drifts silently while a
 * schema rejects loudly. `packages/schema/fixtures/lody-data-plane/` pins the
 * frame half of that so an upstream change fails a test rather than a session.
 *
 * Everything on these wires is JSON, so `JsonValue` is the value type
 * throughout. A frame body stays open on purpose: our code ROUTES frames, it
 * does not interpret them — the transport adapter above and the daemon below are
 * both Lody's, and a fuller union here would be a second source of truth for a
 * protocol we do not own.
 */
import type { JsonValue } from "@blitzos/schema";

/** A JSON object whose optional properties may be absent.
 *
 * `JsonObject`'s index signature is `JsonValue`, which TypeScript refuses to
 * reconcile with an optional property (TS2411): `timeoutMs?: number` widens to
 * `number | undefined`, and `undefined` is not a JSON value. This admits the
 * absence, which is what an optional wire field means. */
export interface LodyRecord {
  [field: string]: JsonValue | undefined;
}

/** One protocol-v7 frame in either direction, as far as this package cares.
 *
 * `protocolVersion` is a `z.literal(7)` on every frame upstream and is the gate
 * that rejects a skewed peer at parse time, so it is named here even though
 * nothing on this side branches on it. */
export interface LodyDataPlaneFrame extends LodyRecord {
  readonly type: string;
}

/**
 * The four-method seam declared at
 * `vendor/lody/packages/shared/src/local-loro-transport.ts:44`.
 * `LocalLoroTransportAdapter` consumes exactly this and nothing else, which is
 * what lets the adapter be used unchanged.
 */
export interface LodyDataPlaneConnection {
  send: (message: LodyDataPlaneFrame) => void;
  onMessage: (listener: (message: LodyDataPlaneFrame) => void) => () => void;
  onStatusChange: (listener: (connected: boolean) => void) => () => void;
  isConnected: () => boolean;
}

/** `LocalMachineRpcRequest` — `.strict()` upstream and discriminated on
 * `method` (`vendor/lody/packages/shared/src/local-machine-rpc.ts:44`). */
export interface LodyMachineRpcRequest extends LodyRecord {
  readonly machineId: string;
  readonly workspaceId: string;
  readonly method: string;
  readonly timeoutMs?: number | undefined;
}

/** `SendLocalMachineRpcResult`. The facade turns a non-ok into a retryable
 * `transient_io` Code Collab error, so the `ok: false` arm is load-bearing. */
export type LodyMachineRpcResult =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string };

/** `LocalSessionControlRequest` / `...Response`, discriminated on `type`. */
export interface LodySessionControlMessage extends LodyRecord {
  readonly type: string;
}

/** `SendLocalSessionControlResult`. */
export type LodySessionControlResult =
  | { ok: true; responses: LodySessionControlMessage[] }
  | { ok: false; error: string };

/** `LocalProjectControlRequest`, discriminated on `type`. */
export interface LodyProjectControlRequest extends LodyRecord {
  readonly type: string;
}

/** `LocalProjectControlResponse`'s union. */
export type LodyProjectControlResponse =
  | { ok: true; type: string; result: JsonValue }
  | { ok: false; type: string; error: string; message: string; data?: JsonValue };

/** Every request body one of the three HTTP planes accepts. */
export type LodyPlaneRequest =
  | LodyMachineRpcRequest
  | LodySessionControlMessage
  | LodyProjectControlRequest;

/** `ElectronLocalPlatformSnapshot` (`@lody/shared/electron-ipc:646`) — what the
 * `localPlatform.getSnapshot` channel must answer with. */
export interface LodyElectronPlatformSnapshot {
  userId: string;
  workspace: { workspaceId: string; name: string; slug: string | null; role: string };
}

/** One response replayed through the `sessionControl.response` push channel. */
export interface LodySessionControlPush {
  requestId: string;
  response: LodySessionControlMessage;
}

/** Everything `window.ipc.invoke` may resolve to across the allowlist. */
export type LodyIpcReply =
  | boolean
  | JsonValue
  | LodyElectronPlatformSnapshot
  | LodyMachineRpcResult
  | LodySessionControlResult
  | LodyProjectControlResponse
  | { success: false; error: string }
  | { error: string };

/** Everything the `on(...)` push channels deliver. */
export type LodyIpcPush = LodyDataPlaneFrame | boolean | LodySessionControlPush;

/** Everything `window.ipc.send` accepts. */
export type LodyIpcSendPayload = LodyDataPlaneFrame | null;

/** `SendSessionFileLocalInput` (`@lody/shared/electron-ipc:511`).
 *
 * The one channel argument that is not JSON. `bytes` rides Electron's structured
 * clone so an attachment is never base64'd through IPC; here it rides a WebDAV
 * PUT body, which does not encode it either. */
export interface LodySendSessionFileLocalInput {
  workspaceId: string;
  sessionId: string;
  machineId: string;
  files: { fileName: string; bytes: ArrayBuffer }[];
}

/** Every argument `window.ipc.invoke` is called with. The positional
 * `localProjects.*` helpers take loose strings and option bags, so this is the
 * union of what those call sites actually pass. */
export type LodyIpcArgument = JsonValue | LodySendSessionFileLocalInput | undefined;

/** The mirrored session document, as far as this package reads it. */
export interface LodySessionDocState extends LodyRecord {
  history?: JsonValue[] | undefined;
}

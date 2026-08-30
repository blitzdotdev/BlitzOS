/**
 * The browser half of the Lody daemon's three HTTP request planes
 * (plans/LODY-RUNTIME-DESIGN.md §3.2, §3.4).
 *
 * The daemon serves `/machine-rpc`, `/session-control` and `/project-control` on
 * one unix control socket; `blitz-lody-bridge` re-serves them as `/rpc`,
 * `/control` and `/project`, and the box gateway proxies those as `/lody/rpc`,
 * `/lody/control` and `/lody/project`. One POST per request, no multiplexing:
 * the daemon answers each call on its own connection and the browser needs no
 * correlation id of its own.
 *
 * WHAT THIS LAYER OWNS. The daemon's own reply shapes are Lody's — this parses
 * them with Lody's schemas and hands them back unchanged. What is ours is the
 * transport contract each caller depends on:
 *
 * - `machineRpc.send` must resolve to `LodyMachineRpcResult`, because the
 *   facade turns a non-ok into a RETRYABLE `transient_io` Code Collab error
 *   (`workspace-machine-rpc-facade.ts:88`). A network failure must therefore
 *   become `{ ok: false, error }`, never a rejected promise.
 * - `timeoutMs` rides in the request body for the daemon, and is enforced HERE
 *   too with an `AbortController`, because the bridge does not enforce it: a
 *   daemon that never answers would otherwise hang the caller forever.
 */
import { isJsonArray, isJsonObject, isJsonString, parseJson, type JsonValue } from "@blitzos/schema";
import { LocalMachineRpcResponseSchema } from "@lody/shared/local-machine-rpc";
import {
  LocalProjectControlResponseSchema,
  LocalSessionControlResponseSchema,
} from "@lody/shared/message-schemas";
import type {
  LodyMachineRpcRequest,
  LodyMachineRpcResult,
  LodyPlaneRequest,
  LodyProjectControlRequest,
  LodyProjectControlResponse,
  LodySessionControlMessage,
  LodySessionControlResult,
} from "./wire-types.js";

/** What a caller gets when the daemon never answers. Chosen to match the
 * daemon's own vocabulary so the facade's retry classification is unchanged. */
const TIMEOUT_ERROR = "lody_bridge_timeout";
const TRANSPORT_ERROR = "lody_bridge_unreachable";

/** Matches the daemon's own default for a machine RPC
 * (`workspace-machine-rpc-facade.ts` passes 30 s for previews, 120 s for project
 * control). Used only when a caller supplies none. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** `LOCAL_CONTROL_HEADER` from
 * `vendor/lody/packages/shared/src/node/local-ipc.ts:31`, inlined rather than
 * imported: that module is node-only (`node:net`, `node:http`) and pulling it
 * into a browser bundle for one string would drag the daemon's whole server
 * with it. */
const LOCAL_CONTROL_HEADER = "x-lody-local-control";

export interface LodyHttpPlaneEndpoints {
  /** `BoxEndpoints.lodyRpcUrl` */
  rpcUrl: string;
  /** `BoxEndpoints.lodyControlUrl` */
  controlUrl: string;
  /** `BoxEndpoints.lodyProjectUrl` */
  projectUrl: string;
  /** `BoxEndpoints.lodyPlatformUrl` */
  platformUrl: string;
  /** Injected in tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The one shape every door here answers with before parsing. A body that is not
 * JSON is a proxy or a gateway talking, not the daemon. */
export type LodyPlaneOutcome = { ok: true; body: JsonValue } | { ok: false; error: string };

export interface LodyPlaneCallOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Builds the call options without a conditional spread, so an absent timeout is
 * an absent property rather than an empty object merged in. */
function callOptions(
  endpoints: LodyHttpPlaneEndpoints,
  timeoutMs: number | undefined,
): LodyPlaneCallOptions {
  const call: LodyPlaneCallOptions = {};
  if (timeoutMs !== undefined) call.timeoutMs = timeoutMs;
  if (endpoints.fetchImpl !== undefined) call.fetchImpl = endpoints.fetchImpl;
  return call;
}

export async function postLodyPlane(
  url: string,
  body: LodyPlaneRequest,
  options: LodyPlaneCallOptions,
): Promise<LodyPlaneOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      // The daemon requires this header on every control-socket POST. The
      // bridge sets it too; sending it from here as well costs nothing and
      // keeps the browser's request legible next to the daemon's own logs.
      headers: { "content-type": "application/json", [LOCAL_CONTROL_HEADER]: "1" },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: "include",
    });
    const text = await response.text();
    const decoded = parseJson(text);
    // `parseJson` maps a parse failure to `null`, which is also a legal JSON
    // document. Neither door ever answers a bare `null`, so a `null` here is a
    // proxy or a gateway talking, not the daemon.
    if (decoded === null) return { ok: false, error: `lody_bridge_bad_json_${response.status}` };
    return { ok: true, body: decoded };
  } catch (cause) {
    return {
      ok: false,
      error: controller.signal.aborted ? TIMEOUT_ERROR : `${TRANSPORT_ERROR}: ${String(cause)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** `machineRpc.send` — the channel `workspace-machine-rpc-facade.ts:94` calls. */
export async function sendMachineRpc(
  endpoints: LodyHttpPlaneEndpoints,
  request: LodyMachineRpcRequest,
): Promise<LodyMachineRpcResult> {
  const outcome = await postLodyPlane(
    endpoints.rpcUrl,
    request,
    callOptions(endpoints, request.timeoutMs),
  );
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const parsed = LocalMachineRpcResponseSchema.safeParse(outcome.body);
  if (!parsed.success) return { ok: false, error: "lody_machine_rpc_unparseable_response" };
  // SAFETY: `LocalMachineRpcResponseSchema` is the daemon's own definition of
  // this union and it just accepted the body; the assertion only restates that
  // across the vendor type seam, where every `@lody/*` name is a namespace.
  return parsed.data as LodyMachineRpcResult;
}

/** The `/session-control` batch, as the daemon answers it. */
const SESSION_CONTROL_BATCH_ERROR = "lody_session_control_unparseable_response";

/**
 * `sessionControl.send` — but where Electron STREAMS each response through the
 * `sessionControl.response` push channel, `/session-control` answers
 * `{ ok, responses: [...] }` at the end of the whole batch. So the caller's
 * per-response listener is fed from the array before this resolves, which is the
 * order `sendLocalSessionControl`
 * (`vendor/lody/packages/components/src/lib/electron-ipc-client.ts:66`) depends
 * on: it registers its listener, awaits `send`, then unsubscribes in `finally`.
 *
 * `machine/acp-binary-progress` frames are lost by this shape. Nothing consumes
 * them here — an override-bearing agent config can never take the install path
 * (design doc §3.5) — so there is no progress to report.
 */
export async function sendSessionControl(
  endpoints: LodyHttpPlaneEndpoints,
  message: LodySessionControlMessage,
  emit: (response: LodySessionControlMessage) => void,
  options?: { timeoutMs?: number },
): Promise<LodySessionControlResult> {
  const outcome = await postLodyPlane(
    endpoints.controlUrl,
    message,
    callOptions(endpoints, options?.timeoutMs),
  );
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const envelope = outcome.body;
  if (!isJsonObject(envelope)) return { ok: false, error: SESSION_CONTROL_BATCH_ERROR };
  if (envelope.ok !== true) {
    const reason = envelope.error;
    const named = reason !== undefined && isJsonString(reason);
    return { ok: false, error: named ? reason : SESSION_CONTROL_BATCH_ERROR };
  }
  const batch = envelope.responses;
  if (batch === undefined || !isJsonArray(batch)) {
    return { ok: false, error: SESSION_CONTROL_BATCH_ERROR };
  }
  const responses: LodySessionControlMessage[] = [];
  for (const raw of batch) {
    const parsed = LocalSessionControlResponseSchema.safeParse(raw, { jitless: true });
    // A response type this build does not know is dropped, not fatal: the union
    // is versioned by the daemon and the renderer is pinned a few releases back
    // (plans/evidence/lody-phase1.md §11 skew).
    if (!parsed.success) continue;
    // SAFETY: the daemon's own response schema just accepted this element, and
    // every member of that union carries the `type` discriminant this side
    // reads; the assertion crosses the vendor type seam, not a check.
    const response = parsed.data as LodySessionControlMessage;
    responses.push(response);
    emit(response);
  }
  return { ok: true, responses };
}

/** `localProjects.control` — the generic door every `local-project/*` and
 * `worktree/*` request goes through (design doc §3.3: these are NOT machine-RPC
 * methods). */
export async function sendProjectControl(
  endpoints: LodyHttpPlaneEndpoints,
  request: LodyProjectControlRequest,
  options?: { timeoutMs?: number },
): Promise<LodyProjectControlResponse> {
  const outcome = await postLodyPlane(
    endpoints.projectUrl,
    request,
    callOptions(endpoints, options?.timeoutMs),
  );
  if (!outcome.ok) {
    return { ok: false, type: request.type, error: "execution_failed", message: outcome.error };
  }
  const parsed = LocalProjectControlResponseSchema.safeParse(outcome.body, { jitless: true });
  if (!parsed.success) {
    return {
      ok: false,
      type: request.type,
      error: "execution_failed",
      message: "lody_project_control_unparseable_response",
    };
  }
  // SAFETY: `LocalProjectControlResponseSchema` is the daemon's own union and it
  // just accepted the body; the assertion only restates that across the vendor
  // type seam.
  return parsed.data as LodyProjectControlResponse;
}

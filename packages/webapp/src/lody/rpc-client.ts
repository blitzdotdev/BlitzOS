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

/** `LOCAL_SESSION_CONTROL_STREAM_MEDIA_TYPE` from the same node-only module
 * (`local-ipc.ts:33`), inlined for the same reason. Sending it as `Accept` on
 * `/control` is what makes the daemon answer one NDJSON frame per response
 * instead of one JSON envelope at the end; `blitz-lody-bridge` re-sends it
 * upstream and pipes the frames back unbuffered. */
export const SESSION_CONTROL_STREAM_MEDIA_TYPE = "application/x-ndjson";

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
/** An NDJSON body whose frames are not the daemon's own frame union. */
const SESSION_CONTROL_STREAM_ERROR = "lody_session_control_unparseable_frame";
/** The daemon closed the stream without its `complete` frame. Distinct from a
 * frame it refused with, because it means the socket died mid-flow. */
const SESSION_CONTROL_TRUNCATED = "lody_session_control_stream_truncated";

/**
 * How long one session-control call may take, by request type.
 *
 * Lody's own numbers, from the composition that owns this call on the desktop
 * (`vendor/lody/apps/electron/src/main/services/cli-service.ts:74`). They are
 * copied rather than derived because they are a POLICY about how long each flow
 * legitimately runs, and `machine/acp-authenticate` is the one that matters
 * here: `claude auth login --claudeai` prints its authorization URL in a second
 * and then BLOCKS on stdin until the member pastes the code back, so the daemon
 * holds the request open for its own 285 s cap
 * (`apps/cli/src/agent/acp-authentication.ts:53`) and the panel waits 300 s for
 * the response. Our old flat 120 s default cut that flow in half.
 *
 * The FALLBACK stays at our own 120 s rather than taking their 10 s. Their
 * number is for a desktop talking to a daemon on the same machine; ours crosses
 * a Cloudflare Worker and a box gateway, and `session/create` cuts a git
 * worktree on the far side of it. Only the flows that provably need MORE time
 * are named here, so this function can lengthen a deadline and never shorten
 * one.
 */
export function sessionControlTimeoutMs(type: string): number {
  if (type === "machine/acp-authenticate" || type === "machine/acp-binary-install") return 300_000;
  return DEFAULT_TIMEOUT_MS;
}

/**
 * `sessionControl.send`, streamed.
 *
 * The daemon serves `/session-control` two ways and CHOOSES BY `Accept`
 * (`apps/cli/src/lib/local-session-control.ts:33`): with
 * `application/x-ndjson` it writes one `{kind:'response'}` frame per response as
 * the flow produces it and a `{kind:'complete'}` frame at the end; without it,
 * it buffers everything and answers one `{ ok, responses: [...] }` envelope
 * when the whole request has finished.
 *
 * We used to send no `Accept` at all, and `blitz-lody-bridge` replaced the
 * browser's headers with a fixed set that had none either — so every call took
 * the buffered path. For `session/create` that is invisible. For
 * `machine/acp-authenticate` it is the whole bug: the ONLY carrier of the
 * authorization URL is a `machine/acp-authentication-progress` response emitted
 * WHILE the login process is still running, and the buffered path cannot
 * deliver a response before the flow that is waiting for the user completes.
 * The panel opened its placeholder popup and nothing ever navigated it.
 *
 * So the frames are read as they arrive and `emit` is called per frame, which is
 * the order `sendLocalSessionControl`
 * (`vendor/lody/packages/components/src/lib/electron-ipc-client.ts:66`) is
 * written for: it registers its push listener, awaits `send`, and unsubscribes
 * in its `finally`. The full array is still returned, exactly as Electron's
 * service returns it — the vendored runtime de-duplicates a response it already
 * saw streamed (`create-workspace-runtime.ts:2109`).
 *
 * The buffered envelope is still parsed when the daemon answers with one, so a
 * box whose bridge predates this change degrades to the old behaviour instead of
 * failing.
 */
export async function sendSessionControl(
  endpoints: LodyHttpPlaneEndpoints,
  message: LodySessionControlMessage,
  emit: (response: LodySessionControlMessage) => void,
  options?: { timeoutMs?: number },
): Promise<LodySessionControlResult> {
  const fetchImpl = endpoints.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? sessionControlTimeoutMs(message.type),
  );
  try {
    const response = await fetchImpl(endpoints.controlUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: SESSION_CONTROL_STREAM_MEDIA_TYPE,
        [LOCAL_CONTROL_HEADER]: "1",
      },
      body: JSON.stringify(message),
      signal: controller.signal,
      credentials: "include",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = response.body;
    if (!contentType.startsWith(SESSION_CONTROL_STREAM_MEDIA_TYPE) || body === null) {
      return readSessionControlEnvelope(await response.text(), response.status, emit);
    }
    return await readSessionControlStream(body, emit);
  } catch (cause) {
    return {
      ok: false,
      error: controller.signal.aborted ? TIMEOUT_ERROR : `${TRANSPORT_ERROR}: ${String(cause)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** One response payload, collected and emitted. A payload this build's copy of
 * the union does not know is DROPPED rather than fatal, for the reason the
 * envelope reader gives below; both readers go through here so they cannot
 * disagree about that. */
function acceptSessionControlResponse(
  raw: JsonValue,
  responses: LodySessionControlMessage[],
  emit: (response: LodySessionControlMessage) => void,
): void {
  const parsed = LocalSessionControlResponseSchema.safeParse(raw, { jitless: true });
  if (!parsed.success) return;
  // SAFETY: the daemon's own response schema just accepted this value, and every
  // member of that union carries the `type` discriminant this side reads; the
  // assertion crosses the vendor type seam, not a check.
  const response = parsed.data as LodySessionControlMessage;
  responses.push(response);
  emit(response);
}

/**
 * The NDJSON body, frame by frame.
 *
 * The frame envelope is the daemon's (`local-ipc.ts:80`, a three-arm
 * discriminated union on `kind`). Its schema is not exported and lives in a
 * node-only module, so it is re-stated here against the captured corpus in
 * `packages/schema/fixtures/lody-session-control-stream/` rather than imported.
 *
 * A body that ends without `{kind:'complete'}` is a failure even when every
 * frame before it parsed: the daemon writes that frame last and only on success,
 * so its absence means the socket died mid-flow — and reporting the partial
 * batch as `ok` would turn a dropped sign-in into a silent one.
 */
async function readSessionControlStream(
  body: ReadableStream<Uint8Array>,
  emit: (response: LodySessionControlMessage) => void,
): Promise<LodySessionControlResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const responses: LodySessionControlMessage[] = [];
  let buffered = "";
  let complete = false;
  let refusal: string | null = null;

  /** `true` while the stream should keep being read. */
  const consume = (line: string): boolean => {
    if (line.trim() === "") return true;
    const frame = parseJson(line);
    if (!isJsonObject(frame)) {
      refusal = SESSION_CONTROL_STREAM_ERROR;
      return false;
    }
    if (frame.kind === "complete") {
      complete = true;
      return false;
    }
    if (frame.kind === "error") {
      const reason = frame.error;
      refusal =
        reason !== undefined && isJsonString(reason) ? reason : SESSION_CONTROL_BATCH_ERROR;
      return false;
    }
    if (frame.kind !== "response" || frame.response === undefined) {
      refusal = SESSION_CONTROL_STREAM_ERROR;
      return false;
    }
    acceptSessionControlResponse(frame.response, responses, emit);
    return true;
  };

  let stopped = false;
  try {
    while (!stopped) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!consume(line)) {
          stopped = true;
          break;
        }
        newline = buffered.indexOf("\n");
      }
    }
    // The tail after the last newline. Only reached when the daemon ended the
    // body mid-line, which a well-formed stream never does — its last byte is
    // the newline after `{"kind":"complete"}`.
    if (!stopped) {
      buffered += decoder.decode();
      consume(buffered);
    }
  } finally {
    // Releasing the lock is what lets the fetch body be discarded; without it a
    // refused stream stays half-read and its connection stays open.
    reader.cancel().catch(() => undefined);
  }
  if (refusal !== null) return { ok: false, error: refusal };
  if (!complete) return { ok: false, error: SESSION_CONTROL_TRUNCATED };
  return { ok: true, responses };
}

/**
 * The buffered `{ ok, responses: [...] }` envelope.
 *
 * Reached when the daemon ignored our `Accept` — an older daemon, or a box whose
 * `blitz-lody-bridge` predates the header being forwarded. Everything still
 * works except that a response cannot arrive before the flow it belongs to ends.
 */
function readSessionControlEnvelope(
  text: string,
  status: number,
  emit: (response: LodySessionControlMessage) => void,
): LodySessionControlResult {
  const envelope = parseJson(text);
  // `parseJson` maps a parse failure to `null`, which is also a legal JSON
  // document. The door never answers a bare `null`, so a `null` here is a proxy
  // or a gateway talking, not the daemon.
  if (envelope === null) return { ok: false, error: `lody_bridge_bad_json_${status}` };
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
  // A response type this build does not know is dropped, not fatal: the union is
  // versioned by the daemon and the renderer is pinned a few releases back
  // (plans/evidence/lody-phase1.md §11 skew).
  for (const raw of batch) acceptSessionControlResponse(raw, responses, emit);
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

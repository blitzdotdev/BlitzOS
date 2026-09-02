/**
 * The browser half of the Lody local data plane
 * (plans/LODY-RUNTIME-DESIGN.md §2.2).
 *
 * Lody's renderer reaches its daemon's CRDT sync socket through four methods
 * declared at `vendor/lody/packages/shared/src/local-loro-transport.ts:44` —
 * `send`, `onMessage`, `onStatusChange`, `isConnected`. Electron implements them
 * over IPC in thirty lines
 * (`vendor/lody/packages/components/src/providers/local-loro-data-plane-connection.ts`).
 * This implements the same four over the WebSocket the box gateway proxies at
 * `/lody/sync`, so `LocalLoroTransportAdapter` is used entirely unchanged.
 *
 * WHAT IS OURS AND WHAT IS THEIRS. The frames are Lody's protocol v7 and stay
 * theirs; what became BlitzOS's when this file appeared is the FRAMING — one
 * WebSocket text message is one JSON frame, and the `\n` the daemon's socket
 * wants is appended and stripped by `blitz-lody-bridge`, never seen here. That
 * is the cross-runtime contract pinned by
 * `packages/schema/fixtures/lody-data-plane/`.
 *
 * THE LINK IS A BROADCAST PIPE. `onMessage` delivers frames addressed to other
 * peers and other rooms; the adapter filters by `workspaceId` + `peerId`. So an
 * unparseable frame is counted and dropped, never thrown — one bad frame from a
 * skewed peer must not take down a room that is converging fine.
 */
import {
  LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
  LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  LocalLoroDataPlaneServerMessageSchema,
} from "@lody/shared/local-loro-data-plane";
import type { LodyDataPlaneConnection, LodyDataPlaneFrame } from "./wire-types.js";

/** Everything a `WebSocket` can deliver. The bridge only ever sends text, so
 * the other arms exist to be rejected rather than to be handled. */
export type WebSocketPayload = string | ArrayBuffer | Blob;

export function isTextPayload(data: WebSocketPayload): data is string {
  return typeof data === "string";
}

/** Liveness, matching the Electron relay's numbers
 * (`apps/electron/src/main/services/loro-data-plane-relay.ts:16-17`). `ping` and
 * `pong` are protocol frames, not WebSocket control frames, and the bridge
 * forwards them untouched, so the watchdog is ours to run. */
const PING_INTERVAL_MS = 15_000;
const IDLE_TIMEOUT_MS = 45_000;

/** Redial backoff, same source, `:21-22`. A daemon restart must not need a page
 * reload: the adapter rejoins every room on the `false` → `true` transition. */
const REDIAL_MIN_DELAY_MS = 1_000;
const REDIAL_MAX_DELAY_MS = 30_000;

/** Counters a caller can assert on. Every one of these is a silent drop in
 * production, which is exactly why they are counted rather than logged: the
 * phase-3 round trip asserts the set is empty (design doc risk 10). */
export interface LodyDataPlaneStats {
  /** Frames that were not JSON at all. */
  unparseable: number;
  /** Frames that were JSON but not a protocol-v7 server message. */
  rejected: number;
  /** Outbound frames refused for exceeding the sender's payload budget. */
  oversizedOutbound: number;
  /** Inbound frames refused for exceeding the frame cap. */
  oversizedInbound: number;
  /** Completed redials since construction. */
  redials: number;
}

export interface LodyDataPlaneConnectionOptions {
  /** `BoxEndpoints.lodySyncUrl` — already a `ws:`/`wss:` URL. */
  url: string;
  /** Injected in tests; defaults to the platform `WebSocket`. */
  webSocketConstructor?: typeof WebSocket;
  /** Socket continuity edges consumed by the owning keep-alive entry. */
  onContinuity?: (event: LodyDataPlaneContinuityEvent) => void;
}

export type LodyDataPlaneContinuityEvent = "socket-close" | "socket-redial";

export interface LodyDataPlaneConnectionHandle {
  connection: LodyDataPlaneConnection;
  stats: () => LodyDataPlaneStats;
  dispose: () => void;
}

let liveDataPlaneSockets = 0;

/** Test/probe instrumentation: physical sockets currently owned by this page. */
export function lodyLiveDataPlaneSocketCount(): number {
  return liveDataPlaneSockets;
}

/**
 * Opens one socket per browser tab.
 *
 * Deliberately NOT multiplexed the way the Electron relay is. A tab close is a
 * peer death: the daemon sees its socket close and drops that peer's room
 * subscriptions with nobody synthesizing a `detach`. A `detach` on
 * `beforeunload` would be a courtesy only — and one this layer cannot send, as
 * `detach` carries a `workspaceId` and `peerId` that belong to the adapter above
 * it, not to the socket.
 */
export function createLodyDataPlaneConnection(
  options: LodyDataPlaneConnectionOptions,
): LodyDataPlaneConnectionHandle {
  const WebSocketImpl = options.webSocketConstructor ?? globalThis.WebSocket;
  const messageListeners = new Set<(message: LodyDataPlaneFrame) => void>();
  const statusListeners = new Set<(connected: boolean) => void>();
  const stats: LodyDataPlaneStats = {
    unparseable: 0,
    rejected: 0,
    oversizedOutbound: 0,
    oversizedInbound: 0,
    redials: 0,
  };

  let socket: WebSocket | null = null;
  let connected = false;
  let disposed = false;
  let redialDelay = REDIAL_MIN_DELAY_MS;
  let redialTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let lastInboundAt = 0;

  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    for (const listener of statusListeners) listener(next);
  };

  const stopTimers = (): void => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const scheduleRedial = (): void => {
    if (disposed || redialTimer !== null) return;
    redialTimer = setTimeout(() => {
      redialTimer = null;
      stats.redials += 1;
      options.onContinuity?.("socket-redial");
      open();
    }, redialDelay);
    redialDelay = Math.min(redialDelay * 2, REDIAL_MAX_DELAY_MS);
  };

  const dropSocket = (): void => {
    stopTimers();
    const dying = socket;
    socket = null;
    if (dying !== null) liveDataPlaneSockets -= 1;
    if (connected) options.onContinuity?.("socket-close");
    setConnected(false);
    if (dying !== null && (dying.readyState === 0 || dying.readyState === 1)) dying.close();
    scheduleRedial();
  };

  const deliver = (raw: string): void => {
    lastInboundAt = Date.now();
    if (raw.length > LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES) {
      // Larger than any compliant sender may produce, so the peer is broken
      // rather than busy. Drop the socket; the adapter rejoins and reconciles.
      stats.oversizedInbound += 1;
      dropSocket();
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      stats.unparseable += 1;
      return;
    }
    // External data parsed at the boundary into a named type (CLAUDE.md). The
    // `protocolVersion` literal inside this schema is what makes a skewed daemon
    // fail here instead of half-working.
    const parsed = LocalLoroDataPlaneServerMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      stats.rejected += 1;
      return;
    }
    for (const listener of messageListeners) listener(parsed.data);
  };

  function open(): void {
    if (disposed || socket !== null) return;
    const next = new WebSocketImpl(options.url);
    liveDataPlaneSockets += 1;
    socket = next;
    lastInboundAt = Date.now();
    next.onopen = () => {
      if (socket !== next) return;
      redialDelay = REDIAL_MIN_DELAY_MS;
      lastInboundAt = Date.now();
      setConnected(true);
      pingTimer = setInterval(() => {
        if (socket !== next) return;
        if (Date.now() - lastInboundAt > IDLE_TIMEOUT_MS) {
          // A silent socket is a dead push channel. Surfacing it as
          // disconnected is what makes the rooms rejoin; leaving it open is a
          // permanently stale UI.
          dropSocket();
          return;
        }
        send({ type: "ping", protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION });
      }, PING_INTERVAL_MS);
    };
    next.onmessage = (event: MessageEvent<WebSocketPayload>) => {
      if (socket !== next) return;
      // The bridge only ever sends text frames; anything else is not ours.
      if (!isTextPayload(event.data)) {
        stats.unparseable += 1;
        return;
      }
      deliver(event.data);
    };
    next.onclose = () => {
      if (socket !== next) return;
      dropSocket();
    };
    next.onerror = () => {
      if (socket !== next) return;
      dropSocket();
    };
  }

  function send(message: LodyDataPlaneFrame): void {
    const frame = JSON.stringify(message);
    if (frame.length > LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES) {
      // A compliant sender never writes a frame a compliant receiver would
      // refuse. The adapter chunks oversized doc updates upstream of us, so
      // reaching this is a bug above, not backpressure.
      stats.oversizedOutbound += 1;
      return;
    }
    if (socket === null || socket.readyState !== 1) return;
    socket.send(frame);
  }

  const connection: LodyDataPlaneConnection = {
    send,
    onMessage: (listener: (message: LodyDataPlaneFrame) => void) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStatusChange: (listener: (connected: boolean) => void) => {
      // Immediate call-back with the current value, exactly as the Electron
      // implementation does: the adapter uses it to decide whether to rejoin,
      // and a listener registered after `open` would otherwise never learn.
      statusListeners.add(listener);
      listener(connected);
      return () => statusListeners.delete(listener);
    },
    isConnected: () => connected,
  };

  open();

  return {
    connection,
    stats: () => ({ ...stats }),
    dispose: () => {
      disposed = true;
      stopTimers();
      if (redialTimer !== null) {
        clearTimeout(redialTimer);
        redialTimer = null;
      }
      const dying = socket;
      socket = null;
      if (dying !== null) liveDataPlaneSockets -= 1;
      setConnected(false);
      messageListeners.clear();
      statusListeners.clear();
      if (dying !== null && (dying.readyState === 0 || dying.readyState === 1)) dying.close();
    },
  };
}

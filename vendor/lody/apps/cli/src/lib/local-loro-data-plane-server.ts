import fs from 'node:fs';
import net from 'node:net';
import {
  createJsonLineSplitter,
  LocalLoroDataPlaneClientMessageSchema,
  LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
} from '@lody/shared';
import type {
  LocalLoroDataPlaneServer,
  LocalLoroDataPlaneServerConnection,
} from '@lody/shared/local-loro-data-plane-server';
import { getLocalLoroDataPlaneSocketPath } from '@lody/shared/node/local-ipc';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { removeStaleUnixSocket } from '@/lib/stale-unix-socket';

// Idle watchdog: the Electron relay pings every ~15s, so a connection with no
// inbound traffic for this long is dead — drop it and let the relay's redial
// loop re-establish. (Plan-mandated watchdog; a silently-stalled push channel
// would otherwise present as a permanently stale UI, cf.
// project_code_collab_rpc_slow_no_response.)
const CONNECTION_IDLE_TIMEOUT_MS = 60_000;

export interface LocalLoroDataPlaneSocketServerConfig {
  logger: Logger;
  // Resolves the per-workspace sync engine. Returns null when the workspace has
  // no running runtime (the client gets an error and can retry after bootstrap).
  getWorkspaceServer: (workspaceId: string) => LocalLoroDataPlaneServer | null;
  /** Override the protocol frame limit for focused transport tests. */
  maxFrameBytes?: number;
}

let dataPlaneServer: net.Server | null = null;
let activeSocketPath: string | null = null;
let dataPlaneServerStart: Promise<void> | null = null;
let connectionSeq = 0;
const activeClientSockets = new Set<net.Socket>();

function encode(message: LocalLoroDataPlaneServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export async function startLocalLoroDataPlaneServer(
  config: LocalLoroDataPlaneSocketServerConfig
): Promise<void> {
  if (dataPlaneServer) {
    return;
  }
  if (dataPlaneServerStart) {
    return await dataPlaneServerStart;
  }
  dataPlaneServerStart = startInner(config).finally(() => {
    dataPlaneServerStart = null;
  });
  return await dataPlaneServerStart;
}

async function startInner(config: LocalLoroDataPlaneSocketServerConfig): Promise<void> {
  const socketPath = getLocalLoroDataPlaneSocketPath();
  await removeStaleUnixSocket(socketPath, 'local_loro_data_plane_socket_in_use');

  const server = net.createServer((socket) => {
    const connectionId = `dp:${process.pid}:${++connectionSeq}`;
    // Track engines this socket touched so we can drop its subscriptions on close.
    const touchedEngines = new Set<LocalLoroDataPlaneServer>();
    activeClientSockets.add(socket);

    const connection: LocalLoroDataPlaneServerConnection = {
      id: connectionId,
      // Flow control instead of kill-on-burst: `write` returning false pauses
      // the engine's per-connection writer (which stops EXPORTING — deltas
      // coalesce against the per-peer frontier) until 'drain'. Outbound memory
      // is bounded by one in-flight frame, so a slow consumer just syncs
      // slower; liveness is owned by the idle watchdog below, never by buffer
      // size heuristics (the old writableLength kill misread bursts as dead
      // consumers and livelocked the reconnect loop).
      send: (message) => {
        if (socket.destroyed) {
          return false;
        }
        return socket.write(encode(message));
      },
      onDrain: (listener) => {
        socket.on('drain', listener);
        return () => socket.off('drain', listener);
      },
    };

    // Room topology/import messages retain connection order because join awaits
    // real I/O and leave/update must not overtake it.
    let roomMessageChain: Promise<void> = Promise.resolve();

    const splitLines = createJsonLineSplitter({
      onLine: (line) => {
        const message = parseLine(connection, line);
        if (!message) {
          return;
        }
        roomMessageChain = roomMessageChain
          .then(() => handleMessage(config, connection, touchedEngines, message))
          .catch((error) => logMessageHandlingError(config.logger, error));
      },
      maxBufferBytes: config.maxFrameBytes ?? LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
      // Defense-in-depth only (compliant senders enforce the frame budget and
      // surface a terminal room error instead of writing): report and keep the
      // connection alive — destroying the socket would take down every room of
      // every window multiplexed over it.
      onOverflow: () => {
        connection.send({
          type: 'error',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          code: 'payload_too_large',
          message: 'Loro data-plane frame exceeded buffer limit; frame dropped',
        });
      },
    });
    // Hand the splitter raw bytes: it owns the stateful UTF-8 decode, so a
    // multi-byte character straddling a socket chunk boundary survives.
    socket.on('data', (chunk) => splitLines(chunk));

    // Dead-peer cleanup half of the idle watchdog (the relay pings often enough
    // that a healthy connection never trips this).
    socket.setTimeout(CONNECTION_IDLE_TIMEOUT_MS, () => {
      config.logger.debug(`[loro-data-plane] connection ${connectionId} idle; dropping`);
      socket.destroy();
    });

    socket.on('close', () => {
      activeClientSockets.delete(socket);
      for (const engine of touchedEngines) {
        engine.handleDisconnect(connectionId);
      }
      touchedEngines.clear();
    });
    socket.on('error', (error) => {
      config.logger.debug(`[loro-data-plane] socket error: ${error.message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      dataPlaneServer = server;
      activeSocketPath = socketPath;
      if (process.platform !== 'win32') {
        fs.chmodSync(socketPath, 0o600);
      }
      config.logger.debug(`[loro-data-plane] socket listening at ${socketPath}`);
      resolve();
    });
  });

  server.on('error', (error) => {
    config.logger.warn(`[loro-data-plane] server error: ${error.message}`);
    if (dataPlaneServer === server) {
      dataPlaneServer = null;
      activeSocketPath = null;
    }
    try {
      server.close();
    } catch {
      // already closed
    }
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });
}

function parseLine(
  connection: LocalLoroDataPlaneServerConnection,
  line: string
): Exclude<LocalLoroDataPlaneClientMessage, { type: 'ping' }> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    connection.send({
      type: 'error',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      code: 'invalid_json',
      message: formatErrorMessage(error),
    });
    return null;
  }
  const parsed = LocalLoroDataPlaneClientMessageSchema.safeParse(raw);
  if (!parsed.success) {
    connection.send({
      type: 'error',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      code: 'invalid_request',
      message: parsed.error.message,
      ...(hasStringField(raw, 'peerId') ? { peerId: raw.peerId } : {}),
      ...(hasStringField(raw, 'requestId') ? { requestId: raw.requestId } : {}),
    });
    return null;
  }
  const message = parsed.data;
  // Pings are connection-scoped liveness probes from the relay; they never touch
  // a workspace engine.
  if (message.type === 'ping') {
    connection.send({ type: 'pong', protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION });
    return null;
  }
  return message;
}

async function handleMessage(
  config: LocalLoroDataPlaneSocketServerConfig,
  connection: LocalLoroDataPlaneServerConnection,
  touchedEngines: Set<LocalLoroDataPlaneServer>,
  message: Exclude<LocalLoroDataPlaneClientMessage, { type: 'ping' }>
): Promise<void> {
  const engine = config.getWorkspaceServer(message.workspaceId);
  if (!engine) {
    connection.send({
      type: 'error',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      code: 'workspace_runtime_unavailable',
      message: message.workspaceId,
      workspaceId: message.workspaceId,
      peerId: message.peerId,
      ...(message.type === 'join' ? { requestId: message.requestId } : {}),
    });
    return;
  }
  touchedEngines.add(engine);
  await engine.handleMessage(connection, message);
}

function logMessageHandlingError(logger: Logger, error: unknown): void {
  logger.debug(`[loro-data-plane] message handling error: ${formatErrorMessage(error)}`);
}

function hasStringField<K extends string>(value: unknown, field: K): value is Record<K, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    field in value &&
    typeof (value as Record<K, unknown>)[field] === 'string'
  );
}

export async function stopLocalLoroDataPlaneServer(): Promise<void> {
  if (!dataPlaneServer) {
    return;
  }
  const server = dataPlaneServer;
  const socketPath = activeSocketPath;
  dataPlaneServer = null;
  activeSocketPath = null;

  for (const socket of activeClientSockets) {
    socket.destroy();
  }
  activeClientSockets.clear();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (socketPath && process.platform !== 'win32' && fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
}

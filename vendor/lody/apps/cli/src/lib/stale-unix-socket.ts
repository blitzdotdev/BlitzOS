import fs from 'node:fs';
import net from 'node:net';

const STALE_SOCKET_PROBE_ATTEMPTS = 10;
const STALE_SOCKET_PROBE_INTERVAL_MS = 250;

type StaleSocketProbe = 'removed' | 'in_use';

/**
 * True when the socket path exists and is a Unix domain socket. A symlink or
 * regular file at the socket path is something we never create — refuse to
 * unlink or bind through it (S1) by throwing
 * `local_ipc_socket_path_not_socket:<socketPath>`.
 */
export function socketPathExistsAsSocket(socketPath: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  if (!stats.isSocket()) {
    throw new Error(`local_ipc_socket_path_not_socket:${socketPath}`);
  }
  return true;
}

// Resolves 'removed' once the socket is gone/refused (stale leftover unlinked),
// or 'in_use' if another process is actively listening on it.
function probeUnixSocketOnce(socketPath: string): Promise<StaleSocketProbe> {
  return new Promise<StaleSocketProbe>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve('in_use');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        try {
          fs.unlinkSync(socketPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
            reject(unlinkError);
            return;
          }
        }
        resolve('removed');
        return;
      }
      reject(error);
    });
  });
}

/**
 * Remove a stale unix socket left behind by a dead process before binding to it.
 *
 * Refuses (via {@link socketPathExistsAsSocket}) to touch anything that is not
 * a socket — a planted regular file or symlink aborts startup instead of being
 * unlinked (S1). A connectable socket usually means another instance owns it,
 * but a prior instance that is mid-shutdown can keep the listener alive for a
 * short window. Retry before declaring it in use so a force-quit → relaunch
 * race recovers instead of failing startup outright. Throws
 * `<inUseErrorCode>:<socketPath>` when the socket stays owned by a live
 * listener.
 */
export async function removeStaleUnixSocket(
  socketPath: string,
  inUseErrorCode: string
): Promise<void> {
  if (process.platform === 'win32' || !socketPathExistsAsSocket(socketPath)) {
    return;
  }
  for (let attempt = 0; attempt < STALE_SOCKET_PROBE_ATTEMPTS; attempt += 1) {
    if (!socketPathExistsAsSocket(socketPath)) {
      return;
    }
    const result = await probeUnixSocketOnce(socketPath);
    if (result === 'removed') {
      return;
    }
    if (attempt < STALE_SOCKET_PROBE_ATTEMPTS - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, STALE_SOCKET_PROBE_INTERVAL_MS));
    }
  }
  throw new Error(`${inUseErrorCode}:${socketPath}`);
}

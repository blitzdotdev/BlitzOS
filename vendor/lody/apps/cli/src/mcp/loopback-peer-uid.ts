import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * Loopback TCP peer ownership lookup on Linux.
 *
 * The MCP HTTP host authenticates with a bearer token, but that token travels
 * inside the agent's MCP config, which the Claude runtime receives on its
 * command line — world-readable through `/proc/<pid>/cmdline` on Linux. TCP
 * has no `SO_PEERCRED`, so this recovers the connecting socket's owning uid
 * from `/proc/net/tcp{,6}` instead: the kernel lists every socket in the
 * current network namespace with its owner, and a local peer cannot hide its
 * entry.
 *
 * Identity requires the FULL four-tuple plus connection state. Matching on
 * ports alone is spoofable: two established sockets may share a local port
 * when bound to different `127/8` addresses, so a foreign user could bind a
 * colliding port on `127.0.0.2` and be mistaken for the daemon owner's
 * connection. Callers on Linux must treat an unresolvable uid as a rejection
 * (fail closed); `canReadProcNetTcp()` lets the host refuse to start where
 * that would break every request (masked /proc).
 *
 * macOS and Windows hide other users' process arguments, so the token does
 * not leak there and this module is not consulted.
 */

export interface LoopbackPeer {
  /** The client's address/port as reported by the accepted socket. */
  peerAddress: string;
  peerPort: number;
  /** The server's bound address/port for this connection. */
  serverAddress: string;
  serverPort: number;
}

export function canReadProcNetTcp(): boolean {
  try {
    accessSync('/proc/net/tcp', constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the uid owning the peer's socket, or null when the connection
 * cannot be located. Only meaningful on Linux.
 */
export async function lookupLoopbackPeerUid(peer: LoopbackPeer): Promise<number | null> {
  if (process.platform !== 'linux') {
    return null;
  }
  const peerHexes = ipToProcNetHexes(peer.peerAddress);
  const serverHexes = ipToProcNetHexes(peer.serverAddress);
  if (peerHexes.length === 0 || serverHexes.length === 0) {
    return null;
  }
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let content: string;
    try {
      content = await readFile(table, 'utf8');
    } catch {
      continue;
    }
    const uid = findPeerUidInProcNetTcp(content, {
      peerAddressHexes: peerHexes,
      peerPort: peer.peerPort,
      serverAddressHexes: serverHexes,
      serverPort: peer.serverPort,
    });
    if (uid !== null) {
      return uid;
    }
  }
  return null;
}

const ESTABLISHED_STATE = '01';

export interface ProcNetTcpQuery {
  /** Accepted hex encodings of the peer address (IPv4 and v4-mapped IPv6). */
  peerAddressHexes: string[];
  peerPort: number;
  serverAddressHexes: string[];
  serverPort: number;
}

/**
 * Parses `/proc/net/tcp`-format content and returns the uid owning the
 * ESTABLISHED socket whose local side is (peerAddress, peerPort) and remote
 * side is (serverAddress, serverPort) — i.e. the CLIENT side of an inbound
 * connection to our server. The full four-tuple uniquely identifies an
 * established TCP connection within a network namespace, and loopback
 * connections always share the namespace.
 */
export function findPeerUidInProcNetTcp(content: string, query: ProcNetTcpQuery): number | null {
  const lines = content.split('\n');
  // Skip the header line.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Format: sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid ...
    const fields = line.trim().split(/\s+/);
    const local = fields[1];
    const remote = fields[2];
    const state = fields[3];
    const uidField = fields[7];
    if (!local || !remote || !state || !uidField) continue;
    if (state !== ESTABLISHED_STATE) continue;
    if (!addressMatches(local, query.peerAddressHexes, query.peerPort)) continue;
    if (!addressMatches(remote, query.serverAddressHexes, query.serverPort)) continue;
    const uid = Number.parseInt(uidField, 10);
    return Number.isNaN(uid) ? null : uid;
  }
  return null;
}

const addressMatches = (procAddress: string, addressHexes: string[], port: number): boolean => {
  const colon = procAddress.lastIndexOf(':');
  if (colon < 0) return false;
  const entryPort = Number.parseInt(procAddress.slice(colon + 1), 16);
  if (entryPort !== port) return false;
  const entryHex = procAddress.slice(0, colon).toUpperCase();
  return addressHexes.includes(entryHex);
};

/**
 * Encodes an IP address the way `/proc/net/tcp{,6}` prints it: 32-bit words
 * in host byte order (little-endian on every platform Lody ships for). An
 * IPv4 peer may surface in EITHER table — as dotted IPv4 in `tcp`, or as a
 * v4-mapped IPv6 socket in `tcp6` when the client connected through an
 * AF_INET6 socket — so both encodings are returned for IPv4 input.
 */
export function ipToProcNetHexes(ip: string): string[] {
  const v4 = parseIpv4(ip);
  if (v4) {
    const v4Hex = bytesToProcNetHex(v4);
    // ::ffff:a.b.c.d — 10 zero bytes, 0xff 0xff, then the IPv4 bytes.
    const mapped = new Uint8Array(16);
    mapped[10] = 0xff;
    mapped[11] = 0xff;
    mapped.set(v4, 12);
    return [v4Hex, bytesToProcNetHex(mapped)];
  }
  const v6 = parseIpv6(ip);
  if (v6) {
    return [bytesToProcNetHex(v6)];
  }
  return [];
}

const bytesToProcNetHex = (bytes: Uint8Array): string => {
  // Each 4-byte group is printed as a little-endian 32-bit word.
  let out = '';
  for (let group = 0; group < bytes.length; group += 4) {
    for (let i = 3; i >= 0; i--) {
      out += (bytes[group + i] ?? 0).toString(16).padStart(2, '0');
    }
  }
  return out.toUpperCase();
};

const parseIpv4 = (ip: string): Uint8Array | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === undefined || !/^\d{1,3}$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
};

const parseIpv6 = (ip: string): Uint8Array | null => {
  // Strip a zone index and normalize a trailing v4-mapped tail.
  const zone = ip.indexOf('%');
  let input = zone >= 0 ? ip.slice(0, zone) : ip;
  const v4TailMatch = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(input);
  if (v4TailMatch?.[1] !== undefined && v4TailMatch[2] !== undefined) {
    const v4 = parseIpv4(v4TailMatch[2]);
    if (!v4) return null;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    input = `${v4TailMatch[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const doubleColon = input.indexOf('::');
  if (doubleColon !== input.lastIndexOf('::')) return null;
  let groups: string[];
  if (doubleColon >= 0) {
    const head = input
      .slice(0, doubleColon)
      .split(':')
      .filter((g) => g.length > 0);
    const tail = input
      .slice(doubleColon + 2)
      .split(':')
      .filter((g) => g.length > 0);
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = input.split(':');
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i];
    if (group === undefined || !/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
};

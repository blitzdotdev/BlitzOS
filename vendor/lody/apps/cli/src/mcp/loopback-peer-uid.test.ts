import { describe, expect, it } from 'vitest';
import { findPeerUidInProcNetTcp, ipToProcNetHexes } from './loopback-peer-uid';

// /proc/net/tcp fixture. Established loopback sockets:
// - 127.0.0.1:53297 -> 127.0.0.1:8080 owned by uid 1000 (the daemon owner)
// - 127.0.0.2:53297 -> 127.0.0.1:8080 owned by uid 1001 (foreign user with a
//   COLLIDING local port on another 127/8 address — the spoof scenario)
// - 127.0.0.1:53298 -> 127.0.0.1:8080 owned by uid 1001
// - 127.0.0.1:53299 -> 127.0.0.1:8080 in TIME_WAIT (st 06), uid 1000
const row = (local: string, remote: string, st: string, uid: number, sl: number) =>
  `   ${sl}: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${123456 + sl} 1 0000000000000000 20 4 30 10 -1`;

const PROC_NET_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  row('0100007F:D031', '0100007F:1F90', '01', 1000, 0),
  row('0200007F:D031', '0100007F:1F90', '01', 1001, 1),
  row('0100007F:D032', '0100007F:1F90', '01', 1001, 2),
  row('0100007F:D033', '0100007F:1F90', '06', 1000, 3),
  '',
].join('\n');

const LOCALHOST_HEXES = ipToProcNetHexes('127.0.0.1');

const query = (peerIp: string, peerPort: number) => ({
  peerAddressHexes: ipToProcNetHexes(peerIp),
  peerPort,
  serverAddressHexes: LOCALHOST_HEXES,
  serverPort: 0x1f90,
});

describe('findPeerUidInProcNetTcp', () => {
  it('matches the full four-tuple, not just the port pair', () => {
    // Same client port 0xD031 exists on both 127.0.0.1 (uid 1000) and
    // 127.0.0.2 (uid 1001); the address must disambiguate.
    expect(findPeerUidInProcNetTcp(PROC_NET_TCP, query('127.0.0.1', 0xd031))).toBe(1000);
    expect(findPeerUidInProcNetTcp(PROC_NET_TCP, query('127.0.0.2', 0xd031))).toBe(1001);
    expect(findPeerUidInProcNetTcp(PROC_NET_TCP, query('127.0.0.1', 0xd032))).toBe(1001);
  });

  it('ignores non-ESTABLISHED entries', () => {
    expect(findPeerUidInProcNetTcp(PROC_NET_TCP, query('127.0.0.1', 0xd033))).toBeNull();
  });

  it('returns null when no socket matches', () => {
    expect(findPeerUidInProcNetTcp(PROC_NET_TCP, query('127.0.0.1', 0xd034))).toBeNull();
    expect(
      findPeerUidInProcNetTcp(PROC_NET_TCP, {
        ...query('127.0.0.1', 0xd031),
        serverPort: 0x1f91,
      })
    ).toBeNull();
  });

  it('does not match the header line or malformed rows', () => {
    const malformed = ['header', 'garbage line without fields', '   2: nonsense'].join('\n');
    expect(findPeerUidInProcNetTcp(malformed, query('127.0.0.1', 1))).toBeNull();
  });

  it('matches a v4-mapped IPv6 client entry in tcp6 format', () => {
    const tcp6 = [
      '  sl  local_address rem_address st ...',
      `   0: 0000000000000000FFFF00000100007F:A1B2 0000000000000000FFFF00000100007F:1F90 01 00000000:00000000 00:00000000 00000000  1002        0 42 1 0000000000000000 20 4 30 10 -1`,
    ].join('\n');
    expect(findPeerUidInProcNetTcp(tcp6, query('127.0.0.1', 0xa1b2))).toBe(1002);
  });
});

describe('ipToProcNetHexes', () => {
  it('encodes IPv4 as a little-endian word plus its v4-mapped IPv6 form', () => {
    expect(ipToProcNetHexes('127.0.0.1')).toEqual(['0100007F', '0000000000000000FFFF00000100007F']);
    expect(ipToProcNetHexes('127.0.0.2')).toEqual(['0200007F', '0000000000000000FFFF00000200007F']);
  });

  it('encodes IPv6 loopback', () => {
    expect(ipToProcNetHexes('::1')).toEqual(['00000000000000000000000001000000']);
  });

  it('encodes the ::ffff:127.0.0.1 spelling identically to the mapped form', () => {
    expect(ipToProcNetHexes('::ffff:127.0.0.1')).toEqual(['0000000000000000FFFF00000100007F']);
  });

  it('rejects garbage', () => {
    expect(ipToProcNetHexes('not-an-ip')).toEqual([]);
    expect(ipToProcNetHexes('300.0.0.1')).toEqual([]);
  });
});

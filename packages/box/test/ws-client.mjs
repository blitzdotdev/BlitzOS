// A dependency-free WebSocket client for the box smoke probes.
//
// The image ships no WebSocket library (it used to borrow `ws` from the box
// actor, which is gone), and Node's built-in WebSocket sends no Origin header.
// ttyd runs with --check-origin and the box gateway refuses an upgrade whose
// Origin it cannot read, so both probes need one. This client speaks exactly
// the subset RFC 6455 asks of a client: a masked data frame out, any frame in,
// pong on ping, and one close frame on the way out.
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

function encodeFrame(opcode, payload) {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  let header;
  if (masked.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | masked.length]);
  } else if (masked.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(masked.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(masked.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

// Returns every complete frame in `buffer` plus the bytes left over. A frame
// header is 2-14 bytes, so a short read simply leaves the tail for next time.
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    const second = buffer[offset + 1];
    const hasMask = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let mask = null;
    if (hasMask) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// Resolves once the server answers 101 with the matching accept key. `onMessage`
// receives the payload of every data frame; `onClose` runs once the socket ends.
export function openWebSocket(url, options = {}) {
  const { origin, protocols = [], onMessage = () => {}, onClose = () => {} } = options;
  const target = new URL(url);
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1')
    .update(key + ACCEPT_GUID)
    .digest('base64');
  const requestLines = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (origin) {
    requestLines.push(`Origin: ${origin}`);
  }
  if (protocols.length > 0) {
    requestLines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
  }

  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    const connection = {
      send(payload) {
        const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        socket.write(encodeFrame(Buffer.isBuffer(payload) ? OPCODE_BINARY : OPCODE_TEXT, body));
      },
      close() {
        socket.write(encodeFrame(OPCODE_CLOSE, Buffer.from([0x03, 0xe8])));
        socket.end();
      },
      destroy() {
        socket.destroy();
      },
    };
    let awaitingHandshake = true;
    let buffer = Buffer.alloc(0);

    socket.on('connect', () => socket.write(`${requestLines.join('\r\n')}\r\n\r\n`));
    socket.on('error', reject);
    socket.on('close', onClose);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (awaitingHandshake) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const head = buffer.subarray(0, headerEnd).toString('latin1');
        buffer = buffer.subarray(headerEnd + 4);
        if (!head.startsWith('HTTP/1.1 101')) {
          socket.destroy();
          reject(new Error(`websocket handshake refused: ${head.split('\r\n')[0]}`));
          return;
        }
        if (!head.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) {
          socket.destroy();
          reject(new Error('websocket handshake returned the wrong accept key'));
          return;
        }
        awaitingHandshake = false;
        resolve(connection);
      }
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const item of decoded.frames) {
        if (item.opcode === OPCODE_PING) {
          socket.write(encodeFrame(OPCODE_PONG, item.payload));
        } else if (item.opcode === OPCODE_CLOSE) {
          socket.end();
        } else if (
          item.opcode === OPCODE_TEXT ||
          item.opcode === OPCODE_BINARY ||
          item.opcode === OPCODE_CONTINUATION
        ) {
          onMessage(item.payload);
        }
      }
    });
  });
}

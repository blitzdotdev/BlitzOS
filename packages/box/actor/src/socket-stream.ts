import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type { RawData, WebSocket } from "ws";
import { SUBSCRIBER_BUFFER_BYTES } from "./config.js";

export function socketStream(socket: WebSocket): Stream {
  let controller: ReadableStreamDefaultController<AnyMessage> | undefined;
  let closed = false;
  const readable = new ReadableStream<AnyMessage>({
    start(value) {
      controller = value;
    },
    cancel() {
      closed = true;
      socket.close();
    },
  });

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (closed) return;
    if (isBinary) {
      socket.close(1003, "Text frames only");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isMessage(parsed)) throw new Error("invalid JSON-RPC frame");
      controller?.enqueue(parsed);
    } catch {
      socket.close(1007, "Malformed ACP frame");
    }
  });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    controller?.close();
  });
  socket.on("error", (error) => {
    if (closed) return;
    closed = true;
    controller?.error(error);
  });

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      return send(socket, message).then(() => {
        if (isInvalidRequestResponse(message)) socket.close(1007, "Malformed ACP frame");
      });
    },
    close() {
      socket.close();
    },
    abort() {
      socket.close();
    },
  });
  return { readable, writable };
}

function send(socket: WebSocket, message: AnyMessage): Promise<void> {
  const payload = JSON.stringify(message);
  if (socket.bufferedAmount + Buffer.byteLength(payload) > SUBSCRIBER_BUFFER_BYTES) {
    socket.close(1009, "Subscriber too slow");
    return Promise.reject(new Error("subscriber buffer exceeded"));
  }
  return new Promise((resolve, reject) => {
    socket.send(payload, (error) => (error ? reject(error) : resolve()));
  });
}

function isMessage(value: unknown): value is AnyMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // SAFETY: The preceding checks establish only a non-null, non-array object record; the remaining branches inspect the JSON-RPC fields.
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") return false;
  const hasMethod = typeof record.method === "string";
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error");
  if (Number(hasMethod) + Number(hasResult) + Number(hasError) !== 1) return false;
  if (hasMethod && Object.hasOwn(record, "id") && !validId(record.id)) return false;
  if (!hasMethod && !validId(record.id)) return false;
  return true;
}

function validId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isInvalidRequestResponse(message: AnyMessage): boolean {
  if (!("error" in message)) return false;
  return message.error.code === -32600 || message.error.code === -32602;
}

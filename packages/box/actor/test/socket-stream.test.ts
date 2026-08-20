import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { socketStream } from "../src/socket-stream.js";

/** The `ws` surface socketStream touches: message/close/error events, close(),
 * and the buffer accounting the writable side checks. */
class FakeSocket extends EventEmitter {
  public closes: Array<{ code?: number; reason?: string }> = [];
  public readonly bufferedAmount = 0;

  public close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  public asWebSocket(): WebSocket {
    // SAFETY: socketStream only uses the event, close, send and bufferedAmount
    // members implemented above.
    return this as unknown as WebSocket;
  }
}

function frame(id: number): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "ping", id }));
}

describe("socketStream", () => {
  it("delivers frames until the reader cancels, then ignores later pushes", async () => {
    const socket = new FakeSocket();
    const { readable } = socketStream(socket.asWebSocket());
    const reader = readable.getReader();

    socket.emit("message", frame(1), false);
    expect(await reader.read()).toMatchObject({ done: false, value: { id: 1 } });

    await reader.cancel();
    expect(socket.closes).toHaveLength(1);

    // A frame that races the cancel must not reach the cancelled controller.
    // Enqueueing onto it throws, and the handler's catch would mistake that
    // for a malformed frame and close again with 1007.
    socket.emit("message", frame(2), false);
    socket.emit("close");
    socket.emit("error", new Error("late"));
    expect(socket.closes).toEqual([{ code: undefined, reason: undefined }]);
  });

  it("closes with a protocol error on a binary frame", () => {
    const socket = new FakeSocket();
    socketStream(socket.asWebSocket());
    socket.emit("message", frame(1), true);
    expect(socket.closes).toEqual([{ code: 1003, reason: "Text frames only" }]);
  });

  it("closes with an invalid-frame code on malformed JSON-RPC", () => {
    const socket = new FakeSocket();
    socketStream(socket.asWebSocket());
    socket.emit("message", Buffer.from("{not json"), false);
    expect(socket.closes).toEqual([{ code: 1007, reason: "Malformed ACP frame" }]);
  });
});

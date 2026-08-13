import { describe, expect, it } from "vitest";
import { createTtydSocket, ttydNeedsOwnOrigin } from "../src/components/ttyd-protocol.js";

describe("ttyd protocol", () => {
  it("uses ttyd's /ws endpoint, tty subprotocol, and binary JSON init frame", () => {
    let open: (() => void) | undefined;
    const sent: unknown[] = [];
    const created: { url?: string; protocols?: string[] } = {};

    class FakeWebSocket {
      public binaryType: BinaryType = "blob";

      public constructor(url: string | URL, protocols?: string | string[]) {
        created.url = String(url);
        created.protocols = typeof protocols === "string" ? [protocols] : protocols;
      }

      public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === "open") open = listener as () => void;
      }

      public send(data: unknown): void {
        sent.push(data);
      }
    }

    const socket = createTtydSocket(
      "http://localhost:7443/",
      { columns: 120, rows: 42 },
      FakeWebSocket as unknown as typeof WebSocket,
    );
    open?.();

    expect(created).toEqual({ url: "ws://localhost:7443/ws", protocols: ["tty"] });
    expect(socket.binaryType).toBe("arraybuffer");
    expect(sent).toHaveLength(1);
    expect(ArrayBuffer.isView(sent[0])).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(sent[0] as Uint8Array))).toEqual({
      AuthToken: "",
      columns: 120,
      rows: 42,
    });
  });

  it("uses ttyd's own page origin when --check-origin would reject the cockpit origin", () => {
    expect(ttydNeedsOwnOrigin("http://localhost:7443/", "http://127.0.0.1:5173")).toBe(true);
    expect(ttydNeedsOwnOrigin("http://127.0.0.1:5173/terminal/", "http://127.0.0.1:5173")).toBe(false);
  });
});

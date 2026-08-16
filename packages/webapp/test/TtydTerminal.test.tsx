import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_SUBMIT_EVENT, TtydTerminal } from "../src/TtydTerminal.js";

const harness = vi.hoisted(() => ({
  blur: vi.fn(),
  dataHandlers: [] as Array<(data: string) => void>,
  fit: vi.fn(),
  focus: vi.fn(),
  sockets: [] as Array<{
    binaryType: string;
    close: ReturnType<typeof vi.fn>;
    onclose: (() => void) | null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    onopen: (() => void) | null;
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    url: string;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly buffer = {
      active: {
        getLine: () => undefined,
        length: 0,
      },
    };
    readonly cols = 88;
    readonly rows = 27;
    readonly textarea = null;

    attachCustomKeyEventHandler() {}
    blur() {
      harness.blur();
    }
    dispose() {}
    focus() {
      harness.focus();
    }
    loadAddon() {}
    onData(handler: (data: string) => void) {
      harness.dataHandlers.push(handler);
      return { dispose() {} };
    }
    onRender() {
      return { dispose() {} };
    }
    open() {}
    write() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      harness.fit();
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose() {}
    onContextLoss() {}
  },
}));

vi.mock("../src/terminal-touch.js", () => ({
  isTouchInputDevice: () => false,
}));

vi.mock("../src/use-terminal-touch.js", () => ({
  useTerminalTouch: () => ({
    copySelection: async () => undefined,
    deselectSelection: () => undefined,
    selectionChip: { visible: false, x: 0, y: 0 },
    showPasteHint: false,
  }),
}));

class FakeWebSocket {
  static readonly OPEN = 1;
  binaryType = "";
  readonly close = vi.fn();
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onopen: (() => void) | null = null;
  readonly readyState = FakeWebSocket.OPEN;
  readonly send = vi.fn();

  constructor(readonly url: string) {
    harness.sockets.push(this);
  }
}

const roots: Root[] = [];
const resizeCallbacks: ResizeObserverCallback[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  harness.blur.mockClear();
  harness.dataHandlers.length = 0;
  harness.fit.mockClear();
  harness.focus.mockClear();
  harness.sockets.length = 0;
  resizeCallbacks.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    disconnect() {}
    observe() {}
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TtydTerminal retained lifecycle", () => {
  it("keeps an inactive terminal connected without accepting input, focus, or geometry", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(
      <TtydTerminal
        url="wss://workspace.test/ws"
        sessionType="terminal"
        sessionKey="hidden"
        active={false}
      />,
    ));
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());

    expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toEqual({ AuthToken: "" });
    expect(harness.focus).not.toHaveBeenCalled();
    expect(harness.fit).not.toHaveBeenCalled();
    expect(harness.blur).toHaveBeenCalled();

    harness.dataHandlers[0]?.("hidden input");
    window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, {
      detail: { data: "hidden submit" },
    }));
    resizeCallbacks[0]!([], {} as ResizeObserver);
    await act(async () => vi.advanceTimersByTimeAsync(200));

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("reuses the WebSocket, refocuses on activation, and cancels a queued hidden resize", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const render = async (active: boolean) => {
      await act(async () => root.render(
        <TtydTerminal
          url="wss://workspace.test/ws"
          sessionType="terminal"
          sessionKey="retained"
          active={active}
        />,
      ));
    };

    await render(true);
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());
    const sendsBeforeResize = socket.send.mock.calls.length;
    resizeCallbacks[0]!([], {} as ResizeObserver);

    await render(false);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(harness.sockets).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(sendsBeforeResize);

    const focusBeforeActivation = harness.focus.mock.calls.length;
    await render(true);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.focus.mock.calls.length).toBeGreaterThan(focusBeforeActivation);

    resizeCallbacks[0]!([], {} as ResizeObserver);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(new TextDecoder().decode(socket.send.mock.calls.at(-1)![0] as Uint8Array)).toBe(
      '1{"columns":88,"rows":27}',
    );
  });
});

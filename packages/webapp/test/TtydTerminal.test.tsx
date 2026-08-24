import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_SUBMIT_EVENT, TtydTerminal } from "../src/TtydTerminal.js";

const harness = vi.hoisted(() => ({
  blur: vi.fn(),
  dataHandlers: [] as Array<(data: string) => void>,
  dispose: vi.fn(),
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
    dispose() {
      harness.dispose();
    }
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
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  binaryType = "";
  readonly close = vi.fn();
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onopen: (() => void) | null = null;
  /** Writable, so a test can put a socket back into the reconnecting state
   * the component has to hold input through. */
  readyState: number = FakeWebSocket.OPEN;
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
  harness.dispose.mockClear();
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

  it("types an addressed sign-in submit onto the wire and leaves other tabs alone", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(
      <TtydTerminal
        url="wss://workspace.test/ws"
        sessionType="claude"
        sessionKey="7"
        active
      />,
    ));
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());
    const handshake = socket.send.mock.calls.length;

    // Addressed at a different tab: the claude session must not be typed into.
    window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, {
      detail: { data: "/login", enters: 0, sessionKey: "9" },
    }));
    expect(socket.send).toHaveBeenCalledTimes(handshake);

    for (const data of ["/login", "\r"]) {
      window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, {
        detail: { data, enters: 0, sessionKey: "7" },
      }));
    }
    await act(async () => vi.advanceTimersByTimeAsync(400));

    // enters: 0 arms no auto-Enter scanner, so the wire carries exactly the
    // slash command and the submit that were dispatched.
    expect(socket.send.mock.calls.slice(handshake).map(
      ([frame]) => new TextDecoder().decode(frame as Uint8Array),
    )).toEqual(["0/login", "0\r"]);
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

describe("TtydTerminal input delivery", () => {
  const decode = (frame: unknown) => new TextDecoder().decode(frame as Uint8Array);

  it("holds a paste sent while the socket is down and delivers it on reconnect", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(
      <TtydTerminal
        url="wss://workspace.test/ws"
        sessionType="claude"
        sessionKey="q"
        active
      />,
    ));
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());
    const handshake = socket.send.mock.calls.length;

    // A reconnect in flight. The paste used to vanish here without a word,
    // and claude answers an empty login code with "Invalid code" — the member
    // read that as a rejected sign-in.
    socket.readyState = FakeWebSocket.CONNECTING;
    window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, {
      detail: { data: "paste-code", enters: 0, sessionKey: "q" },
    }));
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(socket.send).toHaveBeenCalledTimes(handshake);

    socket.readyState = FakeWebSocket.OPEN;
    await act(async () => socket.onopen?.());
    expect(decode(socket.send.mock.calls.at(-1)![0])).toBe("0paste-code");
  });

  it("holds a keystroke typed while the tab is hidden until it is selected", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const render = async (active: boolean) => {
      await act(async () => root.render(
        <TtydTerminal
          url="wss://workspace.test/ws"
          sessionType="terminal"
          sessionKey="held"
          active={active}
        />,
      ));
    };

    await render(false);
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());
    const handshake = socket.send.mock.calls.length;

    harness.dataHandlers[0]?.("x");
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(socket.send).toHaveBeenCalledTimes(handshake);

    await render(true);
    expect(decode(socket.send.mock.calls.at(-1)![0])).toBe("0x");
  });

  it("never queues an observer's keystrokes", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(
      <TtydTerminal
        url="wss://workspace.test/ws"
        sessionType="claude"
        sessionKey="obs"
        active
        readOnly
      />,
    ));
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());
    const handshake = socket.send.mock.calls.length;

    // A viewer has no write path at all. Queuing here would type an
    // observer's keys into the tenant's session on the next reconnect.
    window.dispatchEvent(new CustomEvent(TERMINAL_SUBMIT_EVENT, {
      detail: { data: "rm -rf /", enters: 0, sessionKey: "obs" },
    }));
    await act(async () => socket.onopen?.());
    await act(async () => vi.advanceTimersByTimeAsync(400));
    // Handshakes go out as JSON strings; input goes out as encoded bytes. A
    // reconnect must produce the first and never the second.
    expect(socket.send.mock.calls.slice(handshake)
      .filter(([frame]) => frame instanceof Uint8Array)).toEqual([]);
  });
});

describe("TtydTerminal url stability", () => {
  const render = async (root: Root, url: string) => {
    await act(async () => root.render(
      <TtydTerminal url={url} sessionType="claude" sessionKey="blip" active />,
    ));
  };

  it("keeps the pane through a lifecycle blip that empties the url", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await render(root, "wss://workspace.test/ws");
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());
    const disposals = harness.dispose.mock.calls.length;

    // CloudApp nulls activeSessionUrl whenever lifecycleStatus stops reading
    // `running` or the endpoint row is momentarily absent, and renders ''.
    // Tearing the socket and xterm down for that lost whatever was typed.
    await render(root, "");
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(harness.sockets).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(harness.dispose.mock.calls.length).toBe(disposals);
  });

  it("still rebuilds when the endpoint really moves", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await render(root, "wss://workspace.test/ws");
    const socket = harness.sockets[0]!;
    await act(async () => socket.onopen?.());

    await render(root, "wss://moved.test/ws");
    expect(harness.sockets).toHaveLength(2);
    expect(socket.close).toHaveBeenCalled();
    expect(harness.sockets[1]!.url.startsWith("wss://moved.test/ws")).toBe(true);
  });
});

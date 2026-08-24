import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtydTerminal } from "../src/TtydTerminal.js";

const harness = vi.hoisted(() => ({
  keyHandlers: [] as Array<{ at: number; fn: (e: KeyboardEvent) => boolean }>,
  seq: { n: 0 },
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

const disposable = () => ({ dispose() {} });

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly buffer = {
      active: {
        baseY: 0,
        getLine: () => undefined,
        length: 0,
        type: "normal",
        viewportY: 0,
      },
      onBufferChange: () => disposable(),
    };
    readonly cols = 88;
    readonly rows = 27;
    readonly modes = { bracketedPasteMode: true };
    readonly parser = { registerOscHandler: () => disposable() };
    textarea: HTMLTextAreaElement | null = null;

    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      harness.seq.n += 1;
      harness.keyHandlers.push({ at: harness.seq.n, fn });
    }
    blur() {}
    clearSelection() {}
    dispose() {}
    focus() {}
    getSelection() { return ""; }
    hasSelection() { return false; }
    loadAddon() {}
    onData() { return disposable(); }
    onRender() { return disposable(); }
    onResize() { return disposable(); }
    onScroll() { return disposable(); }
    onSelectionChange() { return disposable(); }
    scrollToLine() {}
    select() {}
    write() {}

    // Build the real xterm DOM shape inside the host so the touch controller's
    // querySelector calls resolve exactly as they do in the browser.
    open(host: HTMLElement) {
      const xterm = document.createElement("div");
      xterm.className = "xterm";
      const viewport = document.createElement("div");
      viewport.className = "xterm-viewport";
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      const textarea = document.createElement("textarea");
      textarea.className = "xterm-helper-textarea";
      xterm.append(viewport, screen, textarea);
      host.append(xterm);
      this.textarea = textarea;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class { dispose() {} onContextLoss() {} },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class { dispose() {} },
}));
vi.mock("../src/terminal-touch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/terminal-touch.js")>()),
  isTouchInputDevice: () => false,
}));

class FakeSocket {
  binaryType = "";
  close = vi.fn();
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 1;
  send = vi.fn();
  constructor(readonly url: string) {
    harness.sockets.push(this as never);
  }
}

const decode = (frame: unknown) => new TextDecoder().decode(frame as Uint8Array);

let container: HTMLDivElement;
let root: Root;

/** Live count of capture-phase "paste" listeners on the terminal surface, plus
 * the lowest value it ever reached once the first one was bound. A rebind that
 * removes before it adds drives the low-water mark to 0 — that hole is the
 * window a real paste falls through. */
const pasteListeners = { live: 0, low: Number.POSITIVE_INFINITY };
/** When set, the next unbind fires the paste inside the hole it just opened. */
let pasteInTheGap: (() => void) | null = null;

const isSurface = (target: unknown): boolean => (
  target instanceof HTMLElement && target.classList.contains("terminal-surface")
);

describe("keyboard paste reaches the socket", () => {
  const nativeAdd = HTMLElement.prototype.addEventListener;
  const nativeRemove = HTMLElement.prototype.removeEventListener;

  beforeEach(() => {
    harness.sockets.length = 0;
    harness.keyHandlers.length = 0;
    harness.seq.n = 0;
    pasteListeners.live = 0;
    pasteListeners.low = Number.POSITIVE_INFINITY;
    pasteInTheGap = null;
    HTMLElement.prototype.addEventListener = function patchedAdd(
      this: HTMLElement,
      ...args: Parameters<typeof nativeAdd>
    ) {
      nativeAdd.apply(this, args);
      if (args[0] !== "paste" || !isSurface(this)) return;
      pasteListeners.live += 1;
      pasteListeners.low = Math.min(pasteListeners.low, pasteListeners.live);
    };
    HTMLElement.prototype.removeEventListener = function patchedRemove(
      this: HTMLElement,
      ...args: Parameters<typeof nativeRemove>
    ) {
      nativeRemove.apply(this, args);
      if (args[0] !== "paste" || !isSurface(this)) return;
      pasteListeners.live -= 1;
      pasteListeners.low = Math.min(pasteListeners.low, pasteListeners.live);
      const fire = pasteInTheGap;
      pasteInTheGap = null;
      fire?.();
    };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
    vi.stubGlobal("ResizeObserver", class {
      disconnect() {}
      observe() {}
      unobserve() {}
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLElement.prototype.addEventListener = nativeAdd;
    HTMLElement.prototype.removeEventListener = nativeRemove;
    vi.unstubAllGlobals();
  });

  const mount = (active: boolean) => {
    act(() => {
      root.render(
        <TtydTerminal
          url="wss://box.example/ws"
          sessionType="claude"
          sessionKey="0"
          active={active}
          onOpenPreview={() => false}
        />,
      );
    });
    act(() => {
      harness.sockets.at(-1)?.onopen?.();
    });
  };

  /** Dispatches the browser's own paste event at the xterm textarea, exactly
   * as a cmd/ctrl+V does once the custom key handler has let it through. */
  const dispatchPaste = (text: string) => {
    const textarea = container.querySelector(".xterm-helper-textarea");
    expect(textarea, "xterm textarea must exist").not.toBeNull();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => text },
    });
    textarea!.dispatchEvent(event);
    return event;
  };

  const firePaste = (text: string) => {
    let event: Event | undefined;
    act(() => {
      event = dispatchPaste(text);
    });
    return event!;
  };

  /** Frames the pane put on the wire, newest socket only. */
  const framesSince = (before: number) => harness.sockets
    .at(-1)!
    .send.mock.calls.slice(before)
    .map((call) => decode(call[0]));

  it("delivers a paste dispatched at the xterm textarea", () => {
    mount(true);
    const before = harness.sockets.at(-1)!.send.mock.calls.length;
    firePaste("BLITZPASTE_test_1234567890");
    expect(framesSince(before).join("")).toContain("BLITZPASTE_test_1234567890");
  });

  // A fresh box has no session url on the first renders: CloudApp passes
  // `activeSessionUrl ?? ''`. The real url lands only after the box phones
  // home. This is the transition a NEW workspace always goes through and a
  // warm one never does.
  it("FRESH BOX: delivers a paste after the session url lands", () => {
    act(() => {
      root.render(
        <TtydTerminal url="" sessionType="claude" sessionKey="0" active
          onOpenPreview={() => false} />,
      );
    });
    act(() => {
      root.render(
        <TtydTerminal url="wss://box.example/ws" sessionType="claude"
          sessionKey="0" active onOpenPreview={() => false} />,
      );
    });
    act(() => { harness.sockets.at(-1)?.onopen?.(); });

    const before = harness.sockets.at(-1)!.send.mock.calls.length;
    firePaste("BLITZPASTE_freshbox_1234567890");
    expect(framesSince(before).join("")).toContain("BLITZPASTE_freshbox_1234567890");
  });

  it("TAB SWITCH: delivers a paste after the pane goes inactive then active", () => {
    mount(true);
    const render = (active: boolean) => act(() => {
      root.render(
        <TtydTerminal url="wss://box.example/ws" sessionType="claude"
          sessionKey="0" active={active} onOpenPreview={() => false} />,
      );
    });
    render(false);
    render(true);

    const before = harness.sockets.at(-1)!.send.mock.calls.length;
    firePaste("BLITZPASTE_tabswitch_1234567890");
    expect(framesSince(before).join("")).toContain("BLITZPASTE_tabswitch_1234567890");
  });

  it("RERENDER THRASH: survives a new onOpenPreview identity each render", () => {
    mount(true);
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        root.render(
          <TtydTerminal url="wss://box.example/ws" sessionType="claude"
            sessionKey="0" active onOpenPreview={() => false} />,
        );
      });
    }
    const before = harness.sockets.at(-1)!.send.mock.calls.length;
    firePaste("BLITZPASTE_thrash_1234567890");
    expect(framesSince(before).join("")).toContain("BLITZPASTE_thrash_1234567890");
  });

  // The live defect. CloudApp hands the pane a new `onOpenPreview` arrow on
  // every render, that identity feeds the touch effect's deps, and the whole
  // controller rebinds. Each rebind removes the capture-phase paste listener
  // and clobbers the custom key handler before putting them back. A paste that
  // lands in that hole is gone: the key handler already suppressed xterm's own
  // path, and nothing else is listening.
  it("PASTE MID-CHURN: a paste landing in a rebind window still reaches the socket once", () => {
    mount(true);
    const before = harness.sockets.at(-1)!.send.mock.calls.length;
    const installsAfterMount = harness.keyHandlers.length;
    let fired = false;
    // Fire the paste inside the first hole the churn opens. With stable
    // bindings no hole opens, so fall through to a plain paste after the churn
    // — the assertion below is the same either way: one frame, no loss.
    pasteInTheGap = () => {
      fired = true;
      dispatchPaste("BLITZPASTE_midchurn_1234567890");
    };
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        root.render(
          <TtydTerminal url="wss://box.example/ws" sessionType="claude"
            sessionKey="0" active onOpenPreview={() => false} />,
        );
      });
    }
    pasteInTheGap = null;
    if (!fired) firePaste("BLITZPASTE_midchurn_1234567890");

    const frames = framesSince(before);
    const carrying = frames.filter((frame) => frame.includes("BLITZPASTE_midchurn_1234567890"));
    // No loss, and no duplication from an overlapping second listener.
    expect(carrying).toHaveLength(1);
    // The controller binds once per (surface, terminal) — never per render.
    expect(harness.keyHandlers.length - installsAfterMount).toBe(0);
    // The capture-phase paste listener is never absent once it exists.
    expect(pasteListeners.low).toBe(1);
  });

  // Shift+Enter is TtydTerminal's own custom key handler. The touch controller
  // wants the same single xterm slot for paste suppression; its teardown must
  // hand the slot back, not overwrite it with a permissive stub.
  it("SHIFT+ENTER: survives a touch-controller mount and unmount cycle", () => {
    mount(true);
    const socket = harness.sockets.at(-1)!;
    const pressShiftEnter = () => {
      const before = socket.send.mock.calls.length;
      const handled = harness.keyHandlers.at(-1)!.fn({
        altKey: false,
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        shiftKey: true,
        type: "keydown",
      } as KeyboardEvent);
      return {
        frames: socket.send.mock.calls.slice(before).map((call) => decode(call[0])),
        handled,
      };
    };
    expect(pressShiftEnter()).toEqual({ frames: ["0\x1b[13;2u"], handled: false });

    // Tab away and back: the touch controller unmounts and mounts again.
    const render = (active: boolean) => act(() => {
      root.render(
        <TtydTerminal url="wss://box.example/ws" sessionType="claude"
          sessionKey="0" active={active} onOpenPreview={() => false} />,
      );
    });
    render(false);
    render(true);
    expect(pressShiftEnter()).toEqual({ frames: ["0\x1b[13;2u"], handled: false });
  });
});

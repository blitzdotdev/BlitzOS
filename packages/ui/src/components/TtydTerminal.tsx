import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { endpointTarget } from "../resolver.js";
import { createTtydSocket, ttydNeedsOwnOrigin, ttydPageUrl } from "./ttyd-protocol.js";
import "@xterm/xterm/css/xterm.css";

const INPUT = "0".charCodeAt(0);
const OUTPUT = "0".charCodeAt(0);
const RESIZE = "1";

export function TtydTerminal({
  url,
  readOnly = false,
}: {
  url: string;
  readOnly?: boolean;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef<(text: string) => void>(() => undefined);
  const [status, setStatus] = useState("Connecting…");
  const [touchInput, setTouchInput] = useState("");
  const needsOwnOrigin = ttydNeedsOwnOrigin(url, window.location.origin);

  useEffect(() => {
    if (needsOwnOrigin) return;
    const host = hostRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 14,
      theme: { background: "#090c10", foreground: "#dce3ea", cursor: "#76e4c4" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const sendInput = (text: string): void => {
      if (readOnly || socket?.readyState !== WebSocket.OPEN) return;
      const bytes = encoder.encode(text);
      const frame = new Uint8Array(bytes.length + 1);
      frame[0] = INPUT;
      frame.set(bytes, 1);
      socket.send(frame);
    };
    sendRef.current = sendInput;

    const sendSize = (): void => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(encoder.encode(`${RESIZE}${JSON.stringify({ columns: terminal.cols, rows: terminal.rows })}`));
    };

    const receive = async (event: MessageEvent): Promise<void> => {
      let bytes: Uint8Array;
      if (event.data instanceof ArrayBuffer) bytes = new Uint8Array(event.data);
      else if (event.data instanceof Blob) bytes = new Uint8Array(await event.data.arrayBuffer());
      else bytes = encoder.encode(String(event.data));
      const command = bytes[0];
      const payload = bytes.subarray(1);
      if (command === OUTPUT) terminal.write(payload);
      else if (command === "1".charCodeAt(0)) document.title = decoder.decode(payload);
    };

    const connect = (): void => {
      if (!active) return;
      setStatus(attempts === 0 ? "Connecting…" : "Reconnecting…");
      socket = createTtydSocket(url, { columns: terminal.cols, rows: terminal.rows });
      socket.addEventListener("open", () => {
        attempts = 0;
        setStatus(readOnly ? "Connected · read only" : "Connected");
        sendSize();
        terminal.focus();
      });
      socket.addEventListener("message", (event) => void receive(event));
      socket.addEventListener("close", (event) => {
        if (!active || event.code === 1000) return;
        attempts += 1;
        setStatus("Disconnected");
        reconnectTimer = setTimeout(connect, Math.min(500 * 2 ** (attempts - 1), 10_000));
      });
      socket.addEventListener("error", () => setStatus("Connection error"));
      // Browser WebSocket answers ttyd ping control frames automatically.
    };

    const dataSubscription = terminal.onData(sendInput);
    const resizeSubscription = terminal.onResize(sendSize);
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(host);
    connect();

    return () => {
      active = false;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close(1000, "Panel closed");
      resizeObserver.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
      sendRef.current = () => undefined;
    };
  }, [needsOwnOrigin, readOnly, url]);

  const sendTouchInput = (): void => {
    if (touchInput.length === 0) return;
    sendRef.current(`${touchInput}\r`);
    setTouchInput("");
  };

  const paste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      sendRef.current(text);
    } catch {
      setStatus("Paste unavailable · use the input field");
    }
  };

  if (needsOwnOrigin) {
    return (
      <section className="panel terminal-panel">
        <div className="panel-toolbar">
          <span className="connection-status">{status}</span>
          <code className="endpoint-target">{endpointTarget(url)}</code>
        </div>
        <iframe
          className={`terminal-frame${readOnly ? " read-only" : ""}`}
          src={ttydPageUrl(url)}
          title="Terminal"
          tabIndex={readOnly ? -1 : undefined}
          onLoad={() => setStatus(readOnly ? "Connected · read only" : "Connected")}
        />
      </section>
    );
  }

  return (
    <section className="panel terminal-panel">
      <div className="panel-toolbar">
        <span className="connection-status">{status}</span>
        <code className="endpoint-target">{endpointTarget(url)}</code>
      </div>
      <div className="terminal-host" ref={hostRef} />
      {!readOnly && (
        <div className="terminal-input-row">
          <textarea
            aria-label="Terminal input"
            rows={1}
            value={touchInput}
            placeholder="Touch input or paste"
            onChange={(event) => setTouchInput(event.currentTarget.value)}
          />
          <button type="button" onClick={() => void paste()}>Paste</button>
          <button type="button" onClick={sendTouchInput}>Send</button>
        </div>
      )}
    </section>
  );
}

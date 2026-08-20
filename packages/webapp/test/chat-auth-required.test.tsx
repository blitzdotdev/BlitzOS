import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "../src/chat/ChatPanel.js";
import { render, settle } from "./dom.js";

type SocketListener = (event: { data: string }) => void;
type WireFrame = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

const sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  readonly readyState = FakeSocket.OPEN;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();

  public constructor(public readonly url: string) {
    sockets.push(this);
  }

  public addEventListener(type: string, listener: SocketListener): void {
    const existing = this.listeners.get(type) ?? new Set<SocketListener>();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  public removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {}

  /** Pushes one agent-to-client frame down the wire. */
  public deliver(frame: object): Promise<void> {
    return act(async () => {
      for (const listener of [...this.listeners.get("message") ?? []]) {
        listener({ data: JSON.stringify(frame) });
      }
    });
  }
}

/** Waits for the panel to issue one request, then answers it. */
async function answer(socket: FakeSocket, method: string, result: object): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = socket.sent
      // SAFETY: The panel writes JSON-RPC frames; only the id and method are read back out.
      .map((line) => JSON.parse(line) as WireFrame)
      .find((frame) => frame.method === method);
    if (request !== undefined) {
      await socket.deliver({ jsonrpc: "2.0", id: request.id, result });
      return;
    }
    await settle();
  }
  throw new Error(`the panel never sent ${method}; sent=${socket.sent.join(" ")}`);
}

/** Brings a panel up to the point where it is attached to an existing session. */
async function connectedPanel(readOnly: boolean, onSignIn: (provider: "claude" | "codex") => void) {
  const view = await render(
    <ChatPanel
      url="wss://workspace.test/acp"
      workspaceId="workspace-one"
      initialSessionId={null}
      onSessionId={() => undefined}
      onSignIn={onSignIn}
      readOnly={readOnly}
    />,
  );
  const socket = sockets[0]!;
  await answer(socket, "initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    authMethods: [],
  });
  await answer(socket, "session/list", { sessions: [{ sessionId: "session-one", cwd: "/workspace" }] });
  await answer(socket, "session/load", { configOptions: [] });
  return { socket, view };
}

function signInButton(container: HTMLElement): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.startsWith("Sign in to")) ?? null;
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat sign-in affordance", () => {
  it("offers the harness login only after the box reports it could not authenticate", async () => {
    const onSignIn = vi.fn();
    const { socket, view } = await connectedPanel(false, onSignIn);
    expect(signInButton(view.container)).toBeNull();

    await socket.deliver({
      jsonrpc: "2.0",
      method: "blitz/auth_required",
      params: { sessionId: "session-one", provider: "codex" },
    });

    const button = signInButton(view.container);
    expect(button?.textContent).toBe("Sign in to Codex");
    await act(async () => button?.click());
    expect(onSignIn).toHaveBeenCalledWith("codex");

    await view.unmount();
  });

  it("ignores the signal for another session and hides the affordance from viewers", async () => {
    const onSignIn = vi.fn();
    const editor = await connectedPanel(false, onSignIn);
    await editor.socket.deliver({
      jsonrpc: "2.0",
      method: "blitz/auth_required",
      params: { sessionId: "session-elsewhere", provider: "claude" },
    });
    expect(signInButton(editor.view.container)).toBeNull();
    await editor.view.unmount();

    sockets.length = 0;
    const viewer = await connectedPanel(true, onSignIn);
    await viewer.socket.deliver({
      jsonrpc: "2.0",
      method: "blitz/auth_required",
      params: { sessionId: "session-one", provider: "claude" },
    });
    expect(signInButton(viewer.view.container)).toBeNull();
    expect(onSignIn).not.toHaveBeenCalled();

    await viewer.view.unmount();
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "../src/chat/ChatPanel.js";
import { SPAWN_SESSION_LABELS } from "../src/WebAppHeader.js";
import { render, settle } from "./dom.js";

type SocketListener = (event: { data: string }) => void;
type WireFrame = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * The frames the box actor really emits when a mint fails, read from the
 * corpus both runtimes are pinned against.
 *
 * `blitz/auth_required` crosses the box-actor ↔ webapp boundary, so per
 * CLAUDE.md the fixture is the contract and neither side may hand-write its
 * own copy of the shape. `packages/box/actor/test/actor.test.ts` asserts the
 * emitted frame against this same file.
 */
function fixtureFrames(name: string): WireFrame[] {
  return readFileSync(resolve(process.cwd(), "../schema/fixtures/acp", name), "utf8")
    .trim()
    .split("\n")
    // SAFETY: The corpus holds one JSON-RPC frame per line; only method and params are read back out.
    .map((line) => JSON.parse(line) as WireFrame);
}

const authRequiredFixture = fixtureFrames("auth-required.jsonl");

/** The fixture frame, re-addressed to the session a test actually attached to. */
function forSession(frame: WireFrame | undefined, sessionId: string): WireFrame {
  if (frame === undefined) throw new Error("the auth-required fixture is missing a frame");
  return { ...frame, params: { ...frame.params, sessionId } };
}

const AUTH_REQUIRED = authRequiredFixture[0];
const AUTH_REQUIRED_BUBBLE = authRequiredFixture[1];

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
async function requestFor(socket: FakeSocket, method: string): Promise<WireFrame> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = socket.sent
      // SAFETY: The panel writes JSON-RPC frames; only the id and method are read back out.
      .map((line) => JSON.parse(line) as WireFrame)
      .find((frame) => frame.method === method);
    if (request !== undefined) {
      return request;
    }
    await settle();
  }
  throw new Error(`the panel never sent ${method}; sent=${socket.sent.join(" ")}`);
}

async function answer(socket: FakeSocket, method: string, result: object): Promise<void> {
  const request = await requestFor(socket, method);
  await socket.deliver({ jsonrpc: "2.0", id: request.id, result });
}

async function answerError(socket: FakeSocket, method: string, message: string): Promise<void> {
  const request = await requestFor(socket, method);
  await socket.deliver({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32_602, message },
  });
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

    await socket.deliver(forSession(AUTH_REQUIRED, "session-one"));

    // "Codex" is the fixture's provider spelled by the shared session-type
    // labels; a fixture that changes harness must fail here rather than
    // quietly render a different button.
    const button = signInButton(view.container);
    expect(button?.textContent).toBe("Sign in to Codex");
    // The panel spells harnesses with the tab strip's labels rather than a
    // second copy of them, so a rename lands in both places at once.
    expect(button?.textContent).toBe(`Sign in to ${SPAWN_SESSION_LABELS.codex}`);
    await act(async () => button?.click());
    expect(onSignIn).toHaveBeenCalledWith(AUTH_REQUIRED?.params?.provider);

    // The other half of the same event: the notification raises the
    // affordance, the journaled bubble is what a reader sees in the
    // transcript, now and on every later replay.
    await socket.deliver(forSession(AUTH_REQUIRED_BUBBLE, "session-one"));
    expect(view.container.textContent).toContain("Credential mint failed; the prompt was not sent.");

    await view.unmount();
  });

  it("ignores the signal for another session and hides the affordance from viewers", async () => {
    const onSignIn = vi.fn();
    const editor = await connectedPanel(false, onSignIn);
    await editor.socket.deliver(forSession(AUTH_REQUIRED, "session-elsewhere"));
    expect(signInButton(editor.view.container)).toBeNull();
    await editor.view.unmount();

    sockets.length = 0;
    const viewer = await connectedPanel(true, onSignIn);
    await viewer.socket.deliver(forSession(AUTH_REQUIRED, "session-one"));
    expect(signInButton(viewer.view.container)).toBeNull();
    expect(onSignIn).not.toHaveBeenCalled();

    await viewer.view.unmount();
  });
});

describe("chat session identity", () => {
  it("creates a distinct session for an explicitly new Chat tab without listing", async () => {
    const onSessionId = vi.fn();
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId={null}
        sessionIntent="create"
        onSessionId={onSessionId}
      />,
    );
    const socket = sockets[0]!;
    await answer(socket, "initialize", {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await answer(socket, "session/new", { sessionId: "fresh-session", configOptions: [] });
    expect(socket.sent.some((line) => (JSON.parse(line) as WireFrame).method === "session/list"))
      .toBe(false);
    expect(onSessionId).toHaveBeenCalledWith("workspace-one", "fresh-session");
    await view.unmount();
  });

  it("loads an exact stored id and never substitutes a listed session", async () => {
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId="stored-session"
        sessionIntent="load"
        onSessionId={() => undefined}
      />,
    );
    const socket = sockets[0]!;
    await answer(socket, "initialize", {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    const load = await requestFor(socket, "session/load");
    expect(load.params?.sessionId).toBe("stored-session");
    expect(socket.sent.some((line) => (JSON.parse(line) as WireFrame).method === "session/list"))
      .toBe(false);
    await socket.deliver({ jsonrpc: "2.0", id: load.id, result: { configOptions: [] } });
    await view.unmount();
  });

  it("recovers the newest session not already bound to another Chat tab", async () => {
    const onSessionId = vi.fn();
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId={null}
        sessionIntent="recover"
        boundSessionIds={["already-bound"]}
        onSessionId={onSessionId}
      />,
    );
    const socket = sockets[0]!;
    await answer(socket, "initialize", {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await answer(socket, "session/list", {
      sessions: [
        { sessionId: "already-bound", cwd: "/workspace" },
        { sessionId: "recover-me", cwd: "/workspace" },
      ],
    });
    const load = await requestFor(socket, "session/load");
    expect(load.params?.sessionId).toBe("recover-me");
    expect(onSessionId).toHaveBeenCalledWith("workspace-one", "recover-me");
    await socket.deliver({ jsonrpc: "2.0", id: load.id, result: { configOptions: [] } });
    await view.unmount();
  });

  it("surfaces recovery choices when an exact stored session cannot load", async () => {
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId="missing-session"
        sessionIntent="load"
        onSessionId={() => undefined}
      />,
    );
    const socket = sockets[0]!;
    await answer(socket, "initialize", {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await answerError(socket, "session/load", "unknown session");
    await settle();
    expect(view.container.textContent).toContain("saved session could not be loaded");
    expect([...view.container.querySelectorAll("button")].map(({ textContent }) => textContent))
      .toEqual(expect.arrayContaining(["Recover existing", "Start new chat"]));
    expect(socket.sent.some((line) => (JSON.parse(line) as WireFrame).method === "session/new"))
      .toBe(false);
    await view.unmount();
  });
});

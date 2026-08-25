import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "../src/chat/ChatPanel.js";
import type { ChatSessionStatus } from "../src/chat/ChatPanel.js";
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
    const requests = socket.sent
      // SAFETY: The panel writes JSON-RPC frames; only the id and method are read back out.
      .map((line) => JSON.parse(line) as WireFrame)
      .filter((frame) => frame.method === method);
    const request = requests.at(-1);
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
async function connectedPanel(
  readOnly: boolean,
  onStatusChange?: (status: ChatSessionStatus) => void,
) {
  const view = await render(
    <ChatPanel
      url="wss://workspace.test/acp"
      workspaceId="workspace-one"
      initialSessionId={null}
      onSessionId={() => undefined}
      onStatusChange={onStatusChange}
      readOnly={readOnly}
    />,
  );
  const socket = sockets[0]!;
  await answer(socket, "initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    authMethods: [],
  });
  await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-in" });
  await answer(socket, "session/list", { sessions: [{ sessionId: "session-one", cwd: "/workspace" }] });
  await answer(socket, "session/load", { configOptions: [] });
  return { socket, view };
}

async function enterMessage(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (textarea === null || valueSetter === undefined) throw new Error("chat textarea is unavailable");
  await act(async () => {
    valueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>(
    'button[aria-label="Send message"]',
  )?.click());
}

async function queueMessage(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (textarea === null || valueSetter === undefined) throw new Error("chat textarea is unavailable");
  await act(async () => {
    valueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
  })));
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat sign-in affordance", () => {
  it("gates a new Chat with one recheck notice when both providers are signed out", async () => {
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId={null}
        sessionIntent="create"
        onSessionId={() => undefined}
      />,
    );
    const socket = sockets[0]!;
    await answer(socket, "initialize", {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await answer(socket, "blitz/auth_status", { claude: "signed-out", codex: "signed-out" });
    await settle();

    expect(view.container.textContent).toContain("Sign in to start Chat");
    expect(socket.sent.some((line) => (JSON.parse(line) as WireFrame).method === "session/new"))
      .toBe(false);
    const gate = view.container.querySelector<HTMLElement>(".chat-auth-gate");
    expect(gate?.querySelectorAll("button")).toHaveLength(1);
    expect(gate?.querySelector("button")?.textContent).toBe("Check again");
    expect(gate?.textContent).not.toContain("Sign in to Claude");
    expect(gate?.textContent).not.toContain("Sign in to Codex");
    await view.unmount();
  });

  it("creates with the available provider and filters signed-out provider choices", async () => {
    const onSessionId = vi.fn();
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId={null}
        initialProvider="codex"
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
    await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-out" });
    const create = await requestFor(socket, "session/new");
    expect(create.params?._meta).toEqual({ "blitz/provider": "claude" });
    await socket.deliver({
      jsonrpc: "2.0",
      id: create.id,
      result: {
        sessionId: "claude-session",
        configOptions: [],
        _meta: { "blitz/provider": "claude" },
      },
    });
    await settle();
    expect(onSessionId).toHaveBeenCalledWith("workspace-one", "claude-session", "claude");

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Provider"]',
    )?.click());
    const providerOptions = [...view.container.querySelectorAll<HTMLElement>(
      '[role="listbox"][aria-label="Provider"] [role="option"]',
    )].map(({ textContent }) => textContent);
    expect(providerOptions).toEqual([expect.stringContaining("Claude")]);
    expect(providerOptions.join(" ")).not.toContain("Codex");
    await view.unmount();
  });

  it("offers Claude and Codex when both are authenticated and creates with the selected provider", async () => {
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId={null}
        initialProvider="codex"
        sessionIntent="create"
        onSessionId={() => undefined}
      />,
    );
    const socket = sockets[0]!;
    await answer(socket, "initialize", {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-in" });
    const create = await requestFor(socket, "session/new");
    expect(create.params?._meta).toEqual({ "blitz/provider": "codex" });
    await socket.deliver({
      jsonrpc: "2.0",
      id: create.id,
      result: {
        sessionId: "codex-session",
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.6-sol",
          options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
        }],
        _meta: { "blitz/provider": "codex" },
      },
    });
    await settle();
    expect(view.container.textContent).toContain("GPT-5.6-Sol");

    // CloudApp persists the new ACP id immediately and then rerenders this
    // same tab as "load". That must not lock provider selection before the
    // first conversational update.
    await act(async () => view.root.render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId="codex-session"
        initialProvider="codex"
        sessionIntent="load"
        onSessionId={() => undefined}
      />,
    ));
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Provider"]')?.disabled)
      .toBe(false);
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Provider"]',
    )?.click());
    const options = view.container.querySelector<HTMLElement>(
      '[role="listbox"][aria-label="Provider"]',
    )?.textContent;
    expect(options).toContain("Claude");
    expect(options).toContain("Codex");

    await socket.deliver({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "codex-session",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "message-one",
          content: { type: "text", text: "Keep this provider." },
        },
      },
    });
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="Provider"]')?.disabled)
      .toBe(true);
    await view.unmount();
  });

  it("uses the same single recheck notice after a live authentication failure", async () => {
    const { socket, view } = await connectedPanel(false);
    expect(view.container.querySelector(".chat-auth-gate")).toBeNull();

    await socket.deliver(forSession(AUTH_REQUIRED, "session-one"));

    const gate = view.container.querySelector<HTMLElement>(".chat-auth-gate");
    expect(gate?.textContent).toContain("Sign in to start Chat");
    expect(gate?.querySelectorAll("button")).toHaveLength(1);
    expect(gate?.querySelector("button")?.textContent).toBe("Check again");
    expect(view.container.textContent).not.toContain("could not authenticate on this workspace");

    // The other half of the same event: the notification raises the
    // affordance, the journaled bubble is what a reader sees in the
    // transcript, now and on every later replay.
    await socket.deliver(forSession(AUTH_REQUIRED_BUBBLE, "session-one"));
    expect(view.container.textContent).toContain("Credential mint failed; the prompt was not sent.");

    await view.unmount();
  });

  it("ignores the signal for another session and hides the affordance from viewers", async () => {
    const editor = await connectedPanel(false);
    await editor.socket.deliver(forSession(AUTH_REQUIRED, "session-elsewhere"));
    expect(editor.view.container.querySelector(".chat-auth-gate")).toBeNull();
    await editor.view.unmount();

    sockets.length = 0;
    const viewer = await connectedPanel(true);
    await viewer.socket.deliver(forSession(AUTH_REQUIRED, "session-one"));
    expect(viewer.view.container.querySelector(".chat-auth-gate")).toBeNull();

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
    await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-in" });
    await answer(socket, "session/new", { sessionId: "fresh-session", configOptions: [] });
    expect(socket.sent.some((line) => (JSON.parse(line) as WireFrame).method === "session/list"))
      .toBe(false);
    expect(onSessionId).toHaveBeenCalledWith("workspace-one", "fresh-session", "claude");
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
    await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-in" });
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
    await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-in" });
    await answer(socket, "session/list", {
      sessions: [
        { sessionId: "already-bound", cwd: "/workspace" },
        { sessionId: "recover-me", cwd: "/workspace", _meta: { provider: "codex" } },
      ],
    });
    const load = await requestFor(socket, "session/load");
    expect(load.params?.sessionId).toBe("recover-me");
    expect(onSessionId).toHaveBeenCalledWith("workspace-one", "recover-me", "codex");
    await socket.deliver({
      jsonrpc: "2.0",
      id: load.id,
      result: { configOptions: [], _meta: { "blitz/provider": "codex" } },
    });
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
    await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-in" });
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

describe("chat session lifecycle status", () => {
  it("reports ACP turn, permission, completion, failure, and cancellation states", async () => {
    const statuses: ChatSessionStatus[] = [];
    const { socket, view } = await connectedPanel(false, (status) => {
      statuses.push(status);
    });
    expect(statuses.at(-1)).toBe("idle");

    await enterMessage(view.container, "Change the file");
    expect(statuses.at(-1)).toBe("generating");

    await socket.deliver(forSession(fixtureFrames("permission.jsonl")[0], "session-one"));
    expect(statuses.at(-1)).toBe("needs-attention");
    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(({ textContent }) => textContent === "Allow once")?.click());
    expect(statuses.at(-1)).toBe("generating");

    await answer(socket, "session/prompt", { stopReason: "end_turn" });
    expect(statuses.at(-1)).toBe("done");

    await enterMessage(view.container, "Try again");
    await answer(socket, "session/prompt", { stopReason: "refusal" });
    expect(statuses.at(-1)).toBe("error");

    await enterMessage(view.container, "Stop this one");
    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(({ textContent }) => textContent?.includes("Stop"))?.click());
    expect(statuses.at(-1)).toBe("idle");
    await answer(socket, "session/prompt", { stopReason: "cancelled" });
    expect(statuses.at(-1)).toBe("idle");

    await view.unmount();
  });
});

describe("chat prompt queue and selections", () => {
  it("queues prompts during a turn, removes one, and drains the remainder once", async () => {
    const { socket, view } = await connectedPanel(false);
    await enterMessage(view.container, "First");
    await queueMessage(view.container, "Remove me");
    await queueMessage(view.container, "Run second");

    expect(view.container.textContent).toContain("Queued 1");
    expect(view.container.textContent).toContain("Remove me");
    expect(view.container.textContent).toContain("Run second");
    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(({ textContent }) => textContent === "Remove")?.click());

    await answer(socket, "session/prompt", { stopReason: "end_turn" });
    const second = await requestFor(socket, "session/prompt");
    expect(second.params?.prompt).toEqual([{ type: "text", text: "Run second" }]);
    expect(socket.sent.filter((line) => (JSON.parse(line) as WireFrame).method === "session/prompt"))
      .toHaveLength(2);
    await socket.deliver({ jsonrpc: "2.0", id: second.id, result: { stopReason: "end_turn" } });
    await view.unmount();
  });

  it("reapplies a valid saved selection after loading and reports the resulting config", async () => {
    const onConfigChange = vi.fn();
    const view = await render(
      <ChatPanel
        url="wss://workspace.test/acp"
        workspaceId="workspace-one"
        initialSessionId="stored-session"
        initialConfig={{ model: "claude-sonnet-5" }}
        onSessionId={() => undefined}
        onConfigChange={onConfigChange}
      />,
    );
    const socket = sockets[0]!;
    await answer(socket, "initialize", {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await answer(socket, "blitz/auth_status", { claude: "signed-in", codex: "signed-in" });
    await answer(socket, "session/load", {
      configOptions: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "claude-sonnet-5", name: "Sonnet 5" },
        ],
      }],
    });
    const setConfig = await requestFor(socket, "session/set_config_option");
    expect(setConfig.params).toMatchObject({
      sessionId: "stored-session",
      configId: "model",
      value: "claude-sonnet-5",
    });
    await socket.deliver({
      jsonrpc: "2.0",
      id: setConfig.id,
      result: {
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "claude-sonnet-5",
          options: [{ value: "claude-sonnet-5", name: "Sonnet 5" }],
        }],
      },
    });
    await settle();
    expect(onConfigChange).toHaveBeenCalledWith({ model: "claude-sonnet-5" });
    await view.unmount();
  });
});

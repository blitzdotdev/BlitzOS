import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ActorService } from "../src/actor.js";
import { CredentialSource } from "../src/credentials.js";
import { Journal } from "../src/journal.js";
import { ActorServer } from "../src/server.js";
import type { AdapterFactory, AgentAdapter, Provider, TurnInput } from "../src/types.js";

type Frame = Record<string, unknown> & { id?: string | number; method?: string; params?: Record<string, unknown> };

class Client {
  public readonly socket: WebSocket;
  private readonly inbox: Frame[] = [];
  private wake: (() => void) | undefined;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      this.inbox.push(JSON.parse(data.toString()) as Frame);
      this.wake?.();
      this.wake = undefined;
    });
  }

  public static open(url: string, origin?: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, origin ? { origin } : undefined);
      const client = new Client(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
    });
  }

  public send(frame: object | string): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  public async take(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as Frame;
      if (Date.now() >= deadline) throw new Error(`frame timeout; inbox=${JSON.stringify(this.inbox)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  public async initialize(id: string | number = "init"): Promise<void> {
    this.send({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await this.take((frame) => frame.id === id);
  }

  public async newSession(id = "new"): Promise<string> {
    this.send({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: "/workspace", mcpServers: [] } });
    const frame = await this.take((candidate) => candidate.id === id);
    return (frame.result as { sessionId: string }).sessionId;
  }

  public close(): void {
    this.socket.close();
  }
}

class FakeCredentials extends CredentialSource {
  public tokenValue: string | null = null;
  public failure = false;

  public override async token(_provider: Provider): Promise<string | null> {
    if (this.failure) throw new Error("mint failed");
    return this.tokenValue;
  }
}

type Running = { server: ActorServer; journal: Journal; credentials: FakeCredentials; url: string; dir: string };
const running: Running[] = [];

async function start(adapter: AgentAdapter, provider: Provider = "claude"): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "blitz-actor-"));
  const journal = new Journal(join(dir, "journal.db"));
  const credentials = new FakeCredentials(dir);
  const factory: AdapterFactory = () => adapter;
  const service = new ActorService(journal, credentials, factory, provider);
  const server = new ActorServer(service, "127.0.0.1", 0);
  const address = (await server.start()) as AddressInfo;
  const item = { server, journal, credentials, url: `ws://127.0.0.1:${address.port}`, dir };
  running.push(item);
  return item;
}

afterEach(async () => {
  for (const item of running.splice(0)) {
    await item.server.close();
    item.journal.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

function fixtureUpdates(): SessionUpdate[] {
  const here = fileURLToPath(new URL("../../../schema/fixtures/acp/", import.meta.url));
  const files = ["text-turn.jsonl", "tool-call.jsonl", "plan.jsonl"];
  const updates: SessionUpdate[] = [];
  for (const file of files) {
    const text = readFileSync(join(here, file), "utf8");
    for (const line of text.trim().split("\n")) {
      const frame = JSON.parse(line) as { method?: string; params?: { update?: SessionUpdate } };
      if (frame.method === "session/update" && frame.params?.update?.sessionUpdate !== "user_message_chunk") {
        updates.push(frame.params.update);
      }
    }
  }
  return updates;
}

describe("ACP actor", () => {
  test("admin drain closes every active websocket", async () => {
    const item = await start({ async runTurn() { return { stopReason: "end_turn" }; } });
    const first = await Client.open(item.url);
    const second = await Client.open(item.url);
    const closed = Promise.all([
      new Promise<void>((resolve) => first.socket.once("close", () => resolve())),
      new Promise<void>((resolve) => second.socket.once("close", () => resolve())),
    ]);
    const response = await fetch(item.url.replace("ws://", "http://") + "/admin/drain", {
      method: "POST",
    });
    expect(response.status).toBe(204);
    await closed;
  });

  test("uses fixture update order, preserves request IDs, and journals monotonic seq", async () => {
    const updates = fixtureUpdates();
    const adapter: AgentAdapter = {
      async runTurn(input) {
        for (const update of updates) await input.emit(update);
        return { stopReason: "end_turn" };
      },
    };
    const item = await start(adapter);
    const client = await Client.open(item.url);
    await client.initialize("initialize-fixture");
    const sessionId = await client.newSession("new-fixture");
    client.send({
      jsonrpc: "2.0",
      id: "prompt-fixture",
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Say hello." }] },
    });
    const observed: SessionUpdate[] = [];
    for (let index = 0; index < updates.length + 1; index += 1) {
      const frame = await client.take((candidate) => candidate.method === "session/update");
      observed.push((frame.params as { update: SessionUpdate }).update);
    }
    const terminal = await client.take((frame) => frame.id === "prompt-fixture");
    expect((terminal.result as { stopReason: string }).stopReason).toBe("end_turn");
    expect(observed.slice(1)).toEqual(updates);
    expect(item.journal.sequences(sessionId)).toEqual(observed.map((_value, index) => index + 1));
    expect(item.journal.terminals(sessionId)).toEqual(["end_turn"]);
    client.close();
  });

  test("cancel is explicit and converges exactly once", async () => {
    const adapter: AgentAdapter = {
      runTurn(input) {
        return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
      },
    };
    const item = await start(adapter);
    const client = await Client.open(item.url);
    await client.initialize();
    const sessionId = await client.newSession();
    client.send({ jsonrpc: "2.0", id: "turn", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "wait" }] } });
    await client.take((frame) => frame.method === "session/update");
    client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    const terminal = await client.take((frame) => frame.id === "turn");
    expect((terminal.result as { stopReason: string }).stopReason).toBe("cancelled");
    expect(item.journal.terminals(sessionId)).toEqual(["cancelled"]);
    client.close();
  });

  test("agent crash and mint failure terminate visibly without retry", async () => {
    let calls = 0;
    const item = await start({
      async runTurn() {
        calls += 1;
        throw new Error("crash");
      },
    });
    const client = await Client.open(item.url);
    await client.initialize();
    const sessionId = await client.newSession();
    client.send({ jsonrpc: "2.0", id: "crash", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "one" }] } });
    const crashText = await client.take(
      (frame) => frame.method === "session/update" && JSON.stringify(frame).includes("Agent stopped unexpectedly"),
    );
    expect(crashText).toBeTruthy();
    expect((await client.take((frame) => frame.id === "crash")).result).toEqual({ stopReason: "refusal" });
    item.credentials.failure = true;
    client.send({ jsonrpc: "2.0", id: "mint", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "two" }] } });
    expect(await client.take((frame) => frame.method === "session/update" && JSON.stringify(frame).includes("Credential mint failed"))).toBeTruthy();
    expect((await client.take((frame) => frame.id === "mint")).result).toEqual({ stopReason: "refusal" });
    expect(calls).toBe(1);
    expect(item.journal.terminals(sessionId)).toEqual(["refusal", "refusal"]);
    client.close();
  });

  test("session/load replays updates but never resends a prompt", async () => {
    let calls = 0;
    const item = await start({
      async runTurn(input) {
        calls += 1;
        await input.emit({ sessionUpdate: "agent_message_chunk", messageId: "once", content: { type: "text", text: "Render this once." } });
        return { stopReason: "end_turn" };
      },
    });
    const first = await Client.open(item.url);
    await first.initialize();
    const sessionId = await first.newSession();
    first.send({ jsonrpc: "2.0", id: "turn", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "go" }] } });
    await first.take((frame) => frame.id === "turn");
    first.close();
    const second = await Client.open(item.url);
    await second.initialize("re-init");
    second.send({ jsonrpc: "2.0", id: "load", method: "session/load", params: { sessionId, cwd: "/workspace", mcpServers: [] } });
    const replayed = await second.take((frame) => frame.method === "session/update" && JSON.stringify(frame).includes("Render this once"));
    expect(replayed).toBeTruthy();
    await second.take((frame) => frame.id === "load");
    expect(calls).toBe(1);
    second.close();
  });

  test("N subscribers receive an identical live stream and socket loss is isolated", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const item = await start({
      async runTurn(input) {
        await gate;
        await input.emit({ sessionUpdate: "agent_message_chunk", messageId: "same", content: { type: "text", text: "same" } });
        return { stopReason: "end_turn" };
      },
    });
    const first = await Client.open(item.url);
    const second = await Client.open(item.url);
    await first.initialize(1);
    await second.initialize(2);
    const sessionId = await first.newSession();
    second.send({ jsonrpc: "2.0", id: "load", method: "session/load", params: { sessionId, cwd: "/workspace", mcpServers: [] } });
    await second.take((frame) => frame.id === "load");
    first.send({ jsonrpc: "2.0", id: "turn", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "same" }] } });
    const firstUser = await first.take((frame) => frame.method === "session/update");
    const secondUser = await second.take((frame) => frame.method === "session/update");
    expect(firstUser.params).toEqual(secondUser.params);
    first.close();
    release();
    expect(await second.take((frame) => frame.method === "session/update" && JSON.stringify(frame).includes('"same"'))).toBeTruthy();
    second.close();
  });

  test("malformed frames, Origin rejection, and the 1 MiB cap isolate one connection", async () => {
    const item = await start({ async runTurn() { return { stopReason: "end_turn" }; } });
    await expect(Client.open(item.url, "https://evil.example")).rejects.toThrow();
    const bad = await Client.open(item.url);
    const good = await Client.open(item.url, "http://localhost:3000");
    await bad.initialize("bad-init");
    await good.initialize("good-init");
    const closed = new Promise<number>((resolve) => bad.socket.once("close", (code) => resolve(code)));
    bad.send("null");
    expect(await closed).toBe(1007);
    expect(await good.newSession("still-alive")).toMatch(/[0-9a-f-]{36}/);
    const huge = await Client.open(item.url);
    const capClose = new Promise<number>((resolve) => huge.socket.once("close", (code) => resolve(code)));
    huge.send("x".repeat(1_048_577));
    expect(await capClose).toBe(1009);
    good.close();
  });

  test("permission requests survive subscribers and accept one answer", async () => {
    const item = await start({
      async runTurn(input: TurnInput) {
        const answer = await input.requestPermission({
          sessionId: input.sessionId,
          toolCall: { toolCallId: "tool", title: "Delete build output", kind: "delete", status: "pending" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        await input.emit({
          sessionUpdate: "agent_message_chunk",
          messageId: "permission-result",
          content: { type: "text", text: answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled" },
        });
        return { stopReason: "end_turn" };
      },
    });
    const first = await Client.open(item.url);
    const second = await Client.open(item.url);
    await first.initialize(1);
    await second.initialize(2);
    const sessionId = await first.newSession();
    second.send({ jsonrpc: "2.0", id: "load", method: "session/load", params: { sessionId, cwd: "/workspace", mcpServers: [] } });
    await second.take((frame) => frame.id === "load");
    first.send({ jsonrpc: "2.0", id: "turn", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "delete" }] } });
    const request1 = await first.take((frame) => frame.method === "session/request_permission");
    const request2 = await second.take((frame) => frame.method === "session/request_permission");
    first.send({ jsonrpc: "2.0", id: request1.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    await first.take((frame) => frame.method === "session/update" && JSON.stringify(frame).includes("allow-once"));
    second.send({ jsonrpc: "2.0", id: request2.id, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
    await first.take((frame) => frame.id === "turn");
    expect(item.journal.answeredPermissions(sessionId)).toBe(1);
    expect(item.journal.pendingPermissions(sessionId)).toEqual([]);
    first.close();
    second.close();
  });

  test.each(["claude", "codex"] as const)("creates one %s adapter per session", async (provider) => {
    let factories = 0;
    const dir = mkdtempSync(join(tmpdir(), "blitz-provider-"));
    const journal = new Journal(join(dir, "journal.db"));
    const credentials = new FakeCredentials(dir);
    const service = new ActorService(
      journal,
      credentials,
      (selected) => {
        expect(selected).toBe(provider);
        factories += 1;
        return { async runTurn() { return { stopReason: "end_turn" }; } };
      },
      provider,
    );
    const server = new ActorServer(service, "127.0.0.1", 0);
    const address = await server.start();
    const client = await Client.open(`ws://127.0.0.1:${address.port}`);
    await client.initialize();
    await client.newSession();
    expect(factories).toBe(1);
    client.close();
    await server.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ActorService } from "../src/actor.js";
import { CredentialSource } from "../src/credentials.js";
import { Journal } from "../src/journal.js";
import type { JournalFrame } from "../src/journal.js";
import { ActorServer } from "../src/server.js";
import { asJsonObject, isString } from "../src/type-guards.js";
import type { AdapterFactory, AgentAdapter, Provider, TurnInput } from "../src/types.js";
import { ActorAuthenticator } from "../src/auth.js";

const ACTOR_TEST_SECRET = "actor-test-secret";
const ACTOR_TEST_ORIGIN = "http://localhost:3000";

function testAuthenticator(directory: string): ActorAuthenticator {
  const tokenPath = join(directory, "webapp-token");
  const workspacePath = join(directory, "workspace-id");
  writeFileSync(tokenPath, ACTOR_TEST_SECRET, { mode: 0o600 });
  writeFileSync(workspacePath, "actor-test-workspace", { mode: 0o600 });
  return new ActorAuthenticator(tokenPath, workspacePath);
}

function actorTicket(role: "editor" | "viewer", exp = Math.floor(Date.now() / 1_000) + 60): string {
  const payload = Buffer.from(JSON.stringify({
    workspaceId: "actor-test-workspace",
    userId: `${role}-user`,
    membershipId: `${role}-member`,
    role,
    exp,
  })).toString("base64url");
  const input = `v1.${payload}`;
  const signature = createHmac("sha256", ACTOR_TEST_SECRET).update(input).digest("base64url");
  return `${input}.${signature}`;
}

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

  public static open(url: string, origin = ACTOR_TEST_ORIGIN, token = ACTOR_TEST_SECRET): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        ...(origin === "" ? {} : { origin }),
        headers: { "X-Blitz-WebApp-Token": token },
      });
      const client = new Client(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
    });
  }

  public send(frame: object | string): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  public has(predicate: (frame: Frame) => boolean): boolean {
    return this.inbox.some(predicate);
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
  const server = new ActorServer(service, "127.0.0.1", 0, undefined, testAuthenticator(dir));
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

function fixtureFrames(name: string): Frame[] {
  const directory = fileURLToPath(new URL("../../../schema/fixtures/acp/", import.meta.url));
  return readFileSync(join(directory, name), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Frame);
}

/** The prose of a fixture `session/update` text bubble. */
function fixtureBubbleText(frame: Frame | undefined): string {
  const update = asJsonObject(frame?.params?.update);
  const text = asJsonObject(update?.content)?.text;
  if (!isString(text)) throw new Error("the fixture frame is not a text bubble");
  return text;
}

describe("ACP actor", () => {
  test("persists the shared attributed-event and session-list fixture shapes", () => {
    const directory = mkdtempSync(join(tmpdir(), "blitz-actor-fixture-"));
    const journal = new Journal(join(directory, "journal.db"));
    const attributed = fixtureFrames("attribution.jsonl")[2] as JournalFrame;
    journal.createSession({
      id: "session-attributed",
      provider: "claude",
      cwd: "/workspace",
      resumeId: null,
      createdBy: "user-alice",
      updatedAt: Date.parse("2026-08-16T00:00:00.000Z"),
    });
    const listed = journal.listSessions()[0];
    const fixtureInfo = ((fixtureFrames("session-list.jsonl")[1]?.result as { sessions: unknown[] }).sessions[0]);
    expect({
      sessionId: listed?.id,
      cwd: "/workspace",
      updatedAt: listed === undefined ? undefined : new Date(listed.updatedAt).toISOString(),
      _meta: { id: listed?.id, provider: listed?.provider, createdBy: listed?.createdBy },
    }).toMatchObject(fixtureInfo as object);
    journal.append("session-attributed", attributed);
    expect(JSON.parse(journal.replay("session-attributed", 10)[0]!.frame)).toEqual(attributed);
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  test("admin drain closes every active websocket", async () => {
    const item = await start({ async runTurn() { return { stopReason: "end_turn" }; } });
    const first = await Client.open(item.url);
    const second = await Client.open(item.url);
    const closed = Promise.all([
      new Promise<void>((resolve) => first.socket.once("close", () => resolve())),
      new Promise<void>((resolve) => second.socket.once("close", () => resolve())),
    ]);
    // Drain with no target closes every connection, so a valid ticket is not
    // enough to call it — only the control plane's workspace token.
    for (const role of ["viewer", "editor"] as const) {
      const refused = await fetch(item.url.replace("ws://", "http://") + "/admin/drain", {
        method: "POST",
        headers: { "X-Blitz-WebApp-Token": actorTicket(role) },
      });
      expect(refused.status).toBe(403);
    }

    const response = await fetch(item.url.replace("ws://", "http://") + "/admin/drain", {
      method: "POST",
      headers: { "X-Blitz-WebApp-Token": ACTOR_TEST_SECRET },
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

  test("session/list discovers workspace sessions and viewers are replay-only", async () => {
    const item = await start({ async runTurn() { return { stopReason: "end_turn" }; } });
    const editor = await Client.open(item.url, ACTOR_TEST_ORIGIN, actorTicket("editor"));
    await editor.initialize();
    const sessionId = await editor.newSession();
    const viewer = await Client.open(item.url, ACTOR_TEST_ORIGIN, actorTicket("viewer"));
    await viewer.initialize("viewer-init");
    viewer.send({ jsonrpc: "2.0", id: "list", method: "session/list", params: { cwd: "/workspace" } });
    const listed = await viewer.take((frame) => frame.id === "list");
    expect(listed.result).toMatchObject({
      sessions: [{
        sessionId,
        _meta: { id: sessionId, provider: "claude", createdBy: "editor-user" },
      }],
    });
    viewer.send({ jsonrpc: "2.0", id: "load", method: "session/load", params: { sessionId, cwd: "/workspace", mcpServers: [] } });
    await viewer.take((frame) => frame.id === "load");
    const participantDatabase = new Database(join(item.dir, "journal.db"), { readonly: true });
    expect(participantDatabase.prepare(
      "SELECT user_id, membership_id, role FROM participants WHERE session_id = ? ORDER BY user_id",
    ).all(sessionId)).toEqual([
      { user_id: "editor-user", membership_id: "editor-member", role: "editor" },
      { user_id: "viewer-user", membership_id: "viewer-member", role: "viewer" },
    ]);
    participantDatabase.close();
    viewer.send({ jsonrpc: "2.0", id: "viewer-new", method: "session/new", params: { cwd: "/workspace", mcpServers: [] } });
    expect(await viewer.take((frame) => frame.id === "viewer-new")).toHaveProperty("error");
    viewer.send({ jsonrpc: "2.0", id: "viewer-prompt", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "no" }] } });
    expect(await viewer.take((frame) => frame.id === "viewer-prompt")).toHaveProperty("error");
    editor.close();
    viewer.close();
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

  test("auth_required rides the live wire on a mint failure and is never journaled", async () => {
    // `blitz/auth_required` crosses the box-actor ↔ webapp boundary, so the
    // shape asserted here is the shared fixture rather than a copy written out
    // beside it — `webapp/test/chat-auth-required.test.tsx` and
    // `webapp/test/acp-reducer.test.ts` replay the same two lines. The actor
    // keeps its own `AuthRequiredFrame` because it ships standalone into the
    // box image and cannot depend on @blitzos/schema; this file is what stops
    // the two declarations drifting apart.
    const [announcement, bubble] = fixtureFrames("auth-required.jsonl");
    const provider = announcement?.params?.provider;
    if (provider !== "claude" && provider !== "codex") {
      throw new Error("the auth-required fixture no longer names a harness");
    }
    const item = await start({ async runTurn() { return { stopReason: "end_turn" }; } }, provider);
    const client = await Client.open(item.url);
    await client.initialize();
    const sessionId = await client.newSession();
    client.send({ jsonrpc: "2.0", id: "signed-in", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "one" }] } });
    expect((await client.take((frame) => frame.id === "signed-in")).result).toEqual({ stopReason: "end_turn" });
    // Every frame of a turn is written to the socket before its result, so an
    // empty inbox here is proof a signed-in turn stays silent.
    expect(client.has((frame) => frame.method === "blitz/auth_required")).toBe(false);

    item.credentials.failure = true;
    client.send({ jsonrpc: "2.0", id: "signed-out", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "two" }] } });
    const announced = await client.take((frame) => frame.method === "blitz/auth_required");
    // Whole frame, not just params: `jsonrpc` and `method` are as much of the
    // contract as the payload, and the only field a live session may differ on
    // is the session id the fixture cannot know.
    expect(announced).toEqual({ ...announcement, params: { ...announcement?.params, sessionId } });
    const journaledText = fixtureBubbleText(bubble);
    expect(await client.take((frame) => frame.method === "session/update" && JSON.stringify(frame).includes(journaledText))).toBeTruthy();
    await client.take((frame) => frame.id === "signed-out");

    // Replayed onto tomorrow's attach this would demand a sign-in the session
    // no longer needs, so the frame is live-only: the prose bubble persists,
    // the notification does not. That split is why the fixture carries both.
    // SAFETY: The journal stores frames this service wrote; the loose Frame shape only reads the method back out.
    const replayed = item.journal.replay(sessionId, 100).map(({ frame }) => JSON.parse(frame) as Frame);
    expect(replayed.some(({ method }) => method === "blitz/auth_required")).toBe(false);
    expect(replayed.some((frame) => JSON.stringify(frame).includes(journaledText))).toBe(true);
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
    await expect(Client.open(item.url, "")).rejects.toThrow();
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
    const attribution = await first.take((frame) => frame.method === "blitz/permission_answered");
    expect(attribution.params).toMatchObject({
      toolCallId: "tool",
      actor: { userId: "legacy-owner", name: "Legacy owner" },
    });
    await first.take((frame) => frame.method === "session/update" && JSON.stringify(frame).includes("allow-once"));
    second.send({ jsonrpc: "2.0", id: request2.id, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
    await first.take((frame) => frame.id === "turn");
    expect(item.journal.answeredPermissions(sessionId)).toBe(1);
    expect(item.journal.pendingPermissions(sessionId)).toEqual([]);
    const permissionDatabase = new Database(join(item.dir, "journal.db"), { readonly: true });
    expect(permissionDatabase.prepare(
      "SELECT responded_by, responded_name FROM permissions WHERE session_id = ?",
    ).get(sessionId)).toEqual({ responded_by: "legacy-owner", responded_name: "Legacy owner" });
    permissionDatabase.close();
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
    const server = new ActorServer(service, "127.0.0.1", 0, undefined, testAuthenticator(dir));
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

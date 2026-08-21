import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, reduceAcpFrame, type ChatState } from "../src/chat/reducer.js";

const fixturesDirectory = resolve(process.cwd(), "../schema/fixtures/acp");
const fixtureNames = readdirSync(fixturesDirectory).filter((name) => name.endsWith(".jsonl")).sort();

function frames(name: string): unknown[] {
  return readFileSync(`${fixturesDirectory}/${name}`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

function replay(name: string, state: ChatState = initialChatState): ChatState {
  return frames(name).reduce(reduceAcpFrame, state);
}

describe("ACP fixture reducer", () => {
  it("reconciles an in-flight prompt after session replay on reconnect", () => {
    const running = chatReducer(initialChatState, { type: "turn-started", turnId: "turn-1" });
    expect(running.running).toBe(true);
    const reconciled = chatReducer(running, { type: "reconcile-running" });
    expect(reconciled.running).toBe(false);
    expect(reconciled.pendingCalls).toEqual({});
  });

  it("replays every shared fixture file", () => {
    expect(fixtureNames).toEqual([
      "attribution.jsonl",
      "auth-required.jsonl",
      "malformed.jsonl",
      "permission.jsonl",
      "plan.jsonl",
      "replay.jsonl",
      "session-list.jsonl",
      "text-turn.jsonl",
      "tool-call.jsonl",
      "unknown-kind.jsonl",
    ]);
    for (const name of fixtureNames) expect(() => replay(name)).not.toThrow();
  });

  it("keeps only the persisted half of an auth_required announcement", () => {
    // The pair in this fixture is what the box really emits when a mint fails,
    // and the two halves land in different places. The transcript is rebuilt
    // from the journal on every attach, so it may only ever show the prose
    // bubble; the notification is live-only and belongs to the panel, which
    // raises a sign-in affordance no replay should resurrect.
    const state = replay("auth-required.jsonl");
    expect(state.messages["message-auth-required"]?.text)
      .toBe("Credential mint failed; the prompt was not sent.");
    expect(state.rows).toEqual([{ kind: "message", id: "message-auth-required" }]);
    expect(replay("auth-required.jsonl", initialChatState))
      .toEqual(reduceAcpFrame(initialChatState, frames("auth-required.jsonl")[1]));
  });

  it("retains event and permission-decision attribution", () => {
    const state = replay("attribution.jsonl");
    expect(state.messages["message-attributed"]?.actor).toEqual({ userId: "user-alice", name: "Alice" });
    expect(state.permissions["tool-attributed"]?.answeredBy).toEqual({ userId: "user-alice", name: "Alice" });
  });

  it("streams user and agent text and records one terminal stopReason", () => {
    const state = replay("text-turn.jsonl");
    expect(state.messages["message-user-1"]?.text).toBe("Say hello.");
    expect(state.messages["message-agent-1"]?.text).toBe("Hello from Blitz.");
    expect(state.running).toBe(false);
    expect(state.stopReasons).toEqual([{ turnId: "turn-text-1", stopReason: "end_turn" }]);
  });

  it("deduplicates replay chunks by message and accumulated text", () => {
    const state = replay("replay.jsonl");
    expect(state.messages["message-replay-1"]?.text).toBe("Render this once.");
    expect(state.seenText["message-replay-1"]).toEqual(["Render this once."]);
  });

  it("keys tool transitions by toolCallId", () => {
    const tool = replay("tool-call.jsonl").tools["tool-1"];
    expect(tool).toMatchObject({ toolCallId: "tool-1", kind: "execute", status: "completed", rawOutput: "README.md" });
  });

  it("fully replaces plan entries", () => {
    const state = replay("plan.jsonl");
    expect(state.plan).toHaveLength(2);
    expect(state.plan?.[0]?.status).toBe("completed");
    expect(state.plan?.[1]?.status).toBe("in_progress");
  });

  it("answers a permission at most once and preserves the answer across replay", () => {
    let state = replay("permission.jsonl");
    expect(state.permissions["tool-permission"]?.answeredOptionId).toBe("allow-once");
    state = chatReducer(state, { type: "permission-answered", toolCallId: "tool-permission", optionId: "reject-once" });
    expect(state.permissions["tool-permission"]?.answeredOptionId).toBe("allow-once");
    state = chatReducer(state, { type: "begin-replay" });
    state = reduceAcpFrame(state, frames("permission.jsonl")[0]);
    expect(state.permissions["tool-permission"]?.answeredOptionId).toBe("allow-once");
  });

  it("renders an unknown valid update as a safe generic row", () => {
    const state = replay("unknown-kind.jsonl");
    expect(state.rows).toContainEqual(expect.objectContaining({ kind: "generic", label: "Unsupported ACP update: future_update" }));
  });

  it("isolates malformed frames without corrupting existing state", () => {
    const baseline = replay("text-turn.jsonl");
    expect(replay("malformed.jsonl", baseline)).toBe(baseline);
  });
});

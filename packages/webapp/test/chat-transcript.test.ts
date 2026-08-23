import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chatReducer,
  initialChatState,
  reduceAcpFrame,
  type ChatState,
} from "../src/chat/reducer.js";
import { deriveChatTranscript } from "../src/chat/chat-turns.js";

const fixturesDirectory = resolve(process.cwd(), "../schema/fixtures/acp");

function replay(name: string): ChatState {
  return readFileSync(`${fixturesDirectory}/${name}`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown)
    .reduce(reduceAcpFrame, initialChatState);
}

function userTurn(state: ChatState, turnId: string, text: string): ChatState {
  let next = chatReducer(state, { type: "turn-started", turnId });
  next = chatReducer(next, {
    type: "update",
    update: {
      sessionUpdate: "user_message_chunk",
      messageId: `${turnId}-user`,
      content: { type: "text", text },
    },
  });
  return chatReducer(next, {
    type: "update",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: `${turnId}-agent`,
      content: { type: "text", text: `re: ${text}` },
    },
  });
}

describe("chat transcript derivation", () => {
  it("groups a settled fixture turn with a successful synthetic result", () => {
    const derived = deriveChatTranscript(replay("text-turn.jsonl"));
    expect(derived.entries).toHaveLength(1);
    const entry = derived.entries[0];
    if (entry?.kind !== "turn") throw new Error("expected a turn entry");
    expect(entry.turn.prompt.text).toBe("Say hello.");
    expect(entry.turn.status).toBe("complete");
    expect(entry.turn.result?.meta.success).toBe(true);
    expect(entry.turn.finalAssistantId).toBeDefined();
  });

  it("indexes fixture tool calls into the shared result map", () => {
    const derived = deriveChatTranscript(replay("tool-call.jsonl"));
    expect(derived.toolResults["tool-1"]).toMatchObject({ isError: false });
  });

  it("keeps rows before the first prompt loose", () => {
    const state = chatReducer(initialChatState, { type: "generic", label: "connected late" });
    const derived = deriveChatTranscript(userTurn(state, "turn-1", "hi"));
    expect(derived.entries[0]).toMatchObject({
      kind: "loose",
      item: { kind: "system", text: "connected late" },
    });
    expect(derived.entries[1]?.kind).toBe("turn");
  });

  it("marks the open turn working with its streaming assistant in flight", () => {
    const running = userTurn(initialChatState, "turn-1", "hi");
    const derived = deriveChatTranscript(running);
    const entry = derived.entries[0];
    if (entry?.kind !== "turn") throw new Error("expected a turn entry");
    expect(entry.turn.status).toBe("working");
    expect(entry.turn.result).toBeUndefined();
    const assistant = entry.turn.items.find((item) => item.kind === "assistant");
    expect(assistant).toMatchObject({ inFlight: true });
  });

  it("settles earlier turns successfully and the last turn from its stop reason", () => {
    let state = userTurn(initialChatState, "turn-1", "first");
    state = chatReducer(state, { type: "turn-ended", turnId: "turn-1", stopReason: "end_turn" });
    state = userTurn(state, "turn-2", "second");
    state = chatReducer(state, { type: "turn-ended", turnId: "turn-2", stopReason: "refusal" });
    const derived = deriveChatTranscript(state);
    expect(derived.entries.map((entry) => entry.kind)).toEqual(["turn", "turn"]);
    const [first, second] = derived.entries;
    if (first?.kind !== "turn" || second?.kind !== "turn") throw new Error("expected turns");
    expect(first.turn.status).toBe("complete");
    expect(second.turn.status).toBe("failed");
    expect(second.turn.result?.meta.success).toBe(false);
  });

  it("surfaces only an unanswered permission as active", () => {
    const state = replay("permission.jsonl");
    const derived = deriveChatTranscript(state);
    expect(derived.activePermission).toBeNull();
    const answered = chatReducer(state, {
      type: "permission-request",
      request: {
        sessionId: "session-permission",
        toolCall: { toolCallId: "tool-unanswered", title: "Write file" },
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      },
    });
    expect(deriveChatTranscript(answered).activePermission?.toolCallId).toBe("tool-unanswered");
  });
});

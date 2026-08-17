import type { SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  agentConfigOptions,
  applyAgentConfig,
  defaultAgentConfig,
} from "../src/agent-config.js";
import { claudeEffort, claudeStreamChunk } from "../src/adapters/claude.js";
import { codexConfigArguments, codexThreadRequestParams } from "../src/adapters/codex.js";

describe("agent config selectors", () => {
  it("offers model, effort, and permission selectors for both providers", () => {
    const claude = agentConfigOptions("claude", defaultAgentConfig("claude"));
    const codex = agentConfigOptions("codex", defaultAgentConfig("codex"));

    expect(claude.map(({ id }) => id)).toEqual(["model", "effort", "permission"]);
    expect(codex.map(({ id }) => id)).toEqual(["model", "effort", "permission"]);
    expect(claude.map(({ category }) => category)).toEqual(["model", "thought_level", "mode"]);
    expect(codex[1]?.category).toBe("thought_level");
  });

  it("maps claude effort choices to SDK levels and leaves default alone", () => {
    expect(claudeEffort("default")).toBeUndefined();
    expect(claudeEffort("")).toBeUndefined();
    expect(claudeEffort("ludicrous")).toBeUndefined();
    expect(claudeEffort("low")).toBe("low");
    expect(claudeEffort("xhigh")).toBe("xhigh");
    expect(claudeEffort("max")).toBe("max");
    const chosen = applyAgentConfig("claude", defaultAgentConfig("claude"), "effort", "high");
    expect(chosen.effort).toBe("high");
  });

  it("keeps only known values and reflects the change in the option list", () => {
    const start = defaultAgentConfig("codex");
    const chosen = applyAgentConfig("codex", start, "effort", "high");
    const ignored = applyAgentConfig("codex", chosen, "effort", "ludicrous");
    const unknownOption = applyAgentConfig("codex", chosen, "temperature", "high");

    expect(chosen.effort).toBe("high");
    expect(ignored).toEqual(chosen);
    expect(unknownOption).toEqual(chosen);
    const effort = agentConfigOptions("codex", chosen).find(({ id }) => id === "effort");
    expect(effort?.type === "select" && effort.currentValue).toBe("high");
  });

  it("passes the chosen codex model, effort, and approval policy to the CLI", () => {
    const config = { model: "gpt-5", effort: "high", permission: "never" };

    expect(codexConfigArguments(config)).toEqual([
      "-c", 'model="gpt-5"',
      "-c", 'model_reasoning_effort="high"',
    ]);
    expect(codexConfigArguments({ ...config, model: "default", effort: "" })).toEqual([]);
    expect(codexThreadRequestParams({ resumeId: null, cwd: "/workspace", config }).approvalPolicy)
      .toBe("never");
  });
});

describe("claude stream chunks", () => {
  // Each SDK stream record carries its own uuid; only message_start may roll the id.
  const start = (uuid: string): SDKMessage => streamMessage(uuid, {
    type: "message_start",
    // SAFETY: claudeStreamChunk reads only event.type here, so the message envelope stays empty.
    message: {} as never,
  });
  const delta = (uuid: string, text: string): SDKMessage => streamMessage(uuid, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });

  it("keeps every delta of one assistant message under a single message id", () => {
    const stream = [
      start("msg-1"),
      delta("evt-a", "Hello! What"),
      delta("evt-b", " can I help"),
      delta("evt-c", " you with today?"),
    ];

    let messageId = "turn-1";
    const emitted: { messageId: string; text: string }[] = [];
    for (const message of stream) {
      const chunk = claudeStreamChunk(message, messageId);
      messageId = chunk.messageId;
      if (chunk.text !== undefined) emitted.push({ messageId, text: chunk.text });
    }

    expect(new Set(emitted.map((chunk) => chunk.messageId))).toEqual(new Set(["msg-1"]));
    expect(emitted.map((chunk) => chunk.text).join("")).toBe("Hello! What can I help you with today?");
  });

  it("starts a second message when the stream reports another message_start", () => {
    const first = claudeStreamChunk(start("msg-1"), "turn-1");
    const second = claudeStreamChunk(start("msg-2"), first.messageId);

    expect(first.messageId).toBe("msg-1");
    expect(second.messageId).toBe("msg-2");
  });
});

function streamMessage(uuid: string, event: SDKPartialAssistantMessage["event"]): SDKMessage {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    // SAFETY: UUID is a branded string in the SDK; these fixtures supply readable stand-ins.
    uuid: uuid as SDKPartialAssistantMessage["uuid"],
    session_id: "session-1",
  };
}

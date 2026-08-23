import { describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { codexThreadRequestParams } from "../src/adapters/codex.js";
import { defaultAgentConfig } from "../src/agent-config.js";
import type { TurnInput } from "../src/types.js";

// Claude's turn output and options are asserted through runTurn, the produced
// boundary, with the SDK's `query` stubbed: the SDK reads `resume` as
// `if (resume) push('--resume=…')` and nothing reads key order, but the ACP
// result frame is JSON.stringify(output), so key omission is wire-visible.
//
// Codex is different and keeps its direct params test: that object IS the
// JSON-RPC wire.
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

function engineRun(...messages: Array<Record<string, unknown>>): void {
  queryMock.mockImplementationOnce(() =>
    (async function* () {
      // SAFETY: test fixtures stand in for engine messages; runTurn reads only
      // the fields supplied here.
      for (const message of messages) yield message as unknown as SDKMessage;
    })(),
  );
}

function turnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    sessionId: "session-fixture",
    turnId: "turn-1",
    cwd: "/workspace",
    prompt: [{ type: "text", text: "Say hello." }],
    resumeId: null,
    signal: new AbortController().signal,
    token: null,
    environment: { HOME: "/var/lib/blitz/home" },
    config: defaultAgentConfig("claude"),
    emit: async () => undefined,
    requestPermission: async () => {
      throw new Error("no permission request belongs in these turns");
    },
    ...overrides,
  };
}

function lastQueryOptions(): Record<string, unknown> {
  // SAFETY: the adapter always calls query({ prompt, options }); the fixture
  // above was invoked before this reader.
  const call = queryMock.mock.calls.at(-1) as [{ options: Record<string, unknown> }] | undefined;
  if (!call) throw new Error("query was not called");
  return call[0].options;
}

describe("adapter object omission contracts", () => {
  it("keeps resumeId absent from a fresh Claude turn's output", async () => {
    engineRun({ type: "result", subtype: "success", uuid: "result-1" });
    const output = await new ClaudeAdapter().runTurn(turnInput());

    expect(Object.keys(output)).toEqual(["stopReason"]);
    expect("resumeId" in output).toBe(false);
    expect(JSON.stringify(output)).toBe('{"stopReason":"end_turn"}');
  });

  it("carries the engine's session id out as resumeId", async () => {
    engineRun({ type: "result", subtype: "success", session_id: "session-1", uuid: "result-1" });
    const output = await new ClaudeAdapter().runTurn(turnInput());

    expect(Object.keys(output)).toEqual(["stopReason", "resumeId"]);
    expect("resumeId" in output).toBe(true);
    expect(JSON.stringify(output)).toBe('{"stopReason":"end_turn","resumeId":"session-1"}');
  });

  it("forwards catalog config to the engine and omits every 'default'", async () => {
    engineRun({ type: "result", subtype: "success", uuid: "result-1" });
    await new ClaudeAdapter().runTurn(turnInput());
    const defaults = lastQueryOptions();
    expect(defaults.permissionMode).toBe("bypassPermissions");
    expect("model" in defaults).toBe(false);
    expect("effort" in defaults).toBe(false);
    expect("resume" in defaults).toBe(false);

    engineRun({ type: "result", subtype: "success", uuid: "result-2" });
    await new ClaudeAdapter().runTurn(turnInput({
      resumeId: "resume-1",
      config: { model: "claude-fable-5", effort: "max", permission: "plan" },
    }));
    const pinned = lastQueryOptions();
    expect(pinned.model).toBe("claude-fable-5");
    expect(pinned.effort).toBe("max");
    expect(pinned.permissionMode).toBe("plan");
    expect(pinned.resume).toBe("resume-1");
  });

  it("preserves Codex threadId omission before later request fields", () => {
    const config = defaultAgentConfig("codex");
    const absent = codexThreadRequestParams({ resumeId: null, cwd: "/workspace", config });
    expect(Object.keys(absent)).toEqual(["cwd", "approvalPolicy", "sandbox"]);
    expect("threadId" in absent).toBe(false);
    expect(JSON.stringify(absent)).toBe(
      `{"cwd":"/workspace","approvalPolicy":"never","sandbox":"workspace-write"}`,
    );

    const present = codexThreadRequestParams({ resumeId: "thread-1", cwd: "/workspace", config });
    expect(Object.keys(present)).toEqual(["threadId", "cwd", "approvalPolicy", "sandbox"]);
    expect("threadId" in present).toBe(true);
    expect(JSON.stringify(present)).toBe(
      `{"threadId":"thread-1","cwd":"/workspace","approvalPolicy":"never","sandbox":"workspace-write"}`,
    );
  });
});

import { describe, expect, it } from "vitest";
import { claudeTurnOutput } from "../src/adapters/claude.js";
import { codexThreadRequestParams } from "../src/adapters/codex.js";
import { defaultAgentConfig } from "../src/agent-config.js";

// Claude's `resume` used to have a helper and a block of its own here. It does
// not need one: the SDK reads that option as `if (resume) push('--resume=…')`,
// so an absent key and an undefined one are the same argv, and nothing reads
// the object's key order. The conditional spread at the call site keeps the key
// absent anyway, and `Options` typing — not a runtime assertion — is what keeps
// a second token-delivery hook off the object.
//
// Codex is the opposite and stays: its params object IS the JSON-RPC wire.
describe("adapter object omission contracts", () => {
  it("preserves Claude turn-output resume omission", () => {
    const absent = claudeTurnOutput("end_turn", undefined);
    expect(Object.keys(absent)).toEqual(["stopReason"]);
    expect("resumeId" in absent).toBe(false);
    expect(JSON.stringify(absent)).toBe('{"stopReason":"end_turn"}');

    const present = claudeTurnOutput("end_turn", "session-1");
    expect(Object.keys(present)).toEqual(["stopReason", "resumeId"]);
    expect("resumeId" in present).toBe(true);
    expect(JSON.stringify(present)).toBe('{"stopReason":"end_turn","resumeId":"session-1"}');
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

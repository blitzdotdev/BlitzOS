import { describe, expect, it } from "vitest";
import {
  claudeOptionalOptions,
  claudeTurnOutput,
} from "../src/adapters/claude.js";
import { codexThreadRequestParams } from "../src/adapters/codex.js";
import { defaultAgentConfig } from "../src/agent-config.js";
import { PREVIEW_GUIDANCE } from "../src/preview-guidance.js";

describe("adapter object omission contracts", () => {
  it("preserves Claude optional-key absence and insertion order", () => {
    const absent = claudeOptionalOptions({ resumeId: null });
    expect(Object.keys(absent)).toEqual([]);
    expect("resume" in absent).toBe(false);
    expect(JSON.stringify(absent)).toBe("{}");

    const present = claudeOptionalOptions({ resumeId: "session-1" });
    expect(Object.keys(present)).toEqual(["resume"]);
    expect("resume" in present).toBe(true);
    expect(JSON.stringify(present)).toBe('{"resume":"session-1"}');
  });

  // The token no longer travels on the options object at all: `getOAuthToken`
  // is not an SDK option, it was bolted on with an intersection type, and it
  // reached no code path in the shipped SDK. It is gone, and this pins that it
  // stays gone rather than quietly returning as a second delivery mechanism.
  it("carries no token on the Claude options object", () => {
    const present: Record<string, unknown> = claudeOptionalOptions({ resumeId: "session-1" });
    expect("getOAuthToken" in present).toBe(false);
    expect("token" in present).toBe(false);
  });

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
    expect(Object.keys(absent)).toEqual(["cwd", "approvalPolicy", "sandbox", "developerInstructions"]);
    expect("threadId" in absent).toBe(false);
    expect(JSON.stringify(absent)).toBe(
      `{"cwd":"/workspace","approvalPolicy":"never","sandbox":"workspace-write","developerInstructions":${JSON.stringify(PREVIEW_GUIDANCE)}}`,
    );

    const present = codexThreadRequestParams({ resumeId: "thread-1", cwd: "/workspace", config });
    expect(Object.keys(present)).toEqual(["threadId", "cwd", "approvalPolicy", "sandbox", "developerInstructions"]);
    expect("threadId" in present).toBe(true);
    expect(JSON.stringify(present)).toBe(
      `{"threadId":"thread-1","cwd":"/workspace","approvalPolicy":"never","sandbox":"workspace-write","developerInstructions":${JSON.stringify(PREVIEW_GUIDANCE)}}`,
    );
  });
});

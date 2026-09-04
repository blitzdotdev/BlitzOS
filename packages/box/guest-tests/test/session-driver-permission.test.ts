import { describe, expect, it } from "vitest";
import { PermissionResponseMessageSchema } from "@lody/shared/message-schemas";
import {
  answerSessionPermissions,
  pendingPermissionRequests,
  type PermissionHistoryEntry,
  type PermissionMode,
  type PermissionResponseMessage,
} from "../../test/payload-lab/session-driver/permission-response.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";

function emittedPermissionRequest(): PermissionHistoryEntry[] {
  return [{
    items: [{
      type: "tool_call",
      toolCallId: "tool-1",
      title: "Run shell command",
      rawInput: { command: "ls /workspace" },
      permissionRequest: {
        requestId: "permission-1",
        options: [
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Not this time", kind: "reject_once" },
        ],
      },
    }],
  }];
}

async function driveStandIn(permissions: PermissionMode) {
  const responses: PermissionResponseMessage[] = [];
  const logs: string[] = [];
  await answerSessionPermissions({
    sessionId,
    permissions,
    history: emittedPermissionRequest(),
    answeredRequestIds: new Set(),
    respond: async (response) => {
      const parsed = PermissionResponseMessageSchema.safeParse(response);
      if (!parsed.success) throw parsed.error;
      responses.push(response);
    },
    log: (line) => logs.push(line),
  });
  return { responses, logs };
}

describe("headless session-driver permission responses", () => {
  it("answers allow with the one-turn option and the browser response shape", async () => {
    const { responses, logs } = await driveStandIn("allow");

    expect(responses).toEqual([{
      type: "session/permission_response",
      sessionId,
      requestId: "permission-1",
      outcome: { outcome: "selected", optionId: "once" },
    }]);
    expect(logs).toEqual(["permission permission-1 -> once (ls /workspace)"]);
  });

  it("answers deny with the reject option", async () => {
    const { responses } = await driveStandIn("deny");
    expect(responses[0]?.outcome.optionId).toBe("no");
  });

  it("leaves ask pending for wait to report", async () => {
    const { responses } = await driveStandIn("ask");
    expect(responses).toEqual([]);
    expect(pendingPermissionRequests(emittedPermissionRequest())).toEqual([{
      requestId: "permission-1",
      options: expect.any(Array),
      toolSummary: "ls /workspace",
    }]);
  });
});

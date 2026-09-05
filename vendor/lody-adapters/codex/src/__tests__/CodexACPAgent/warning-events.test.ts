import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from "../acp-test-utils";

describe("CodexEventHandler - warning events", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    it("sends runtime and configuration warnings as structured session metadata", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "warning",
                params: {
                    threadId: sessionId,
                    message: "Falling back from WebSockets to HTTPS transport. unexpected status 401",
                },
            },
            {
                method: "configWarning",
                params: {
                    summary: "Project configuration could not be loaded",
                    details: "Using the default configuration instead.",
                },
            },
        ];

        await setupPromptAndSendNotifications(
            mockFixture,
            sessionId,
            createTestSessionState({ sessionId }),
            notifications,
        );

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/warning-events.json",
        );
    });
});

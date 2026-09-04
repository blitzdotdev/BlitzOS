import * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it} from "vitest";
import {LODY_READ_SESSION_HISTORY_METHOD} from "../AcpExtensions";
import type {CodexAcpServer} from "../CodexAcpServer";
import {createCodexAcpApp} from "../CodexAcpApp";

describe("Lody read-session-history transport", () => {
    it("routes the advertised method over an ACP connection", async () => {
        const app = createCodexAcpApp({
            name: "read-session-history-test",
            createAgent() {
                return {
                    async readSessionHistory(params: Record<string, unknown>) {
                        return {params};
                    },
                } as unknown as CodexAcpServer;
            },
        });

        const response = await acp.client({name: "read-session-history-client"})
            .connectWith(app, connection => connection.request(
                LODY_READ_SESSION_HISTORY_METHOD,
                {sessionId: "session-1"},
            ));

        expect(response).toEqual({
            params: {
                sessionId: "session-1",
            },
        });
    });
});

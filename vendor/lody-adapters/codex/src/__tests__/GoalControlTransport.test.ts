import * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it} from "vitest";
import {GOAL_CONTROL_METHOD} from "../AcpExtensions";
import type {CodexAcpServer} from "../CodexAcpServer";
import {createCodexAcpApp} from "../CodexAcpApp";

describe("goal control transport", () => {
    it("routes the Lody goal method over an ACP connection", async () => {
            const method = GOAL_CONTROL_METHOD;
            let connectionInstalled = false;
            const app = createCodexAcpApp({
                name: "goal-control-test",
                createAgent() {
                    connectionInstalled = true;
                    return {
                        async extMethod(receivedMethod: string, params: Record<string, unknown>) {
                            return {receivedMethod, params};
                        },
                    } as unknown as CodexAcpServer;
                },
            });

            const response = await acp.client({name: "goal-control-client"}).connectWith(app, (connection) =>
                connection.request(method, {
                    sessionId: "session-1",
                    action: "set",
                    objective: "Ship the sync",
                })
            );

            expect(connectionInstalled).toBe(true);
            expect(response).toEqual({
                receivedMethod: method,
                params: {
                    sessionId: "session-1",
                    action: "set",
                    objective: "Ship the sync",
                },
            });
        });
});

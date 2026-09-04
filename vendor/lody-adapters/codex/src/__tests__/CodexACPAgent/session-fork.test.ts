import {describe, expect, it, vi} from "vitest";
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestModel,
} from "../acp-test-utils";

describe("ACP session fork", () => {
    it("maps session/fork to thread/fork with lifecycle configuration", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const model = createTestModel();
        const mcpServer: McpServerStdio = {
            name: "fork-mcp",
            command: "node",
            args: ["server.js"],
            env: [{name: "TOKEN", value: "test-token"}],
        };

        vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({config: {}} as never);
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork").mockResolvedValue({
            thread: {id: "child-session-id"},
            model: model.id,
            modelProvider: "openai",
            serviceTier: null,
            reasoningEffort: "medium",
        } as never);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        const subscribed = vi.fn();

        const result = await codexAcpClient.forkSession({
            sessionId: "source-session-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra"],
            mcpServers: [mcpServer],
            _meta: {
                lody: {
                    forkAtTurn: {
                        version: 1,
                        turnId: "completed-turn-id",
                    },
                },
            },
        }, subscribed);

        expect(result).toEqual({
            sessionId: "child-session-id",
            currentModelId: "model-id[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: ["/workspace/extra"],
        });
        expect(subscribed).toHaveBeenCalledWith("child-session-id");
        expect(threadForkSpy).toHaveBeenCalledWith({
            threadId: "source-session-id",
            lastTurnId: "completed-turn-id",
            cwd: "/workspace",
            excludeTurns: true,
            modelProvider: "openai",
            config: {
                projects: {
                    "/workspace": {trust_level: "trusted"},
                    "/workspace/extra": {trust_level: "trusted"},
                },
                sandbox_workspace_write: {
                    writable_roots: ["/workspace/extra"],
                },
                mcp_servers: {
                    "fork-mcp": {
                        command: "node",
                        args: ["server.js"],
                        env: {TOKEN: "test-token"},
                    },
                },
            },
        });
    });

    it("installs the fork as an independent promptable ACP session", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const model = createTestModel();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "listSkills").mockResolvedValue({data: []});
        const forkSessionSpy = vi.spyOn(codexAcpClient, "forkSession").mockImplementation(
            async (_request, onSubscribed) => {
                onSubscribed?.("child-session-id");
                return {
                    sessionId: "child-session-id",
                    currentModelId: "model-id[medium]",
                    models: [model],
                    collaborationMode: "default",
                    modelProvider: "custom-provider",
                    currentServiceTier: null,
                    additionalDirectories: ["/workspace/extra"],
                };
            },
        );

        const response = await codexAcpAgent.unstable_forkSession({
            sessionId: "source-session-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra"],
            mcpServers: [],
        });

        expect(forkSessionSpy).toHaveBeenCalledWith(
            {
                sessionId: "source-session-id",
                cwd: "/workspace",
                additionalDirectories: ["/workspace/extra"],
                mcpServers: [],
            },
            expect.any(Function),
        );
        expect(response).toEqual(expect.objectContaining({
            sessionId: "child-session-id",
            modes: expect.objectContaining({currentModeId: "agent"}),
            configOptions: expect.any(Array),
        }));
        expect(codexAcpAgent.getSessionState("child-session-id")).toEqual(expect.objectContaining({
            sessionId: "child-session-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra"],
            currentTurnId: null,
        }));
    });

    it("unsubscribes a child when fork setup fails after Codex creates it", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "forkSession").mockImplementation(
            async (_request, onSubscribed) => {
                onSubscribed?.("child-session-id");
                throw new Error("model catalog unavailable");
            },
        );
        const closeSessionSpy = vi.spyOn(codexAcpClient, "closeSession").mockResolvedValue();

        await expect(codexAcpAgent.unstable_forkSession({
            sessionId: "source-session-id",
            cwd: "/workspace",
            mcpServers: [],
        })).rejects.toThrow("model catalog unavailable");

        expect(closeSessionSpy).toHaveBeenCalledWith("child-session-id");
        expect(() => codexAcpAgent.getSessionState("child-session-id"))
            .toThrow("Session child-session-id not found");
    });
});

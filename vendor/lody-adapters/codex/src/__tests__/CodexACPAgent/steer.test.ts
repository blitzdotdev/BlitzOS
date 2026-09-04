import {describe, expect, it, vi} from "vitest";
import {CODEX_STEER_APPLIED_METHOD, SESSION_STEERING_METHOD} from "../../AcpExtensions";
import {setupPromptTestSession} from "../acp-test-utils";
import type {TurnCompletedNotification} from "../../app-server/v2";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return {promise, resolve, reject};
}

describe("CodexACPAgent - steer", () => {
    it("steers the active app-server turn and acknowledges its committed user message", async () => {
        const {mockFixture, sessionState, turnStartSpy} = setupPromptTestSession();
        const appServer = mockFixture.getCodexAppServerClient();
        const completion = deferred<TurnCompletedNotification>();
        const steerResponse = deferred<{turnId: string}>();
        vi.spyOn(appServer, "awaitTurnCompleted").mockReturnValue(completion.promise);
        const turnSteerSpy = vi.spyOn(appServer, "turnSteer").mockReturnValue(steerResponse.promise);

        const originalPrompt = mockFixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "start"}],
        });
        await vi.waitFor(() => expect(turnStartSpy).toHaveBeenCalledOnce());

        const steerPrompt = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "change direction"}],
            steerId: "steer-1",
        });
        await vi.waitFor(() => expect(turnSteerSpy).toHaveBeenCalledWith({
            threadId: sessionState.sessionId,
            input: [{type: "text", text: "change direction", text_elements: []}],
            expectedTurnId: "turn-id",
            clientUserMessageId: "steer-1",
        }));
        expect(turnStartSpy).toHaveBeenCalledOnce();
        expect(mockFixture.getAcpConnectionEvents([])).not.toContainEqual(expect.objectContaining({
            method: "notify",
            args: [CODEX_STEER_APPLIED_METHOD, expect.anything()],
        }));

        mockFixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: sessionState.sessionId,
                turnId: "turn-id",
                completedAtMs: 1,
                item: {
                    type: "userMessage",
                    id: "item-1",
                    clientId: "steer-1",
                    content: [{type: "text", text: "change direction", text_elements: []}],
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionState.sessionId);
        expect(mockFixture.getAcpConnectionEvents([])).toContainEqual({
            method: "notify",
            args: [CODEX_STEER_APPLIED_METHOD, {
                sessionId: sessionState.sessionId,
                steerId: "steer-1",
            }],
        });

        steerResponse.resolve({turnId: "turn-id"});
        completion.resolve({
            threadId: sessionState.sessionId,
            turn: {
                id: "turn-id",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
        await expect(originalPrompt).resolves.toMatchObject({stopReason: "end_turn"});
        await expect(steerPrompt).resolves.toEqual({outcome: "injected"});
    });

    it("rejects an unmarked concurrent prompt instead of starting an ambiguous turn", async () => {
        const {mockFixture, sessionState, turnStartSpy} = setupPromptTestSession();
        const completion = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted").mockReturnValue(completion.promise);
        const originalPrompt = mockFixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "start"}],
        });
        await vi.waitFor(() => expect(turnStartSpy).toHaveBeenCalledOnce());

        await expect(mockFixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "ambiguous"}],
        })).rejects.toThrow("Invalid request");
        expect(turnStartSpy).toHaveBeenCalledOnce();
        completion.resolve({
            threadId: sessionState.sessionId,
            turn: {
                id: "turn-id",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
        await originalPrompt;
    });
});

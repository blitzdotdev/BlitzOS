import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc/node";
import { CodexAppServerClient } from "../CodexAppServerClient";
import type { TurnStartParams } from "../app-server/v2";

describe("CodexAppServerClient turn lifecycle", () => {
    it("rejects when the process closes after turn/start but before completion registration", async () => {
        let closeConnection: (() => void) | undefined;
        const connection = {
            onClose: (listener: () => void) => {
                closeConnection = listener;
                return { dispose: () => {} };
            },
            onDispose: () => ({ dispose: () => {} }),
            onUnhandledNotification: () => ({ dispose: () => {} }),
            onRequest: vi.fn(),
            sendRequest: vi.fn(async (method: string) => {
                if (method === "turn/start") {
                    return { turn: { id: "turn-1" } };
                }
                return undefined;
            }),
        } as unknown as MessageConnection;
        const client = new CodexAppServerClient(connection);

        const turn = client.runTurn(
            { threadId: "thread-1", input: [] } as unknown as TurnStartParams,
            () => closeConnection?.(),
        );

        await expect(turn).rejects.toThrow("Codex process exited before completing the turn");
    });
});

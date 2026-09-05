import {describe, expect, it} from "vitest";
import {GOAL_CONTINUATION_PROMPT, resolveGoalCommandHandleResult} from "../CodexCommands";
import type {TurnCompletedNotification} from "../app-server/v2";

const completedTurn = (status: TurnCompletedNotification["turn"]["status"]): TurnCompletedNotification => ({
    threadId: "thread-1",
    turn: {
        id: "turn-1",
        status,
        items: [],
        itemsView: "summary",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    },
});

describe("resolveGoalCommandHandleResult", () => {
    it("chains into goal continuation when Codex completes a setup turn", () => {
        expect(resolveGoalCommandHandleResult(completedTurn("completed"))).toEqual({
            handled: false,
            prompt: GOAL_CONTINUATION_PROMPT,
        });
    });

    it("chains into goal continuation when no setup turn starts", () => {
        expect(resolveGoalCommandHandleResult(null)).toEqual({
            handled: false,
            prompt: GOAL_CONTINUATION_PROMPT,
        });
    });

    it("preserves interrupted setup turns without starting continuation", () => {
        const turnCompleted = completedTurn("interrupted");
        expect(resolveGoalCommandHandleResult(turnCompleted)).toEqual({
            handled: true,
            turnCompleted,
        });
    });
});

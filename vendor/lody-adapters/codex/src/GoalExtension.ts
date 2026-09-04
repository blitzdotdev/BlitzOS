import type {SessionId} from "@agentclientprotocol/sdk";
import {LODY_EXTENSION_METHODS, type LodyGoalSnapshot} from "acp-extension-core";

export const GOAL_EXTENSION_VERSION = 1;
export const GOAL_CONTROL_METHOD = LODY_EXTENSION_METHODS.sessionGoal;

export const GOAL_CONTROL_ACTIONS = ["set", "pause", "resume", "clear"] as const;
export type GoalControlAction = typeof GOAL_CONTROL_ACTIONS[number];

export type GoalCapability = {
    version: typeof GOAL_EXTENSION_VERSION;
    actions: GoalControlAction[];
}

export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete";

export type GoalSnapshot = LodyGoalSnapshot;

export type GoalControlRequest =
    | { sessionId: SessionId; action: "set"; objective: string }
    | { sessionId: SessionId; action: Exclude<GoalControlAction, "set"> }

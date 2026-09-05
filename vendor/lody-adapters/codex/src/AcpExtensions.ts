import type {
    AvailableCommand,
    ClientContext,
    ContentBlock,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";
import {
    LODY_EXTENSION_METHODS,
    type LodyExtensionCapabilities,
    type LodySteerRequest,
    type LodySteerResponse,
    type RateLimitsGetRequest,
    type RateLimitsGetResponse,
    type RateLimitsUpdate,
    type SessionUsageUpdate,
} from "acp-extension-core";
import {
    GOAL_CONTROL_METHOD,
    type GoalControlRequest,
} from "./GoalExtension";

export {
    GOAL_CONTROL_ACTIONS,
    GOAL_CONTROL_METHOD,
    GOAL_EXTENSION_VERSION,
    type GoalCapability,
    type GoalControlAction,
    type GoalControlRequest,
    type GoalSnapshot,
    type GoalStatus,
} from "./GoalExtension";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";
export const ACP_EXT_SESSION_USAGE_UPDATE_METHOD = LODY_EXTENSION_METHODS.sessionUsageUpdate;
export const ACP_EXT_SESSION_RATE_LIMITS_METHOD = LODY_EXTENSION_METHODS.rateLimitsUpdate;
export const CODEX_STEER_APPLIED_METHOD = LODY_EXTENSION_METHODS.sessionSteerApplied;
export const SESSION_STEERING_METHOD = LODY_EXTENSION_METHODS.sessionSteer;
export const LODY_READ_SESSION_HISTORY_METHOD = LODY_EXTENSION_METHODS.sessionHistoryRead;
export const LODY_RATE_LIMITS_GET_METHOD = LODY_EXTENSION_METHODS.rateLimitsGet;

export const CODEX_LODY_CAPABILITIES = {
    usage: {version: 1},
    rateLimits: {version: 1, query: true},
    forkAtTurn: {version: 1},
    steering: {
        version: 1,
        transport: "request",
        upstreamTurn: "same",
        configPolicy: "active",
    },
    tasks: {version: 1, background: true},
    subagents: {version: 1, lifecycle: true},
    goal: {version: 1, actions: ["set", "pause", "resume", "clear"]},
    compaction: {version: 1},
    sessionHistory: {version: 1},
} as const satisfies LodyExtensionCapabilities;
export function getLodyForkTurnId(meta: unknown): string | null {
    if (typeof meta !== "object" || meta === null) return null;
    const lody = (meta as Record<string, unknown>)["lody"];
    if (typeof lody !== "object" || lody === null) return null;
    const forkAtTurn = (lody as Record<string, unknown>)["forkAtTurn"];
    if (typeof forkAtTurn !== "object" || forkAtTurn === null) return null;
    const version = (forkAtTurn as Record<string, unknown>)["version"];
    const turnId = (forkAtTurn as Record<string, unknown>)["turnId"];
    return version === 1 && typeof turnId === "string" && turnId.length > 0
        ? turnId
        : null;
}

export type LodyReadSessionHistoryRequest = {
    sessionId: SessionId;
}

export type LodyReadSessionHistoryResponse = {}

export type LegacySessionModel = {
    modelId: string;
    name: string;
    description?: string | null;
}

export type LegacySessionModelState = {
    availableModels: Array<LegacySessionModel>;
    currentModelId: string;
}

export type SessionUsageExtNotification = SessionUsageUpdate;
export type SessionRateLimitsExtNotification = RateLimitsUpdate;
export type LodyRateLimitsGetRequest = RateLimitsGetRequest;
export type LodyRateLimitsGetResponse = RateLimitsGetResponse;

export type LegacySetSessionModelRequest = {
    sessionId: SessionId;
    modelId: string;
}

export type LegacySetSessionModelResponse = {}

export type LegacyNewSessionResponse = NewSessionResponse & {
    models?: LegacySessionModelState | null;
    availableCommands?: AvailableCommand[];
}

export type LegacyLoadSessionResponse = LoadSessionResponse & {
    models?: LegacySessionModelState | null;
    availableCommands?: AvailableCommand[];
}

export type LegacyResumeSessionResponse = ResumeSessionResponse & {
    models?: LegacySessionModelState | null;
    availableCommands?: AvailableCommand[];
}

export type ExtMethodRequest =
    AuthenticationStatusRequest
    | AuthenticationLogoutRequest
    | LegacySetSessionModelExtRequest
    | SessionSteeringExtRequest
    | GoalControlExtRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD
        || request.method === GOAL_CONTROL_METHOD
        || request.method === SESSION_STEERING_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export type GoalControlExtRequest = {
    method: typeof GOAL_CONTROL_METHOD;
    params: GoalControlRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
}

export type SessionSteerRequest = LodySteerRequest<ContentBlock>;
export type SessionSteeringResponse = LodySteerResponse;

export type SessionSteeringExtRequest = {
    method: typeof SESSION_STEERING_METHOD;
    params: SessionSteerRequest;
}

export async function steerSessionWithFallback(
    connection: Pick<ClientContext, "request">,
    params: SessionSteerRequest,
): Promise<SessionSteeringResponse> {
    return await connection.request<SessionSteeringResponse, SessionSteerRequest>(SESSION_STEERING_METHOD, params);
}

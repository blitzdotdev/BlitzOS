export const LODY_EXTENSION_METHODS = {
  sessionUsageUpdate: '_lody/session/usage_update',
  rateLimitsGet: '_lody/rate_limits/get',
  rateLimitsUpdate: '_lody/rate_limits/update',
  sessionSteer: '_lody/session/steer',
  sessionSteerApplied: '_lody/session/steer_applied',
  sessionGoal: '_lody/session/goal',
  sessionHistoryRead: '_lody/session/history/read',
  subagentsList: '_lody/subagents/list',
  subagentsCancel: '_lody/subagents/cancel',
  subagentsOutput: '_lody/subagents/output',
} as const;

export type LodyExtensionMethod =
  (typeof LODY_EXTENSION_METHODS)[keyof typeof LODY_EXTENSION_METHODS];

export type LodyExtensionRequestMap<TPrompt = unknown> = {
  [LODY_EXTENSION_METHODS.rateLimitsGet]: {
    params: RateLimitsGetRequest;
    result: RateLimitsGetResponse;
  };
  [LODY_EXTENSION_METHODS.sessionSteer]: {
    params: LodySteerRequest<TPrompt>;
    result: LodySteerResponse;
  };
  [LODY_EXTENSION_METHODS.sessionGoal]: {
    params: LodyGoalControlRequest;
    result: LodyGoalControlResponse;
  };
  [LODY_EXTENSION_METHODS.sessionHistoryRead]: {
    params: LodySessionHistoryReadRequest;
    result: LodySessionHistoryReadResponse;
  };
  [LODY_EXTENSION_METHODS.subagentsList]: {
    params: LodySubagentsListRequest;
    result: LodySubagentsListResponse;
  };
  [LODY_EXTENSION_METHODS.subagentsCancel]: {
    params: LodySubagentCancelRequest;
    result: LodySubagentCancelResponse;
  };
  [LODY_EXTENSION_METHODS.subagentsOutput]: {
    params: LodySubagentOutputRequest;
    result: LodySubagentOutputResponse;
  };
};

export type LodyExtensionNotificationMap = {
  [LODY_EXTENSION_METHODS.sessionUsageUpdate]: SessionUsageUpdate;
  [LODY_EXTENSION_METHODS.rateLimitsUpdate]: RateLimitsUpdate;
  [LODY_EXTENSION_METHODS.sessionSteerApplied]: LodySteerApplied;
};

export type LodyExtensionRequestMethod = keyof LodyExtensionRequestMap;
export type LodyExtensionNotificationMethod = keyof LodyExtensionNotificationMap;

/** Provider-side request surface; adapters implement only advertised capabilities. */
export type LodyExtensionRequestHandlers<TPrompt = unknown> = {
  [TMethod in keyof LodyExtensionRequestMap<TPrompt>]?: (
    params: LodyExtensionRequestMap<TPrompt>[TMethod]['params']
  ) =>
    | LodyExtensionRequestMap<TPrompt>[TMethod]['result']
    | Promise<LodyExtensionRequestMap<TPrompt>[TMethod]['result']>;
};

export function normalizeLodyExtensionMethod(method: string): string {
  return method.startsWith('_') ? method : `_${method}`;
}
import type {
  RateLimitsGetRequest,
  RateLimitsGetResponse,
  RateLimitsUpdate,
} from './rate-limits.js';
import type {
  LodyGoalControlRequest,
  LodyGoalControlResponse,
  LodySessionHistoryReadRequest,
  LodySessionHistoryReadResponse,
  LodySteerApplied,
  LodySteerRequest,
  LodySteerResponse,
  LodySubagentCancelRequest,
  LodySubagentCancelResponse,
  LodySubagentOutputRequest,
  LodySubagentOutputResponse,
  LodySubagentsListRequest,
  LodySubagentsListResponse,
} from './session.js';
import type { SessionUsageUpdate } from './usage.js';

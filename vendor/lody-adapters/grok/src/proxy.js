import runtimeManifest from '../runtime-manifest.json' with { type: 'json' };
import { LODY_EXTENSION_METHODS } from 'acp-extension-core';

const contract = runtimeManifest.privateWireContract;

const PERMISSION_MODES = {
  ask: { permission_mode: 'ask', yolo_mode: false, auto_mode: false },
  auto: { permission_mode: 'auto', yolo_mode: false, auto_mode: true },
  'always-approve': {
    permission_mode: 'always-approve',
    yolo_mode: true,
    auto_mode: false,
  },
};

const INTERACTION_TO_RUNTIME = { agent: 'default', plan: 'plan' };
const INTERACTION_FROM_RUNTIME = { default: 'agent', plan: 'plan', ask: 'plan' };
// Grok 1.0.13 silently accepts `ask` without changing its runtime mode. Keep
// legacy persisted Ask selections safe by degrading them to Plan, but do not
// advertise Ask until the runtime reports and applies it.
const LEGACY_INTERACTION_ALIASES = { ask: 'plan' };

const INTERNAL_REQUESTS = {
  context: { contractKey: 'sessionInfoRequest', params: (sessionId) => ({ sessionId }) },
  billing: { contractKey: 'billingRequest', params: () => ({}) },
  rateLimits: { contractKey: 'billingRequest', params: () => ({}) },
};

const USD_TICKS_PER_USD = 10_000_000_000;
const MAX_TRACKED_PROMPTS = 256;
const GROK_LODY_CAPABILITIES = {
  usage: { version: 1 },
  rateLimits: { version: 1, query: true },
};
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const GROK_MODEL_SNAPSHOT_SETTLE_TIMEOUT_MS = 2_000;

function logicalExtensionMethod(method) {
  return typeof method === 'string' && method.startsWith('_') ? method.slice(1) : method;
}

function wireExtensionMethod(method) {
  return `_${method}`;
}

function extensionNotification(contractKey, params) {
  return { jsonrpc: '2.0', method: wireExtensionMethod(contract[contractKey]), params };
}

function lodyNotification(method, params) {
  return { jsonrpc: '2.0', method, params };
}

function optionalNonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeNumber(value) {
  return optionalNonnegativeNumber(value) ?? 0;
}

function optionalAmount(value) {
  return optionalNonnegativeNumber(value?.val ?? value);
}

function billingUsagePercent(config, period) {
  // Only the current period may borrow the top-level balance fields; a
  // historical period must never be paired with today's totals.
  const fallback = period === config.currentPeriod ? config : {};
  const explicit =
    optionalNonnegativeNumber(period.creditUsagePercent) ??
    optionalNonnegativeNumber(fallback.creditUsagePercent);
  if (explicit !== undefined) return explicit;

  const limit = optionalAmount(period.monthlyLimit ?? fallback.monthlyLimit);
  const used = optionalAmount(
    period.totalUsed ?? period.includedUsed ?? period.used ?? fallback.totalUsed ?? fallback.used
  );
  if (limit && used !== undefined) return (used / limit) * 100;

  // Grok Build 1.0.13 omits creditUsagePercent for a fresh unified-billing
  // weekly period and reports each balance field as an explicit zero. Its own
  // `/usage` UI renders that exact response as "Weekly limit: 0%", so mirror
  // the official client only for this fully-zero, provider-authored shape.
  const hasOfficialZeroUsage =
    config.isUnifiedBillingUser === true &&
    config.currentPeriod?.type === contract.weeklyUsagePeriodType &&
    optionalAmount(config.onDemandCap) === 0 &&
    optionalAmount(config.onDemandUsed) === 0 &&
    optionalAmount(config.prepaidBalance) === 0;
  if (hasOfficialZeroUsage) return 0;

  return undefined;
}

// A `window` of null means Grok could not tell us anything usable; Lody renders
// that as unavailable rather than as zero utilization.
function rateLimitsPayload(planName, window, now = Date.now()) {
  return {
    rateLimits: window
      ? [
          {
            limitId: 'grok',
            scope: { providerId: 'grok' },
            planName,
            limitName: 'Grok Build',
            windows: [window],
          },
        ]
      : [],
    fetchedAtEpochSeconds: Math.floor(now / 1_000),
  };
}

function normalizeUsageModel(usage, usageIsIncomplete) {
  const inputTokens = nonnegativeNumber(usage?.inputTokens);
  const outputTokens = nonnegativeNumber(usage?.outputTokens);
  const cacheReadInputTokens = nonnegativeNumber(usage?.cachedReadTokens);
  const cacheCreationInputTokens = nonnegativeNumber(usage?.cacheCreationTokens);
  const reasoningOutputTokens = nonnegativeNumber(usage?.reasoningTokens);
  const costUsdTicks = optionalNonnegativeNumber(usage?.costUsdTicks);
  const hasTrustworthyCost =
    !usageIsIncomplete && usage?.costIsPartial !== true && costUsdTicks !== undefined;

  return {
    // Grok's ACP totals include cache buckets in inputTokens and reasoning in
    // outputTokens. Lody stores disjoint buckets and adds them for reporting.
    inputTokens: Math.max(0, inputTokens - cacheReadInputTokens - cacheCreationInputTokens),
    outputTokens: Math.max(0, outputTokens - reasoningOutputTokens),
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    ...(hasTrustworthyCost ? { costUSD: costUsdTicks / USD_TICKS_PER_USD } : {}),
  };
}

export function normalizePromptUsage(promptUsage) {
  if (!promptUsage || typeof promptUsage !== 'object') return undefined;
  const usageIsIncomplete = promptUsage.usageIsIncomplete === true;
  const usage = normalizeUsageModel(promptUsage, usageIsIncomplete);
  const modelUsage = {};
  if (promptUsage.modelUsage && typeof promptUsage.modelUsage === 'object') {
    for (const [modelId, model] of Object.entries(promptUsage.modelUsage)) {
      if (model && typeof model === 'object') {
        modelUsage[modelId] = normalizeUsageModel(model, usageIsIncomplete);
      }
    }
  }
  return {
    usage,
    ...(Object.keys(modelUsage).length ? { modelUsage } : {}),
  };
}

function usageNotification(sessionId, promptUsage) {
  const params = normalizePromptUsage(promptUsage);
  return (
    params && lodyNotification(LODY_EXTENSION_METHODS.sessionUsageUpdate, { sessionId, ...params })
  );
}

export function normalizeBillingRateLimits(billing) {
  if (!billing || typeof billing !== 'object') return undefined;
  const config = billing.config;
  if (!config || typeof config !== 'object') return undefined;

  const latestHistory = Array.isArray(config.history) ? config.history.at(-1) : undefined;
  const period = config.currentPeriod ?? latestHistory ?? config;
  let usedPercent = billingUsagePercent(config, period);
  if (usedPercent !== undefined) usedPercent = Math.min(100, usedPercent);

  const start = period?.start ?? period?.billingPeriodStart ?? config.billingPeriodStart;
  const end = period?.end ?? period?.billingPeriodEnd ?? config.billingPeriodEnd;
  const startMs = typeof start === 'string' ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === 'string' ? Date.parse(end) : Number.NaN;
  const measuredWindowDurationSeconds =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 1_000)
      : null;
  const windowDurationSeconds =
    period?.type === contract.weeklyUsagePeriodType
      ? SEVEN_DAY_WINDOW_SECONDS
      : measuredWindowDurationSeconds;
  const resetsAtEpochSeconds = Number.isFinite(endMs) ? Math.floor(endMs / 1_000) : null;
  const tier = billing.subscriptionTier ?? billing.subscription_tier;
  const planName = typeof tier === 'string' && tier.trim() ? tier : null;

  if (usedPercent === undefined) {
    if (!planName && windowDurationSeconds === null && resetsAtEpochSeconds === null)
      return undefined;
    return rateLimitsPayload(planName, null);
  }
  return rateLimitsPayload(planName, {
    usedPercent,
    windowDurationSeconds,
    resetsAtEpochSeconds,
  });
}

function rateLimitsNotification(billing) {
  const params = normalizeBillingRateLimits(billing);
  return params && lodyNotification(LODY_EXTENSION_METHODS.rateLimitsUpdate, params);
}

function contextUsageNotification(sessionId, context) {
  const size = nonnegativeNumber(context?.total);
  const used = nonnegativeNumber(context?.used);
  if (size <= 0) return undefined;
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'usage_update', size, used },
    },
  };
}

function unwrapExtensionResult(result) {
  if (!result || typeof result !== 'object') return result;
  return Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
}

// Returns true when the prompt is new to `set` — including when Grok gave us no
// id to deduplicate on, in which case there is nothing to suppress.
function rememberPrompt(set, promptId) {
  if (!promptId) return true;
  if (set.has(promptId)) return false;
  set.add(promptId);
  if (set.size > MAX_TRACKED_PROMPTS) {
    set.delete(set.values().next().value);
  }
  return true;
}

function errorResponse(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32602, message } };
}

function unsupportedConfigOption(id, configId) {
  return {
    toRuntime: [],
    toClient: [errorResponse(id, `Unsupported Grok config option: ${configId}`)],
  };
}

function optionName(value) {
  if (value === 'xhigh') return 'X-High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function legacyOptions(result) {
  const options = result?._meta?.[contract.sessionConfigMeta]?.options;
  return Array.isArray(options) ? options : [];
}

function readReasoningEfforts(model) {
  const raw = model?._meta?.reasoningEfforts ?? model?._meta?.reasoning_efforts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'string' ? item : (item?.id ?? item?.reasoningEffort)))
    .filter((item) => typeof item === 'string');
}

function readModelSnapshot(params) {
  if (!params || typeof params !== 'object' || !Array.isArray(params.availableModels)) {
    return undefined;
  }
  if (
    params.availableModels.length === 0 ||
    params.availableModels.some(
      (model) => !model || typeof model !== 'object' || typeof model.modelId !== 'string'
    )
  ) {
    return undefined;
  }
  const currentModelId = params.currentModelId;
  if (
    typeof currentModelId !== 'string' ||
    !params.availableModels.some((model) => model.modelId === currentModelId)
  ) {
    return undefined;
  }
  return {
    currentModelId,
    availableModels: params.availableModels,
  };
}

function selectOption(id, name, description, currentValue, options, category) {
  return {
    id,
    name,
    description,
    category,
    type: 'select',
    currentValue,
    options,
  };
}

export function permissionNotification(clientIdentifier, mode) {
  const mapped = PERMISSION_MODES[mode];
  if (!mapped) return undefined;
  return extensionNotification('permissionNotification', { clientIdentifier, ...mapped });
}

function stripLodySessionConfig(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const lody = meta.lody;
  if (!lody || typeof lody !== 'object' || !Object.hasOwn(lody, 'sessionConfig')) return meta;
  const { sessionConfig: _sessionConfig, ...remainingLody } = lody;
  const { lody: _lody, ...remainingMeta } = meta;
  return Object.keys(remainingLody).length > 0
    ? { ...remainingMeta, lody: remainingLody }
    : remainingMeta;
}

function readLodySessionConfigOption(meta, configId) {
  if (!meta || typeof meta !== 'object') return undefined;
  const sessionConfig = meta.lody?.sessionConfig;
  if (
    !sessionConfig ||
    typeof sessionConfig !== 'object' ||
    sessionConfig.version !== 1 ||
    !sessionConfig.configOptionValues ||
    typeof sessionConfig.configOptionValues !== 'object'
  ) {
    return undefined;
  }
  const value = sessionConfig.configOptionValues[configId];
  return typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
}

function translateSessionStart(message) {
  const params = message.params ?? {};
  const permissionMode = readLodySessionConfigOption(params._meta, 'permission_mode');
  const mapped = typeof permissionMode === 'string' ? PERMISSION_MODES[permissionMode] : undefined;
  if (!mapped) return { message, permissionMode: undefined, notification: undefined };

  const clientIdentifier = params._meta?.clientIdentifier;
  const translated = {
    ...message,
    params: {
      ...params,
      _meta: {
        ...stripLodySessionConfig(params._meta),
        yoloMode: mapped.yolo_mode,
      },
    },
  };
  return {
    message: translated,
    permissionMode,
    notification:
      mapped.auto_mode && typeof clientIdentifier === 'string'
        ? permissionNotification(clientIdentifier, permissionMode)
        : undefined,
  };
}

export class GrokAcpCompatibilityProxy {
  constructor({ deferSessionResponseUntilModelSnapshot = false } = {}) {
    this.sessions = new Map();
    this.pending = new Map();
    this.pendingSessionResponses = new Map();
    this.clientVisibleSessions = new Set();
    this.latestModelSnapshot = undefined;
    this.latestModelSnapshotFingerprint = undefined;
    this.deferSessionResponseUntilModelSnapshot = deferSessionResponseUntilModelSnapshot;
    // Grok scopes yolo/auto mode to the Lody clientIdentifier, not to a session,
    // so the selection outlives any single session and is stored by client.
    this.permissionModes = new Map();
    this.nextInternalRequestId = Number.MAX_SAFE_INTEGER;
  }

  applyModelSnapshot(state, snapshot) {
    const previousModelId = state.currentModelId;
    const previousReasoningEffort = state.reasoningEffort;
    const currentModel = snapshot.availableModels.find(
      (model) => model.modelId === snapshot.currentModelId
    );
    const reasoningEfforts = readReasoningEfforts(currentModel);
    const metadataReasoningEffort =
      currentModel?._meta?.reasoningEffort ?? currentModel?._meta?.reasoning_effort;

    state.currentModelId = snapshot.currentModelId;
    state.models = snapshot.availableModels;
    state.reasoningEfforts = reasoningEfforts;
    state.reasoningEffort =
      previousModelId === snapshot.currentModelId &&
      reasoningEfforts.includes(previousReasoningEffort)
        ? previousReasoningEffort
        : typeof metadataReasoningEffort === 'string' &&
            reasoningEfforts.includes(metadataReasoningEffort)
          ? metadataReasoningEffort
          : reasoningEfforts[0];
  }

  sessionResponseWithState(message, state) {
    const models =
      typeof state.currentModelId === 'string' && state.models.length > 0
        ? {
            currentModelId: state.currentModelId,
            availableModels: state.models,
          }
        : message.result?.models;
    return {
      ...message,
      result: {
        ...message.result,
        ...(models ? { models } : {}),
        configOptions: this.configOptions(state),
      },
    };
  }

  exposePendingSessionResponse(id) {
    const pending = this.pendingSessionResponses.get(id);
    if (!pending) return { toRuntime: [], toClient: [] };
    this.pendingSessionResponses.delete(id);
    const state = this.sessions.get(pending.sessionId);
    if (!state) return { toRuntime: [], toClient: [pending.message] };
    this.clientVisibleSessions.add(pending.sessionId);
    return {
      toRuntime: [],
      toClient: [this.sessionResponseWithState(pending.message, state)],
    };
  }

  flushPendingSessionResponse(id) {
    return this.exposePendingSessionResponse(id);
  }

  handleModelSnapshot(message) {
    const snapshot = readModelSnapshot(message.params);
    if (!snapshot) return { toRuntime: [], toClient: [message] };
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === this.latestModelSnapshotFingerprint) {
      return { toRuntime: [], toClient: [] };
    }
    this.latestModelSnapshot = snapshot;
    this.latestModelSnapshotFingerprint = fingerprint;

    for (const state of this.sessions.values()) {
      this.applyModelSnapshot(state, snapshot);
    }

    const toClient = [];
    const pendingSessionIds = new Set();
    const settledSessionResponseIds = [];
    for (const id of [...this.pendingSessionResponses.keys()]) {
      const pending = this.pendingSessionResponses.get(id);
      if (pending) pendingSessionIds.add(pending.sessionId);
      toClient.push(...this.exposePendingSessionResponse(id).toClient);
      settledSessionResponseIds.push(id);
    }
    for (const sessionId of this.clientVisibleSessions) {
      if (pendingSessionIds.has(sessionId)) continue;
      const state = this.sessions.get(sessionId);
      if (!state) continue;
      toClient.push({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: this.configOptions(state),
          },
        },
      });
    }
    return {
      toRuntime: [],
      toClient,
      ...(settledSessionResponseIds.length > 0 ? { settledSessionResponseIds } : {}),
    };
  }

  internalRequest(kind, sessionId, responseId) {
    while (this.pending.has(this.nextInternalRequestId)) this.nextInternalRequestId -= 1;
    const id = this.nextInternalRequestId;
    this.nextInternalRequestId -= 1;
    this.pending.set(id, { kind, sessionId, responseId });
    const { contractKey, params } = INTERNAL_REQUESTS[kind];
    return {
      jsonrpc: '2.0',
      id,
      method: wireExtensionMethod(contract[contractKey]),
      params: params(sessionId),
    };
  }

  usageRefreshRequests(sessionId) {
    return [this.internalRequest('context', sessionId), this.internalRequest('billing', sessionId)];
  }

  usageRefreshRequestsForPrompt(state, promptId) {
    if (!rememberPrompt(state.usageRefreshPromptIds, promptId)) return [];
    return this.usageRefreshRequests(state.sessionId);
  }

  usageForPrompt(state, promptId, promptUsage) {
    const notification = usageNotification(state.sessionId, promptUsage);
    if (!notification) return undefined;
    if (!rememberPrompt(state.usagePromptIds, promptId)) return undefined;
    return notification;
  }

  handleClient(message) {
    if (!message || typeof message !== 'object') return { toRuntime: [message], toClient: [] };
    const params = message.params ?? {};
    if (message.method === 'initialize' && message.id !== undefined) {
      this.pending.set(message.id, { kind: 'initialize' });
      return { toRuntime: [message], toClient: [] };
    }
    if (message.method === LODY_EXTENSION_METHODS.rateLimitsGet) {
      return {
        toRuntime: [this.internalRequest('rateLimits', undefined, message.id)],
        toClient: [],
      };
    }
    if (
      message.method === 'session/new' ||
      message.method === 'session/load' ||
      message.method === 'session/resume' ||
      message.method === 'session/fork'
    ) {
      const clientIdentifier = params._meta?.clientIdentifier;
      const translated = translateSessionStart(message);
      if (translated.permissionMode && typeof clientIdentifier === 'string') {
        this.permissionModes.set(clientIdentifier, translated.permissionMode);
      }
      if (message.id !== undefined) {
        this.pending.set(message.id, {
          kind: 'session',
          method: message.method,
          sessionId: params.sessionId,
          clientIdentifier,
        });
      }
      return {
        toRuntime: translated.notification
          ? [translated.notification, translated.message]
          : [translated.message],
        toClient: [],
      };
    }
    if (message.method === 'session/prompt') {
      if (message.id !== undefined) {
        this.pending.set(message.id, {
          kind: 'prompt',
          sessionId: params.sessionId,
        });
      }
      return { toRuntime: [message], toClient: [] };
    }
    if (message.method !== 'session/set_config_option') {
      return { toRuntime: [message], toClient: [] };
    }

    const { sessionId, configId, value } = params;
    const state = this.sessions.get(sessionId);
    if (!state || typeof value !== 'string') {
      return {
        toRuntime: [],
        toClient: [errorResponse(message.id, 'Unknown Grok session or invalid config value')],
      };
    }

    if (configId === 'permission_mode') {
      if (value === 'auto' && !contract.autoPermissionMode) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              'Auto permission mode is unavailable in the pinned Grok runtime'
            ),
          ],
        };
      }
      const notification = permissionNotification(state.clientIdentifier, value);
      if (!notification || !state.clientIdentifier) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              'Grok permission mode requires the current Lody clientIdentifier'
            ),
          ],
        };
      }
      this.permissionModes.set(state.clientIdentifier, value);
      return {
        toRuntime: [notification],
        toClient: [
          {
            jsonrpc: '2.0',
            id: message.id,
            result: { configOptions: this.configOptions(state) },
          },
        ],
      };
    }

    let translated;
    let effectiveValue = value;
    if (configId === 'reasoning_effort') {
      if (!state.currentModelId || !state.reasoningEfforts.includes(value)) {
        return {
          toRuntime: [],
          toClient: [errorResponse(message.id, 'Unsupported Grok reasoning effort')],
        };
      }
      translated = {
        jsonrpc: '2.0',
        id: message.id,
        method: 'session/set_model',
        params: {
          sessionId,
          modelId: state.currentModelId,
          _meta: {
            [contract.reasoningEffortMeta]: value,
          },
        },
      };
    } else if (configId === 'model') {
      translated = {
        jsonrpc: '2.0',
        id: message.id,
        method: 'session/set_model',
        params: { sessionId, modelId: value },
      };
    } else if (configId === 'interaction_mode') {
      effectiveValue = LEGACY_INTERACTION_ALIASES[value] ?? value;
      const modeId = INTERACTION_TO_RUNTIME[effectiveValue];
      if (!modeId) return unsupportedConfigOption(message.id, configId);
      translated = {
        jsonrpc: '2.0',
        id: message.id,
        method: 'session/set_mode',
        params: { sessionId, modeId },
      };
    } else {
      return unsupportedConfigOption(message.id, configId);
    }
    this.pending.set(message.id, {
      kind: 'config',
      sessionId,
      configId,
      value: effectiveValue,
    });
    return { toRuntime: [translated], toClient: [] };
  }

  handleRuntime(message) {
    if (!message || typeof message !== 'object') return { toRuntime: [], toClient: [message] };

    // JSON-RPC request IDs are scoped independently in each direction. Never
    // mistake a reverse request from Grok for a response to a Lody request that
    // happens to use the same numeric ID.
    if (typeof message.method === 'string') return this.handleRuntimeMethod(message);

    const pending = this.pending.get(message.id);
    if (!pending) return { toRuntime: [], toClient: [message] };
    this.pending.delete(message.id);

    if (pending.kind === 'context') {
      if (message.error) return { toRuntime: [], toClient: [] };
      const sessionInfo = unwrapExtensionResult(message.result);
      const contextNotification = contextUsageNotification(pending.sessionId, sessionInfo?.context);
      return {
        toRuntime: [],
        toClient: contextNotification ? [contextNotification] : [],
      };
    }

    if (pending.kind === 'billing') {
      const notification = message.error
        ? lodyNotification(LODY_EXTENSION_METHODS.rateLimitsUpdate, rateLimitsPayload(null, null))
        : rateLimitsNotification(unwrapExtensionResult(message.result));
      return {
        toRuntime: [],
        toClient: notification ? [notification] : [],
      };
    }

    if (pending.kind === 'rateLimits') {
      const result = message.error
        ? rateLimitsPayload(null, null)
        : (normalizeBillingRateLimits(unwrapExtensionResult(message.result)) ??
          rateLimitsPayload(null, null));
      return {
        toRuntime: [],
        toClient: [{ jsonrpc: '2.0', id: pending.responseId, result }],
      };
    }

    if (pending.kind === 'initialize') {
      if (message.error) return { toRuntime: [], toClient: [message] };
      const result = message.result ?? {};
      const agentCapabilities = result.agentCapabilities ?? {};
      return {
        toRuntime: [],
        toClient: [
          {
            ...message,
            result: {
              ...result,
              agentCapabilities: {
                ...agentCapabilities,
                _meta: {
                  ...(agentCapabilities._meta ?? {}),
                  lody: GROK_LODY_CAPABILITIES,
                },
              },
            },
          },
        ],
      };
    }

    if (message.error) return { toRuntime: [], toClient: [message] };

    if (pending.kind === 'session') {
      const result = message.result ?? {};
      const sessionId = result.sessionId ?? pending.sessionId;
      if (!sessionId) return { toRuntime: [], toClient: [message] };
      const state = this.stateFromSessionResponse(sessionId, pending.clientIdentifier, result);
      if (this.latestModelSnapshot) {
        this.applyModelSnapshot(state, this.latestModelSnapshot);
      }
      this.sessions.set(sessionId, state);
      const sessionResponse = this.sessionResponseWithState(message, state);
      if (
        this.deferSessionResponseUntilModelSnapshot &&
        !this.latestModelSnapshot &&
        message.id !== undefined
      ) {
        this.pendingSessionResponses.set(message.id, {
          message: sessionResponse,
          sessionId,
        });
        return {
          toRuntime: this.usageRefreshRequests(sessionId),
          toClient: [],
          deferredSessionResponseIds: [message.id],
        };
      }
      this.clientVisibleSessions.add(sessionId);
      return {
        toRuntime: this.usageRefreshRequests(sessionId),
        toClient: [sessionResponse],
      };
    }

    if (pending.kind === 'prompt') {
      const state = this.sessions.get(pending.sessionId);
      if (!state) return { toRuntime: [], toClient: [message] };
      const meta = message.result?._meta;
      const promptId = meta?.promptId ?? meta?.requestId;
      const usage = this.usageForPrompt(state, promptId, meta?.usage);
      return {
        toRuntime: this.usageRefreshRequestsForPrompt(state, promptId),
        toClient: usage ? [message, usage] : [message],
      };
    }

    const state = this.sessions.get(pending.sessionId);
    if (!state) return { toRuntime: [], toClient: [message] };
    if (pending.configId === 'model') state.currentModelId = pending.value;
    if (pending.configId === 'reasoning_effort') state.reasoningEffort = pending.value;
    if (pending.configId === 'interaction_mode') state.interactionMode = pending.value;
    return {
      toRuntime: [],
      toClient: [
        {
          jsonrpc: '2.0',
          id: message.id,
          result: { configOptions: this.configOptions(state) },
        },
      ],
    };
  }

  handleRuntimeMethod(message) {
    const passthrough = { toRuntime: [], toClient: [message] };
    const logicalMethod = logicalExtensionMethod(message.method);
    if (logicalMethod === contract.modelsUpdateNotification) {
      return this.handleModelSnapshot(message);
    }
    const sessionId = message.params?.sessionId;
    const update = message.params?.update;
    const state = this.sessions.get(sessionId);
    if (!state) return passthrough;

    if (
      logicalMethod === contract.sessionUpdateNotification &&
      update?.sessionUpdate === contract.turnCompletedUpdate
    ) {
      if (message.params?._meta?.isReplay === true) return passthrough;
      const promptId = update.prompt_id ?? update.promptId;
      const usage = this.usageForPrompt(state, promptId, update.usage);
      return {
        toRuntime: this.usageRefreshRequestsForPrompt(state, promptId),
        toClient: usage ? [message, usage] : [message],
      };
    }

    if (message.method === 'session/update' && update?.sessionUpdate === 'current_mode_update') {
      const interactionMode = INTERACTION_FROM_RUNTIME[update.currentModeId];
      if (interactionMode) state.interactionMode = interactionMode;
      return passthrough;
    }

    if (
      logicalMethod === contract.sessionNotification &&
      update?.sessionUpdate === 'model_changed'
    ) {
      const modelId = update.model_id ?? update.modelId;
      const reasoningEffort = update.reasoning_effort ?? update.reasoningEffort;
      if (typeof modelId === 'string') state.currentModelId = modelId;
      if (typeof reasoningEffort === 'string') state.reasoningEffort = reasoningEffort;
      return {
        toRuntime: [this.internalRequest('context', sessionId)],
        toClient: [message],
      };
    }

    return passthrough;
  }

  stateFromSessionResponse(sessionId, clientIdentifier, result) {
    const old = this.sessions.get(sessionId);
    const legacy = legacyOptions(result);
    const legacyModels = legacy.filter((option) => option.category === 'model');
    const legacyEfforts = legacy.filter((option) => option.category === 'mode');
    const availableModels = result.models?.availableModels ?? [];
    const currentModelId =
      result.models?.currentModelId ??
      legacyModels.find((option) => option.selected)?.id ??
      old?.currentModelId;
    const currentModel = availableModels.find((model) => model.modelId === currentModelId);
    const metadataEfforts = readReasoningEfforts(currentModel);
    const reasoningEfforts = metadataEfforts.length
      ? metadataEfforts
      : legacyEfforts.map((option) => option.id);
    return {
      sessionId,
      clientIdentifier: clientIdentifier ?? old?.clientIdentifier,
      interactionMode:
        INTERACTION_FROM_RUNTIME[result.modes?.currentModeId] ?? old?.interactionMode ?? 'agent',
      currentModelId,
      models: availableModels.length
        ? availableModels
        : legacyModels.map((option) => ({
            modelId: option.id,
            name: option.label,
            description: option.description,
          })),
      reasoningEfforts,
      reasoningEffort:
        legacyEfforts.find((option) => option.selected)?.id ??
        old?.reasoningEffort ??
        reasoningEfforts[0],
      usagePromptIds: old?.usagePromptIds ?? new Set(),
      usageRefreshPromptIds: old?.usageRefreshPromptIds ?? new Set(),
    };
  }

  configOptions(state) {
    const modes = [
      {
        value: 'agent',
        name: 'Agent',
        description: 'Use tools and make changes when needed',
      },
      {
        value: 'plan',
        name: 'Plan',
        description: 'Plan without modifying the workspace',
      },
    ];
    const permissions = [
      {
        value: 'ask',
        name: 'Ask Every Time',
        description: 'Request approval for protected actions',
      },
      {
        value: 'always-approve',
        name: 'Always Approve',
        description: 'Approve protected actions automatically',
      },
    ];
    if (contract.autoPermissionMode) {
      permissions.splice(1, 0, {
        value: 'auto',
        name: 'Auto',
        description: 'Let Grok decide when approval is required',
      });
    }
    const options = [
      selectOption(
        'interaction_mode',
        'Interaction Mode',
        'Controls how Grok works',
        state.interactionMode,
        modes,
        'mode'
      ),
      selectOption(
        'permission_mode',
        'Permission Mode',
        'Controls protected tool approvals',
        this.permissionModes.get(state.clientIdentifier) ?? 'ask',
        permissions,
        '_permission'
      ),
    ];
    if (state.currentModelId) {
      options.push(
        selectOption(
          'model',
          'Model',
          'Select the model used for this session',
          state.currentModelId,
          state.models.map((model) => ({
            value: model.modelId,
            name: model.name || model.modelId,
            description: model.description ?? null,
          })),
          'model'
        )
      );
    }
    if (state.reasoningEfforts.length && state.reasoningEffort) {
      options.push(
        selectOption(
          'reasoning_effort',
          'Reasoning Effort',
          'Controls how much reasoning the model performs',
          state.reasoningEffort,
          state.reasoningEfforts.map((value) => ({
            value,
            name: optionName(value),
            description: null,
          })),
          'thought_level'
        )
      );
    }
    return options;
  }
}

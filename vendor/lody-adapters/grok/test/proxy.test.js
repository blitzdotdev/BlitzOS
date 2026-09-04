import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GrokAcpCompatibilityProxy,
  normalizeBillingRateLimits,
  normalizePromptUsage,
  permissionNotification,
} from '../src/proxy.js';
import runtimeManifest from '../runtime-manifest.json' with { type: 'json' };

const clientIdentifier = 'lody:session-1';
const sessionResponse = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    sessionId: 'grok-session',
    models: {
      currentModelId: 'grok-build',
      availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }],
    },
    modes: { currentModeId: 'default' },
    _meta: {
      'x.ai/sessionConfig': {
        options: [
          {
            id: 'grok-build',
            category: 'model',
            label: 'Grok Build',
            selected: true,
          },
          { id: 'low', category: 'mode', label: 'Low', selected: false },
          { id: 'high', category: 'mode', label: 'High', selected: true },
        ],
      },
    },
  },
};

const modelSnapshot = {
  jsonrpc: '2.0',
  method: '_x.ai/models/update',
  params: {
    currentModelId: 'grok-4.6',
    availableModels: [
      {
        modelId: 'grok-4.6',
        name: 'Grok 4.6',
        description: "SpaceXAI's latest frontier model",
        _meta: {
          reasoningEffort: 'high',
          reasoningEfforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }],
        },
      },
      {
        modelId: 'grok-4.5',
        name: 'Grok 4.5',
        _meta: {
          reasoningEffort: 'high',
          reasoningEfforts: [{ id: 'high' }, { id: 'medium' }, { id: 'low' }],
        },
      },
    ],
  },
};

function readyProxy() {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const startup = proxy.handleRuntime(sessionResponse);
  return { proxy, startup, response: startup.toClient[0] };
}

const promptUsage = {
  inputTokens: 1_000,
  outputTokens: 250,
  cachedReadTokens: 300,
  cacheCreationTokens: 100,
  reasoningTokens: 50,
  costUsdTicks: 250_000_000,
  modelUsage: {
    'grok-build': {
      inputTokens: 1_000,
      outputTokens: 250,
      cachedReadTokens: 300,
      cacheCreationTokens: 100,
      reasoningTokens: 50,
      costUsdTicks: 250_000_000,
    },
  },
  numTurns: 1,
  usageIsIncomplete: false,
};

test('pins and synthesizes the official 1.0.13 private wire contract', () => {
  assert.equal(runtimeManifest.officialRuntime.minimumSupportedVersion, '1.0.13');
  assert.deepEqual(
    {
      sessionUpdateNotification: runtimeManifest.privateWireContract.sessionUpdateNotification,
      modelsUpdateNotification: runtimeManifest.privateWireContract.modelsUpdateNotification,
      turnCompletedUpdate: runtimeManifest.privateWireContract.turnCompletedUpdate,
      sessionInfoRequest: runtimeManifest.privateWireContract.sessionInfoRequest,
      billingRequest: runtimeManifest.privateWireContract.billingRequest,
    },
    {
      sessionUpdateNotification: 'x.ai/session/update',
      modelsUpdateNotification: 'x.ai/models/update',
      turnCompletedUpdate: 'turn_completed',
      sessionInfoRequest: 'x.ai/session/info',
      billingRequest: 'x.ai/billing',
    }
  );
  const { response } = readyProxy();
  assert.deepEqual(
    response.result.configOptions.map((option) => option.id),
    ['interaction_mode', 'permission_mode', 'model', 'reasoning_effort']
  );
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort').currentValue,
    'high'
  );
  assert.deepEqual(
    response.result.configOptions
      .find((option) => option.id === 'permission_mode')
      .options.map((option) => option.value),
    ['ask', 'auto', 'always-approve']
  );
  assert.deepEqual(
    response.result.configOptions
      .find((option) => option.id === 'interaction_mode')
      .options.map((option) => option.value),
    ['agent', 'plan']
  );
});

test('settles an initial one-model response with the late complete model snapshot', () => {
  const proxy = new GrokAcpCompatibilityProxy({
    deferSessionResponseUntilModelSnapshot: true,
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });

  const provisional = proxy.handleRuntime({
    ...sessionResponse,
    result: {
      ...sessionResponse.result,
      models: {
        currentModelId: 'grok-4.5',
        availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5' }],
      },
    },
  });
  assert.deepEqual(provisional.toClient, []);
  assert.deepEqual(provisional.deferredSessionResponseIds, [1]);

  const settled = proxy.handleRuntime(modelSnapshot);
  assert.equal(settled.toClient.length, 1);
  assert.deepEqual(settled.settledSessionResponseIds, [1]);
  assert.equal(settled.toClient[0].id, 1);
  assert.deepEqual(
    settled.toClient[0].result.models.availableModels.map((model) => model.modelId),
    ['grok-4.6', 'grok-4.5']
  );
  assert.deepEqual(
    settled.toClient[0].result.configOptions
      .find((option) => option.id === 'model')
      .options.map((option) => option.value),
    ['grok-4.6', 'grok-4.5']
  );
  assert.deepEqual(
    settled.toClient[0].result.configOptions
      .find((option) => option.id === 'reasoning_effort')
      .options.map((option) => option.value),
    ['xhigh', 'high', 'medium', 'low']
  );
});

test('uses a complete model snapshot that arrives before session/new returns', () => {
  const proxy = new GrokAcpCompatibilityProxy({
    deferSessionResponseUntilModelSnapshot: true,
  });
  assert.deepEqual(proxy.handleRuntime(modelSnapshot), { toRuntime: [], toClient: [] });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });

  const startup = proxy.handleRuntime(sessionResponse);
  assert.equal(startup.deferredSessionResponseIds, undefined);
  assert.deepEqual(
    startup.toClient[0].result.models.availableModels.map((model) => model.modelId),
    ['grok-4.6', 'grok-4.5']
  );
});

test('does not invent an empty models object when a session response omits models', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp/project', mcpServers: [] },
  });

  const startup = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 1,
    result: { sessionId: 'modeless-session' },
  });
  assert.equal(startup.toClient[0].result.models, undefined);
});

test('suppresses duplicate complete model snapshots', () => {
  const { proxy } = readyProxy();

  const first = proxy.handleRuntime(modelSnapshot);
  assert.equal(first.toClient.length, 1);
  assert.deepEqual(proxy.handleRuntime(modelSnapshot), { toRuntime: [], toClient: [] });
});

test('flushes on the bounded fallback and translates a still-later snapshot to standard ACP', () => {
  const proxy = new GrokAcpCompatibilityProxy({
    deferSessionResponseUntilModelSnapshot: true,
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  proxy.handleRuntime(sessionResponse);

  const fallback = proxy.flushPendingSessionResponse(1);
  assert.deepEqual(
    fallback.toClient[0].result.models.availableModels.map((model) => model.modelId),
    ['grok-build']
  );

  const updated = proxy.handleRuntime(modelSnapshot);
  assert.equal(updated.toClient.length, 1);
  assert.equal(updated.toClient[0].jsonrpc, '2.0');
  assert.equal(updated.toClient[0].method, 'session/update');
  assert.equal(updated.toClient[0].params.sessionId, 'grok-session');
  assert.equal(updated.toClient[0].params.update.sessionUpdate, 'config_option_update');
  assert.deepEqual(
    updated.toClient[0].params.update.configOptions
      .find((option) => option.id === 'model')
      .options.map((option) => option.value),
    ['grok-4.6', 'grok-4.5']
  );
});

test('maps every permission mode to the official notification contract', () => {
  assert.deepEqual(permissionNotification(clientIdentifier, 'ask').params, {
    clientIdentifier,
    permission_mode: 'ask',
    yolo_mode: false,
    auto_mode: false,
  });
  assert.deepEqual(permissionNotification(clientIdentifier, 'auto').params, {
    clientIdentifier,
    permission_mode: 'auto',
    yolo_mode: false,
    auto_mode: true,
  });
  assert.deepEqual(permissionNotification(clientIdentifier, 'always-approve').params, {
    clientIdentifier,
    permission_mode: 'always-approve',
    yolo_mode: true,
    auto_mode: false,
  });
});

test('applies initial always-approve before forwarding session/new', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: {
        clientIdentifier,
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    },
  });

  assert.equal(output.toRuntime.length, 1);
  assert.deepEqual(output.toRuntime[0].params._meta, {
    clientIdentifier,
    yoloMode: true,
  });
  const response = proxy.handleRuntime(sessionResponse).toClient[0];
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('applies initial always-approve to restored sessions', () => {
  for (const method of ['session/load', 'session/resume']) {
    const proxy = new GrokAcpCompatibilityProxy();
    const output = proxy.handleClient({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        sessionId: 'grok-session',
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: {
          clientIdentifier,
          lody: {
            sessionConfig: {
              version: 1,
              configOptionValues: { permission_mode: 'always-approve' },
            },
          },
        },
      },
    });
    assert.equal(output.toRuntime[0].params._meta.yoloMode, true);
    assert.equal(output.toRuntime[0].params._meta.lody, undefined);
  }
});

test('maps initial ask and auto permission modes at the session boundary', () => {
  for (const [permissionMode, expectedYoloMode, expectedRuntimeMessages] of [
    ['ask', false, 1],
    ['auto', false, 2],
  ]) {
    const proxy = new GrokAcpCompatibilityProxy();
    const output = proxy.handleClient({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: {
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: {
          clientIdentifier,
          lody: {
            sessionConfig: {
              version: 1,
              configOptionValues: { permission_mode: permissionMode },
            },
          },
        },
      },
    });
    assert.equal(output.toRuntime.length, expectedRuntimeMessages);
    assert.equal(output.toRuntime.at(-1).params._meta.yoloMode, expectedYoloMode);
    if (permissionMode === 'auto') {
      assert.equal(output.toRuntime[0].method, '_x.ai/yolo_mode_changed');
      assert.equal(output.toRuntime[0].params.auto_mode, true);
    }
    const response = proxy.handleRuntime(sessionResponse).toClient[0];
    assert.equal(
      response.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
      permissionMode
    );
  }
});

test('optimistically syncs permission modes over the private extension notification', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  assert.equal(output.toRuntime.length, 1);
  assert.equal(output.toRuntime[0].method, '_x.ai/yolo_mode_changed');
  assert.equal(output.toRuntime[0].params.clientIdentifier, clientIdentifier);
  assert.equal(
    output.toClient[0].result.configOptions.find((option) => option.id === 'permission_mode')
      .currentValue,
    'always-approve'
  );
});

test('exposes experimental auto permission mode', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'auto',
    },
  });
  assert.equal(output.toRuntime[0].method, '_x.ai/yolo_mode_changed');
  assert.deepEqual(output.toRuntime[0].params, {
    clientIdentifier,
    permission_mode: 'auto',
    yolo_mode: false,
    auto_mode: true,
  });
  assert.equal(
    output.toClient[0].result.configOptions.find((option) => option.id === 'permission_mode')
      .currentValue,
    'auto'
  );
});

test('passes Grok native ACP permission requests and responses through unchanged', () => {
  const { proxy } = readyProxy();
  const request = {
    jsonrpc: '2.0',
    id: 77,
    method: 'session/request_permission',
    params: {
      sessionId: 'grok-session',
      toolCall: { toolCallId: 'write-1', title: 'Write file', kind: 'edit' },
      options: [
        { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
      ],
    },
  };
  assert.deepEqual(proxy.handleRuntime(request), { toRuntime: [], toClient: [request] });

  const response = {
    jsonrpc: '2.0',
    id: 77,
    result: { outcome: { outcome: 'selected', optionId: 'reject-once' } },
  };
  assert.deepEqual(proxy.handleClient(response), { toRuntime: [response], toClient: [] });
});

test('safely degrades a legacy Ask interaction selection to Plan across response ordering', () => {
  const { proxy } = readyProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 31,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'interaction_mode', value: 'ask' },
  }).toRuntime[0];
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 31,
    method: 'session/set_mode',
    params: { sessionId: 'grok-session', modeId: 'plan' },
  });
  proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'grok-session',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    },
  });
  const modeResponse = proxy.handleRuntime({ jsonrpc: '2.0', id: 31, result: {} }).toClient[0];
  assert.equal(
    modeResponse.result.configOptions.find((option) => option.id === 'interaction_mode')
      .currentValue,
    'plan'
  );
  const response = proxy.handleClient({
    jsonrpc: '2.0',
    id: 32,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'low' },
  });
  const configResponse = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 32,
    result: {},
  }).toClient[0];
  assert.equal(
    configResponse.result.configOptions.find((option) => option.id === 'interaction_mode')
      .currentValue,
    'plan'
  );
  assert.equal(response.toRuntime[0].method, 'session/set_model');
});

test('translates reasoning effort through set_model and preserves the model id', () => {
  const { proxy } = readyProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 4,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'reasoning_effort',
      value: 'low',
    },
  }).toRuntime[0];
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 4,
    method: 'session/set_model',
    params: {
      sessionId: 'grok-session',
      modelId: 'grok-build',
      _meta: { reasoningEffort: 'low' },
    },
  });
  const response = proxy.handleRuntime({ jsonrpc: '2.0', id: 4, result: {} }).toClient[0];
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort').currentValue,
    'low'
  );
});

test('requires the Lody clientIdentifier before changing permissions', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp', mcpServers: [] },
  });
  proxy.handleRuntime(sessionResponse);
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 5,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'ask',
    },
  });
  assert.equal(output.toRuntime.length, 0);
  assert.match(output.toClient[0].error.message, /clientIdentifier/);
});

test('restores optimistic permission state across session reload in the same wrapper', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 6,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 7,
    method: 'session/load',
    params: {
      sessionId: 'grok-session',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const loaded = proxy.handleRuntime({
    ...sessionResponse,
    id: 7,
    result: { ...sessionResponse.result, sessionId: undefined },
  }).toClient[0];
  assert.equal(
    loaded.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('preserves client-scoped permission state for a fresh replacement session', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 8,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 9,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const replacement = proxy.handleRuntime({
    ...sessionResponse,
    id: 9,
    result: { ...sessionResponse.result, sessionId: 'grok-session-2' },
  }).toClient[0];
  assert.equal(
    replacement.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('tracks the official snake_case model_changed notification', () => {
  const { proxy } = readyProxy();
  const modelChanged = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'model_changed',
        model_id: 'grok-4',
        reasoning_effort: 'low',
      },
    },
  });
  assert.equal(modelChanged.toRuntime[0].method, '_x.ai/session/info');
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 8,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'high' },
  }).toRuntime[0];
  assert.equal(request.params.modelId, 'grok-4');
});

test('normalizes official inclusive token counters into Lody disjoint usage buckets', () => {
  assert.deepEqual(normalizePromptUsage(promptUsage), {
    usage: {
      inputTokens: 600,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      reasoningOutputTokens: 50,
      costUSD: 0.025,
    },
    modelUsage: {
      'grok-build': {
        inputTokens: 600,
        outputTokens: 200,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
        reasoningOutputTokens: 50,
        costUSD: 0.025,
      },
    },
  });
});

test('drops untrustworthy costs while preserving incomplete token usage', () => {
  const normalized = normalizePromptUsage({
    ...promptUsage,
    usageIsIncomplete: true,
    modelUsage: {
      'grok-build': { ...promptUsage.modelUsage['grok-build'], costIsPartial: true },
    },
  });
  assert.equal(normalized.usage.costUSD, undefined);
  assert.equal(normalized.modelUsage['grok-build'].costUSD, undefined);
  assert.equal(normalized.usage.inputTokens, 600);
});

test('emits Lody token usage and requests authoritative context on turn completion', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-1',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
    },
  });

  assert.equal(output.toClient[0].method, '_x.ai/session/update');
  assert.equal(output.toClient[1].method, '_lody/session/usage_update');
  assert.deepEqual(output.toClient[1].params, {
    sessionId: 'grok-session',
    ...normalizePromptUsage(promptUsage),
  });
  assert.equal(output.toRuntime.length, 2);
  assert.equal(output.toRuntime[0].method, '_x.ai/session/info');
  assert.deepEqual(output.toRuntime[0].params, { sessionId: 'grok-session' });
  assert.equal(output.toRuntime[1].method, '_x.ai/billing');
  assert.deepEqual(output.toRuntime[1].params, {});
});

test('converts session info context into standard ACP usage_update for the existing UI', () => {
  const { proxy, startup } = readyProxy();
  assert.equal(startup.toRuntime.length, 2);
  assert.equal(startup.toRuntime[0].method, '_x.ai/session/info');

  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: startup.toRuntime[0].id,
    result: {
      result: {
        sessionId: 'grok-session',
        context: { used: 81_920, total: 256_000, freeTokens: 174_080, usagePct: 32 },
      },
    },
  });

  assert.equal(output.toRuntime.length, 0);
  assert.deepEqual(output.toClient, [
    {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'grok-session',
        update: { sessionUpdate: 'usage_update', size: 256_000, used: 81_920 },
      },
    },
  ]);
});

test('converts official Grok billing into Lody session rate limits', () => {
  const { proxy, startup } = readyProxy();
  const billingRequest = startup.toRuntime.find((message) => message.method === '_x.ai/billing');
  assert.ok(billingRequest);

  const billing = {
    config: {
      creditUsagePercent: 42.5,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-06-01T00:00:00Z',
        end: '2026-06-08T00:00:00Z',
      },
      onDemandCap: { val: 5_000 },
      onDemandUsed: { val: 300 },
      prepaidBalance: { val: 1_250 },
    },
    on_demand_enabled: true,
    subscription_tier: 'SuperGrok Heavy',
  };
  const expectedRateLimits = [
    {
      planName: 'SuperGrok Heavy',
      limitName: 'Grok Build',
      limitId: 'grok',
      scope: { providerId: 'grok' },
      windows: [
        {
          usedPercent: 42.5,
          windowDurationSeconds: 7 * 24 * 60 * 60,
          resetsAtEpochSeconds: Date.parse('2026-06-08T00:00:00Z') / 1000,
        },
      ],
    },
  ];
  const normalized = normalizeBillingRateLimits(billing);
  assert.deepEqual(normalized.rateLimits, expectedRateLimits);
  assert.equal(typeof normalized.fetchedAtEpochSeconds, 'number');

  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: billingRequest.id,
    result: billing,
  });
  assert.deepEqual(output.toRuntime, []);
  assert.equal(output.toClient[0].method, '_lody/rate_limits/update');
  assert.deepEqual(output.toClient[0].params.rateLimits, expectedRateLimits);
});

test('answers the independent Core rate-limit query without a session', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 91,
    method: '_lody/rate_limits/get',
    params: {},
  });
  assert.equal(request.toRuntime.length, 1);
  assert.equal(request.toRuntime[0].method, '_x.ai/billing');
  assert.deepEqual(request.toRuntime[0].params, {});

  const response = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: request.toRuntime[0].id,
    result: {
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          end: '2026-06-08T00:00:00Z',
        },
      },
      subscription_tier: 'SuperGrok Heavy',
    },
  });
  assert.deepEqual(response.toRuntime, []);
  assert.equal(response.toClient[0].id, 91);
  assert.equal(response.toClient[0].result.rateLimits[0].windows[0].usedPercent, 42.5);
  assert.equal(typeof response.toClient[0].result.fetchedAtEpochSeconds, 'number');
});

test('falls back to legacy Grok billing totals and clears stale limits on billing errors', () => {
  assert.equal(
    normalizeBillingRateLimits({
      config: { monthlyLimit: { val: 2_000 }, used: { val: 500 } },
    }).rateLimits[0].windows[0].usedPercent,
    25
  );

  const { proxy, startup } = readyProxy();
  const billingRequest = startup.toRuntime.find((message) => message.method === '_x.ai/billing');
  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: billingRequest.id,
    error: { code: -32603, message: 'Billing unavailable' },
  });
  assert.deepEqual(output.toRuntime, []);
  assert.equal(output.toClient[0].method, '_lody/rate_limits/update');
  assert.deepEqual(output.toClient[0].params.rateLimits, []);
});

test('matches the official Grok TUI zero-percent fallback for fresh unified billing', () => {
  const snapshot = normalizeBillingRateLimits({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-09T09:12:56Z',
        end: '2026-08-16T09:12:56Z',
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
    },
    subscription_tier: 'X Premium+',
  });
  assert.deepEqual(snapshot.rateLimits, [
    {
      planName: 'X Premium+',
      limitName: 'Grok Build',
      limitId: 'grok',
      scope: { providerId: 'grok' },
      windows: [
        {
          usedPercent: 0,
          windowDurationSeconds: 7 * 24 * 60 * 60,
          resetsAtEpochSeconds: Date.parse('2026-08-16T09:12:56Z') / 1000,
        },
      ],
    },
  ]);
  assert.equal(typeof snapshot.fetchedAtEpochSeconds, 'number');
});

test('keeps genuinely incomplete billing visible without inventing utilization', () => {
  const limits = normalizeBillingRateLimits({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-09T09:12:56Z',
        end: '2026-08-16T09:12:56Z',
      },
      isUnifiedBillingUser: true,
    },
    subscription_tier: 'X Premium+',
  });
  assert.deepEqual(limits.rateLimits, []);
});

test('does not pair historical utilization with the current billing period', () => {
  const limits = normalizeBillingRateLimits({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-16T00:00:00Z',
        end: '2026-08-23T00:00:00Z',
      },
      history: [
        {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-09T00:00:00Z',
          end: '2026-08-16T00:00:00Z',
          creditUsagePercent: 87,
        },
      ],
    },
    subscription_tier: 'SuperGrok',
  });
  assert.deepEqual(limits.rateLimits, []);
});

test('derives utilization from official billing history totals', () => {
  const limits = normalizeBillingRateLimits({
    config: {
      history: [
        {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-09T00:00:00Z',
          end: '2026-08-16T00:00:00Z',
          monthlyLimit: { val: 1_000 },
          totalUsed: { val: 250 },
        },
      ],
    },
    subscription_tier: 'SuperGrok',
  });
  assert.equal(limits.rateLimits[0].windows[0].usedPercent, 25);
  assert.equal(limits.rateLimits[0].windows[0].windowDurationSeconds, 7 * 24 * 60 * 60);
});

test('uses prompt response usage as a fallback and deduplicates turn_completed', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 20,
    method: 'session/prompt',
    params: { sessionId: 'grok-session', prompt: [] },
  });
  const promptResponse = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 20,
    result: {
      stopReason: 'end_turn',
      _meta: { sessionId: 'grok-session', promptId: 'prompt-2', usage: promptUsage },
    },
  });
  assert.equal(promptResponse.toClient[1].method, '_lody/session/usage_update');
  assert.equal(promptResponse.toRuntime[0].method, '_x.ai/session/info');
  assert.equal(promptResponse.toRuntime[1].method, '_x.ai/billing');

  const durableCompletion = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-2',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
    },
  });
  assert.equal(durableCompletion.toClient.length, 1);
  assert.equal(durableCompletion.toRuntime.length, 0);
});

test('does not record or re-query historical usage from replayed completions', () => {
  const { proxy } = readyProxy();
  const replay = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'old-prompt',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
      _meta: { isReplay: true },
    },
  });
  assert.equal(replay.toClient.length, 1);
  assert.equal(replay.toRuntime.length, 0);
});

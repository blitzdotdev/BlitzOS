import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type SessionConfigOption,
  type Stream,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apply } from './adapter.js';
import { DEEPSEEK_HARNESS_AGENT_PRESETS, DEEPSEEK_HARNESS_MODELS } from './capabilities.js';

type Listener = (...args: unknown[]) => unknown;

const DEFAULT_LLM_CATALOG = {
  listModels: async (provider: string) =>
    DEEPSEEK_HARNESS_MODELS.map((model) => ({
      provider,
      id: model.modelId,
      name: model.name,
      description: model.description,
      inputModalities: model.inputModalities,
    })),
};

function testHarnessService(name: string): unknown {
  return name === 'llm' ? DEFAULT_LLM_CATALOG : undefined;
}

function connectedStreams(): { agent: Stream; client: Stream } {
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agent: {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    },
    client: {
      readable: agentToClient.readable,
      writable: clientToAgent.writable,
    },
  };
}

function selectValue(options: SessionConfigOption[] | null | undefined, id: string): unknown {
  return options?.find((option) => option.id === id)?.currentValue;
}

function selectOption(options: SessionConfigOption[] | null | undefined, id: string) {
  return options?.find((option) => option.id === id);
}

describe('DeepSeek Harness ACP adapter', () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it('applies model, reasoning-effort, and permission selections to Harness state', async () => {
    const streams = connectedStreams();
    const scopedListeners = new Map<string, Listener>();
    const permissionSwitches: string[] = [];
    const agentPresetSwitches: string[] = [];
    let currentPermission = 'workspace-write';

    const context: Parameters<typeof apply>[0] = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            on<TArgs extends unknown[]>(
              event: string,
              listener: (...args: TArgs) => unknown
            ): () => void {
              scopedListeners.set(event, listener as Listener);
              return () => scopedListeners.delete(event);
            },
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          const session = {
            id: options.sessionId,
            header: { id: options.sessionId },
            events: [] as Array<{ type: string; data: { agentPreset: string } }>,
            append(type: 'agent-preset/selected', data: { agentPreset: string }) {
              this.events.push({ type, data });
            },
          };
          const agent = {
            id: options.sessionId,
            ctx: agentContext,
            session,
            followup: vi.fn(),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          return { agent, dispose: () => Promise.resolve() };
        },
        get: () => undefined,
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => currentPermission,
        set: (_session, mode) => {
          currentPermission = mode;
          permissionSwitches.push(mode);
        },
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [
          ...DEEPSEEK_HARNESS_AGENT_PRESETS.map((preset) => ({
            id: preset.value,
            name: `中文 ${preset.name}`,
            description: `中文 ${preset.description}`,
          })),
          { id: 'custom', name: 'Custom preset', description: 'User-provided preset' },
        ],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        recompose: async (_agentContext, id) => {
          agentPresetSwitches.push(id);
          return { id };
        },
      },
      logger: { warn: vi.fn() },
      on<TArgs extends unknown[]>(
        _event: string,
        _listener: (...args: TArgs) => unknown
      ): () => void {
        return () => undefined;
      },
      get: testHarnessService,
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, {
      stream: streams.agent,
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });

    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async () => undefined,
      }),
      streams.client
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentInfo?.name).toBe('acp-extension-dsh');
    expect(initialized.agentCapabilities._meta).toEqual({
      lody: { compaction: { version: 1 } },
    });

    const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(created.modes?.currentModeId).toBe('workspace-write');
    expect(selectValue(created.configOptions, 'agent_preset')).toBe('standard');
    expect(selectValue(created.configOptions, 'model')).toBe('deepseek-v4-pro');
    expect(selectValue(created.configOptions, 'reasoning_effort')).toBe('max');
    expect(selectOption(created.configOptions, 'agent_preset')).toMatchObject({
      options: [
        ...DEEPSEEK_HARNESS_AGENT_PRESETS.map((preset) => ({
          value: preset.value,
          name: preset.name,
          description: preset.description,
        })),
        { value: 'custom', name: 'Custom preset', description: 'User-provided preset' },
      ],
    });

    const modelResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'deepseek-v4-flash',
    });
    expect(selectValue(modelResponse.configOptions, 'model')).toBe('deepseek-v4-flash');

    const effortResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'reasoning_effort',
      value: 'off',
    });
    expect(selectValue(effortResponse.configOptions, 'reasoning_effort')).toBe('off');

    const modeResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'mode',
      value: 'danger-full-access',
    });
    expect(selectValue(modeResponse.configOptions, 'mode')).toBe('danger-full-access');
    expect(permissionSwitches).toEqual(['danger-full-access']);

    const presetResponse = await client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'agent_preset',
      value: 'minimal',
    });
    expect(selectValue(presetResponse.configOptions, 'agent_preset')).toBe('minimal');
    expect(agentPresetSwitches).toEqual(['minimal']);

    const assemblyListener = scopedListeners.get('system-prompt/assemble') as
      | ((
          assembly: unknown,
          context: unknown,
          next: () => Promise<{ variables: Record<string, unknown> }>
        ) => Promise<{ variables: Record<string, unknown> }>)
      | undefined;
    const requestListener = scopedListeners.get('agent/request') as
      | ((
          payload: unknown,
          next: () => Promise<Record<string, unknown>>
        ) => Promise<Record<string, unknown>>)
      | undefined;
    expect(assemblyListener).toBeDefined();
    expect(requestListener).toBeDefined();
    if (!assemblyListener || !requestListener) throw new Error('missing Harness model listeners');

    await assemblyListener({}, {}, async () => ({ variables: {} }));
    await expect(
      requestListener({}, async () => ({
        provider: 'inherited',
        model: 'inherited',
        reasoningEffort: 'high',
        maxTokens: 4096,
      }))
    ).resolves.toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
      maxTokens: 4096,
    });

    await expect(
      client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'model',
        value: 'not-a-model',
      })
    ).rejects.toThrow(/unknown model/u);
  });

  it('mounts ACP MCP servers in the Agent scope and releases their namespaces on close', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const mountedConfigs: Array<Record<string, unknown>> = [];
    const disposedSessions: string[] = [];
    const agents = new Map<string, TestAgent>();
    const mcpClientPlugin = { apply: vi.fn() };
    const importMcpClient = vi.fn(() => Promise.resolve(mcpClientPlugin));
    let nextMcpMountFailure: Error | undefined;
    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            on: () => () => undefined,
            plugin(_plugin, pluginConfig) {
              mountedConfigs.push({ ...pluginConfig });
              return {
                await: async () => {
                  const failure = nextMcpMountFailure;
                  nextMcpMountFailure = undefined;
                  if (failure) throw failure;
                },
              };
            },
            loader: {
              import: importMcpClient,
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          const agent: TestAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup: vi.fn(),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          agents.set(agent.id, agent);
          return {
            agent,
            dispose: async () => {
              disposedSessions.push(agent.id);
              agents.delete(agent.id);
            },
          };
        },
        get: (sessionId) => agents.get(sessionId),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        recompose: async (_agentContext, id) => ({ id }),
      },
      logger: { warn: vi.fn() },
      on: () => () => undefined,
      get: testHarnessService,
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async () => undefined,
      }),
      streams.client
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentCapabilities.mcpCapabilities).toEqual({ http: true });
    expect(initialized.agentCapabilities.sessionCapabilities?.close).toEqual({});

    const first = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [
        {
          name: 'lody',
          command: process.execPath,
          args: ['lody-mcp.js'],
          env: [{ name: 'LODY_MCP_SESSION_ID', value: 'session-1' }],
        },
        {
          type: 'http',
          name: 'remote tools',
          url: 'https://mcp.example.test',
          headers: [{ name: 'Authorization', value: 'Bearer test' }],
        },
      ],
    });
    expect(importMcpClient).toHaveBeenCalledWith('@deepseek-ai/dsh-mcp-client');
    expect(mountedConfigs).toEqual([
      {
        transport: 'stdio',
        serverName: 'lody',
        command: process.execPath,
        args: ['lody-mcp.js'],
        env: { LODY_MCP_SESSION_ID: 'session-1' },
        cwd: process.cwd(),
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      },
      {
        transport: 'streamable-http',
        serverName: expect.stringMatching(/^remote_tools_[a-f0-9]{8}$/u),
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer test' },
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      },
    ]);

    await client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'lody', command: process.execPath, args: [], env: [] }],
    });
    expect(mountedConfigs[2]?.serverName).toMatch(/^lody_[a-f0-9]{8}$/u);

    await client.closeSession({ sessionId: first.sessionId });
    expect(disposedSessions).toContain(first.sessionId);

    await client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'lody', command: process.execPath, args: [], env: [] }],
    });
    expect(mountedConfigs[3]?.serverName).toBe('lody');

    await expect(
      client.newSession({
        cwd: process.cwd(),
        mcpServers: [
          {
            type: 'sse',
            name: 'legacy-sse',
            url: 'https://mcp.example.test/sse',
            headers: [],
          },
        ],
      })
    ).rejects.toThrow(/MCP transport sse is not supported/u);

    nextMcpMountFailure = new Error('MCP startup failed');
    await expect(
      client.newSession({
        cwd: process.cwd(),
        mcpServers: [{ name: 'failing', command: process.execPath, args: [], env: [] }],
      })
    ).rejects.toThrow(/failed to create session: MCP startup failed/u);
    await client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'failing', command: process.execPath, args: [], env: [] }],
    });
    expect(mountedConfigs.at(-1)?.serverName).toBe('failing');
  });

  it('persists ACP images for the selected vision model and rejects them on text models', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const agents = new Map<string, TestAgent>();
    const queuedMessages: unknown[] = [];
    const saveImages = vi.fn(async () => [
      {
        attachmentId: `sha256:${'a'.repeat(64)}`,
        mediaType: 'image/png' as const,
        bytes: 3,
        width: 1,
        height: 1,
      },
    ]);
    const attachments = { saveImages };
    const runtimeModels = [
      {
        provider: 'deepseek-official',
        id: 'runtime-text',
        name: 'Runtime text',
        description: 'Discovered text model',
        inputModalities: ['text'],
      },
      {
        provider: 'deepseek-official',
        id: 'runtime-vision',
        name: 'Runtime vision',
        description: 'Discovered vision model',
        inputModalities: ['text', 'image'],
      },
    ];
    const llm = {
      listModels: vi.fn(async () => runtimeModels),
    };
    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            on: () => () => undefined,
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          const agent: TestAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup: (message) => queuedMessages.push(message),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          agents.set(agent.id, agent);
          return { agent, dispose: () => Promise.resolve() };
        },
        get: (sessionId) => agents.get(sessionId),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        recompose: async (_agentContext, id) => ({ id }),
      },
      logger: { warn: vi.fn() },
      on: () => () => undefined,
      get: (service) => {
        if (service === 'attachments') return attachments;
        if (service === 'llm') return llm;
        return undefined;
      },
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent, model: 'runtime-vision' });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async () => undefined,
      }),
      streams.client
    );
    const initialized = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentCapabilities.promptCapabilities.image).toBe(true);
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(selectOption(session.configOptions, 'model')).toMatchObject({
      currentValue: 'runtime-vision',
      options: [
        {
          value: 'runtime-text',
          name: 'Runtime text',
          description: 'Discovered text model',
        },
        {
          value: 'runtime-vision',
          name: 'Runtime vision',
          description: 'Discovered vision model',
        },
      ],
    });
    expect(
      (
        session as typeof session & {
          models: {
            currentModelId: string;
            availableModels: Array<{ modelId: string }>;
          };
        }
      ).models
    ).toMatchObject({
      currentModelId: 'runtime-vision',
      availableModels: [{ modelId: 'runtime-text' }, { modelId: 'runtime-vision' }],
    });
    expect(llm.listModels).toHaveBeenCalledWith('deepseek-official');

    await client.prompt({
      sessionId: session.sessionId,
      prompt: [
        { type: 'text', text: 'What is shown? ' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
        { type: 'text', text: 'Be concise.' },
      ],
    });
    expect(saveImages).toHaveBeenCalledWith([
      { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
    ]);
    expect(queuedMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown? ' },
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${'a'.repeat(64)}`,
              mediaType: 'image/png',
              bytes: 3,
              width: 1,
              height: 1,
            },
          },
          { type: 'text', text: 'Be concise.' },
        ],
      }),
    ]);

    await client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'runtime-text',
    });
    await expect(
      client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }],
      })
    ).rejects.toThrow(/does not support image input/u);
    expect(saveImages).toHaveBeenCalledTimes(1);
  });

  it('streams Harness reasoning and compaction lifecycle updates', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const globalListeners = new Map<string, Listener>();
    const updates: unknown[] = [];
    let createdAgent: TestAgent | undefined;
    let markUpdated: (() => void) | undefined;
    const updated = new Promise<void>((resolve) => {
      markUpdated = resolve;
    });

    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            on: () => () => undefined,
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          createdAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup: vi.fn(),
            cancel: vi.fn(),
            whenIdle: () => Promise.resolve(),
          };
          return { agent: createdAgent, dispose: () => Promise.resolve() };
        },
        get: (sessionId) => (createdAgent?.id === sessionId ? createdAgent : undefined),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        recompose: async (_agentContext, id) => ({ id }),
      },
      logger: { warn: vi.fn() },
      on<TArgs extends unknown[]>(
        event: string,
        listener: (...args: TArgs) => unknown
      ): () => void {
        globalListeners.set(event, listener as Listener);
        return () => globalListeners.delete(event);
      },
      get: testHarnessService,
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async (notification) => {
          updates.push(notification);
          if (updates.length === 8) markUpdated?.();
        },
      }),
      streams.client
    );
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    const sessionEvent = globalListeners.get('session/event');
    if (!createdAgent || !sessionEvent) throw new Error('missing Harness session event listener');

    sessionEvent(createdAgent.session, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'reasoning-delta', text: 'First thought. ' } },
    });
    sessionEvent(createdAgent.session, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'reasoning-delta', text: '' } },
    });
    sessionEvent(createdAgent.session, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'reasoning-delta', text: 'Second thought.' } },
    });
    sessionEvent(createdAgent.session, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'not forwarded before the final message' } },
    });
    sessionEvent(createdAgent.session, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'block-end', block: { type: 'reasoning' } } },
    });
    sessionEvent(createdAgent.session, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'block-end', block: { type: 'text' } } },
    });
    sessionEvent(createdAgent.session, {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'First thought. Second thought.' },
            { type: 'text', text: 'Final answer.' },
          ],
        },
      },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/start',
      data: { compactionId: 'manual-1', turn: null },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/end',
      data: { compactionId: 'manual-1', turn: null },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/start',
      data: { compactionId: 'automatic-1', turn: 2 },
    });
    sessionEvent(createdAgent.session, {
      type: 'compaction/end',
      data: { compactionId: 'automatic-1', turn: 2, error: 'summary failed' },
    });

    await updated;
    expect(updates).toEqual([
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'First thought. ' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Second thought.' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '\n\n' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Final answer.' },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'context-compaction:manual-1',
          title: 'Compacting context',
          kind: 'think',
          status: 'in_progress',
          _meta: {
            lody: {
              activity: { version: 1, kind: 'context_compaction', automatic: false },
            },
          },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'context-compaction:manual-1',
          title: 'Context compacted',
          status: 'completed',
          _meta: {
            lody: {
              activity: { version: 1, kind: 'context_compaction', automatic: false },
            },
          },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'context-compaction:automatic-1',
          title: 'Compacting context',
          kind: 'think',
          status: 'in_progress',
          _meta: {
            lody: {
              activity: { version: 1, kind: 'context_compaction', automatic: true },
            },
          },
        },
      },
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'context-compaction:automatic-1',
          title: 'Context compaction failed',
          status: 'failed',
          _meta: {
            lody: {
              activity: {
                version: 1,
                kind: 'context_compaction',
                automatic: true,
                failureReason: 'summary failed',
              },
            },
          },
        },
      },
    ]);
  });

  it('rejects the active ACP prompt when Harness reports an error for its turn', async () => {
    type AdapterContext = Parameters<typeof apply>[0];
    type TestAgent = NonNullable<ReturnType<AdapterContext['agents']['get']>>;

    const streams = connectedStreams();
    const globalListeners = new Map<string, Listener>();
    let createdAgent: TestAgent | undefined;
    let queuedMessage: { id: string } | undefined;
    let markQueued: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve;
    });
    const remainsBusy = new Promise<void>(() => undefined);

    const context: AdapterContext = {
      agents: {
        async create(options) {
          const agentContext: Parameters<typeof options.setup>[0] = {
            on: () => () => undefined,
            plugin: () => ({ await: () => Promise.resolve() }),
            loader: {
              import: () => Promise.resolve({}),
              unwrapExports: (exports) => exports,
            },
          };
          await options.setup(agentContext);
          createdAgent = {
            id: options.sessionId,
            ctx: agentContext,
            session: {
              id: options.sessionId,
              header: { id: options.sessionId },
              events: [],
              append: vi.fn(),
            },
            followup(message) {
              queuedMessage = message;
              markQueued?.();
            },
            cancel: vi.fn(),
            whenIdle: () => remainsBusy,
          };
          return { agent: createdAgent, dispose: () => Promise.resolve() };
        },
        get: (sessionId) => (createdAgent?.id === sessionId ? createdAgent : undefined),
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        defaultPreset: 'workspace-write',
        current: () => 'workspace-write',
        set: vi.fn(),
      },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [{ id: 'standard' }, { id: 'minimal' }],
        mount: async (_agentContext, id = 'standard') => ({ id }),
        recompose: async (_agentContext, id) => ({ id }),
      },
      logger: { warn: vi.fn() },
      on<TArgs extends unknown[]>(
        event: string,
        listener: (...args: TArgs) => unknown
      ): () => void {
        globalListeners.set(event, listener as Listener);
        return () => globalListeners.delete(event);
      },
      get: testHarnessService,
      effect: (register) => {
        disposers.push(register());
      },
    };

    apply(context, { stream: streams.agent });
    const client = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: async () => undefined,
      }),
      streams.client
    );
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    await queued;
    await expect(
      client.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'agent_preset',
        value: 'minimal',
      })
    ).rejects.toThrow(/fixed after the session has started/u);
    if (!createdAgent || !queuedMessage) throw new Error('prompt was not queued');
    const inboxClaimed = globalListeners.get('agent/inbox/claimed');
    const agentError = globalListeners.get('agent/error');
    if (!inboxClaimed || !agentError) throw new Error('missing Harness lifecycle listeners');
    inboxClaimed({ agent: createdAgent, message: queuedMessage, turn: 7 });
    agentError({ agent: createdAgent, turn: 7, error: new Error('provider failed') });

    await expect(prompt).rejects.toThrow(/turn failed: provider failed/u);
  });
});

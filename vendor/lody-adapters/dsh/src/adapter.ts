/**
 * ACP surface for DeepSeek Harness.
 *
 * The upstream ACP plugin intentionally exposes only automation basics. This
 * adapter keeps its prompt, lifecycle, cancellation, and one-shot approval
 * behavior while adding standard ACP session controls backed by Harness's
 * per-agent model waterfall and permission-preset service.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { LodyActivityMeta, LodyExtensionCapabilities } from 'acp-extension-core';
import {
  DEEPSEEK_HARNESS_AGENT_PRESETS,
  DEEPSEEK_HARNESS_PERMISSION_MODES,
  DEEPSEEK_HARNESS_REASONING_OPTIONS,
} from './capabilities.js';
import { ACP_EXTENSION_DSH_VERSION } from './profile.js';

export const name = 'acp-extension-dsh';
// Waiting for persistence/query also preserves the upstream composite's
// startup boundary: ACP cannot accept a session until durability is ready.
export const inject = [
  'agents',
  'agentPresets',
  'attachments',
  'loader',
  'llm',
  'permissionPresets',
  'sessionPersistence',
  'sessionQuery',
];

type ReasoningEffort = 'off' | 'high' | 'max';

type ModelSelection = {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

type ModelSelectionRef = {
  current: ModelSelection;
  assembled?: ModelSelection;
};

type HarnessRequestConfig = Record<string, unknown> & {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

type HarnessPromptAssembly = Record<string, unknown> & {
  variables?: Record<string, unknown>;
};

type HarnessTextBlock = { type: 'text'; text: string };
type HarnessImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
type HarnessImageAttachmentRef = {
  attachmentId: string;
  mediaType: HarnessImageMediaType;
  bytes: number;
  width: number;
  height: number;
};
type HarnessImageBlock = {
  type: 'image';
  attachment: HarnessImageAttachmentRef;
};
type HarnessMessageBlock = HarnessTextBlock | HarnessImageBlock | { type: string };
type HarnessStreamChunk = {
  type: string;
  text?: string;
  block?: { type: string };
};

type HarnessTurnEndReason =
  | { kind: 'completed' | 'max-tokens' | 'aborted' | 'interrupted' | 'blocked' }
  | { kind: 'error'; error: { message: string } };

type HarnessSessionEvent = {
  type: string;
  data: {
    turn?: number | null;
    reason?: HarnessTurnEndReason;
    chunk?: HarnessStreamChunk;
    message?: { content: HarnessMessageBlock[] };
    agentPreset?: string;
    compactionId?: string;
    error?: string;
  };
};

const LODY_CAPABILITIES = {
  compaction: { version: 1 },
} as const satisfies LodyExtensionCapabilities;

type HarnessSession = {
  id: string;
  header: { id: string };
  events: readonly HarnessSessionEvent[];
  append(type: 'agent-preset/selected', data: { agentPreset: string }): void;
};

type HarnessAgent = {
  id: string;
  ctx: HarnessAgentContext;
  session: HarnessSession;
  followup(message: HarnessUserMessage): void;
  cancel(cause: { kind: 'user' }): void;
  whenIdle(): Promise<void>;
};

type HarnessUserMessage = {
  id: string;
  role: 'user';
  content: Array<HarnessTextBlock | HarnessImageBlock>;
  source: { kind: 'user' };
};

type HarnessAttachmentStore = {
  saveImages(
    images: readonly { data: Uint8Array; mediaType: HarnessImageMediaType }[]
  ): Promise<readonly HarnessImageAttachmentRef[]>;
};

type HarnessCatalogModel = {
  provider: string;
  id: string;
  name?: string;
  description?: string;
  inputModalities?: readonly string[];
};

type HarnessLlmCatalog = {
  listModels(provider: string): Promise<readonly HarnessCatalogModel[]>;
};

type HarnessAgentContext = {
  on<TArgs extends unknown[]>(event: string, listener: (...args: TArgs) => unknown): () => void;
  plugin(plugin: HarnessPlugin, config: HarnessMcpClientConfig): HarnessPluginHandle;
  loader: {
    import(name: string): Promise<unknown>;
    unwrapExports(exports: unknown): unknown;
  };
};

type HarnessPlugin = {
  apply(context: unknown, config: HarnessMcpClientConfig): unknown;
};

type HarnessPluginHandle = {
  await(): Promise<unknown>;
};

type HarnessMcpClientConfig =
  | {
      transport: 'stdio';
      serverName: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
      toolCallTimeoutMs: number;
      failOnStartupError: boolean;
    }
  | {
      transport: 'streamable-http';
      serverName: string;
      url: string;
      headers: Record<string, string>;
      toolCallTimeoutMs: number;
      failOnStartupError: boolean;
    };

type HarnessAgentHandle = {
  agent: HarnessAgent;
  dispose(): Promise<void>;
};

type HarnessAgentPreset = {
  id: string;
  name?: string;
  description?: string;
  broken?: string;
};

type HarnessContext = {
  agents: {
    create(options: {
      sessionId: string;
      meta: { cwd: string; agentPreset: string };
      agentOptions: { provider: string; model: string };
      setup(agentContext: HarnessAgentContext): void | Promise<void>;
    }): Promise<HarnessAgentHandle>;
    get(sessionId: string): HarnessAgent | undefined;
  };
  permissionPresets: {
    names: readonly string[];
    defaultPreset: string;
    current(events: readonly HarnessSessionEvent[]): string;
    set(session: HarnessSession, name: string): void;
  };
  agentPresets: {
    defaultId: string;
    list(): Promise<HarnessAgentPreset[]>;
    mount(agentContext: HarnessAgentContext, id?: string): Promise<HarnessAgentPreset>;
    recompose(agentContext: HarnessAgentContext, id: string): Promise<HarnessAgentPreset>;
  };
  logger: {
    warn(message: string): void;
  };
  on<TArgs extends unknown[]>(event: string, listener: (...args: TArgs) => unknown): () => void;
  get(name: string): unknown;
  effect(register: () => () => Promise<void>, label: string): void;
};

export type DeepSeekAcpAdapterConfig = {
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Runtime-only transport override used by unit tests. */
  stream?: Stream;
};

type ResolvedAdapterConfig = {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  stream?: Stream;
};

type InflightPrompt = {
  resolve(reason: StopReason): void;
  reject(error: Error): void;
  messageId: string;
  turn?: number;
  endReason?: HarnessTurnEndReason;
};

type SessionRecord = {
  agent: HarnessAgent;
  dispose(): Promise<void>;
  selection: ModelSelectionRef;
  permissionMode: string;
  agentPreset: string;
  agentPresetOptions: HarnessAgentPreset[];
  models: HarnessCatalogModel[];
  started: boolean;
  inflight?: InflightPrompt;
};

type NewSessionResponseWithModels = NewSessionResponse & {
  models: {
    currentModelId: string;
    availableModels: Array<{
      modelId: string;
      name: string;
      description: string | null;
    }>;
  };
};

type ContinuableDrain = {
  drainContinuableDescendants(parents: readonly HarnessAgent[]): Promise<void>;
};

const MODEL_CONFIG_ID = 'model';
const MODE_CONFIG_ID = 'mode';
const REASONING_EFFORT_CONFIG_ID = 'reasoning_effort';
const AGENT_PRESET_CONFIG_ID = 'agent_preset';
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const MCP_TOOL_CALL_TIMEOUT_MS = 60_000;
const MCP_SERVER_NAME_MAX_LENGTH = 32;
const MCP_SERVER_NAME_HASH_LENGTH = 8;
const INVALID_MCP_SERVER_NAME_CHARS = /[^A-Za-z0-9_-]/gu;
const IMAGE_MEDIA_TYPES: readonly HarnessImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const IMAGE_ADMISSION_ERROR_CODES = new Set([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
]);

const PERMISSION_MODE_IDS = new Set<string>(
  DEEPSEEK_HARNESS_PERMISSION_MODES.map((mode) => mode.id)
);
const REASONING_EFFORT_IDS = new Set<string>(
  DEEPSEEK_HARNESS_REASONING_OPTIONS.map((effort) => effort.value)
);

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail);
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail);
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function resolveAdapterConfig(config: DeepSeekAcpAdapterConfig | undefined): ResolvedAdapterConfig {
  const provider = nonEmptyString(config?.provider, 'deepseek-official');
  const model = nonEmptyString(config?.model, 'deepseek-v4-pro');
  const reasoningEffort = config?.reasoningEffort ?? 'max';
  if (!REASONING_EFFORT_IDS.has(reasoningEffort)) {
    throw new Error(
      `acp-extension-dsh: unsupported reasoning effort ${JSON.stringify(reasoningEffort)}`
    );
  }
  return {
    provider,
    model,
    reasoningEffort,
    ...(config?.stream ? { stream: config.stream } : {}),
  };
}

async function loadHarnessModels(
  ctx: HarnessContext,
  provider: string
): Promise<HarnessCatalogModel[]> {
  const llm = ctx.get('llm') as HarnessLlmCatalog | undefined;
  if (!llm) throw new Error('acp-extension-dsh: no Harness LLM catalog is mounted');
  const listed = await llm.listModels(provider);
  const models: HarnessCatalogModel[] = [];
  const ids = new Set<string>();
  for (const model of listed) {
    if (model.provider !== provider || !model.id.trim()) continue;
    if (ids.has(model.id)) {
      throw new Error(
        `acp-extension-dsh: duplicate model ${JSON.stringify(model.id)} for provider ${JSON.stringify(provider)}`
      );
    }
    ids.add(model.id);
    models.push({
      ...model,
      ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
    });
  }
  return models;
}

async function loadMcpClientPlugin(agentContext: HarnessAgentContext): Promise<HarnessPlugin> {
  const module = agentContext.loader.unwrapExports(
    await agentContext.loader.import(MCP_CLIENT_PACKAGE)
  );
  if (
    typeof module !== 'object' ||
    module === null ||
    !('apply' in module) ||
    typeof module.apply !== 'function'
  ) {
    throw new Error(`${MCP_CLIENT_PACKAGE} does not export a Cordis plugin`);
  }
  return module as HarnessPlugin;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, MCP_SERVER_NAME_HASH_LENGTH);
}

function normalizedMcpServerName(serverName: string, fallbackIndex: number): string {
  const normalized = serverName.replace(INVALID_MCP_SERVER_NAME_CHARS, '_');
  const base = normalized || `server_${fallbackIndex + 1}`;
  if (base === serverName && base.length <= MCP_SERVER_NAME_MAX_LENGTH) return base;
  const hash = shortHash(serverName);
  return `${base.slice(0, MCP_SERVER_NAME_MAX_LENGTH - hash.length - 1)}_${hash}`;
}

function reserveMcpServerNames(
  servers: readonly McpServer[],
  sessionId: string,
  activeNames: Set<string>
): { names: string[]; release(): void } {
  const names: string[] = [];
  for (const [index, server] of servers.entries()) {
    const base = normalizedMcpServerName(server.name, index);
    let reservedName = base;
    let attempt = 0;
    while (activeNames.has(reservedName)) {
      const suffix = shortHash(`${sessionId}\0${index}\0${attempt}`);
      reservedName = `${base.slice(0, MCP_SERVER_NAME_MAX_LENGTH - suffix.length - 1)}_${suffix}`;
      attempt += 1;
    }
    activeNames.add(reservedName);
    names.push(reservedName);
  }

  let released = false;
  return {
    names,
    release() {
      if (released) return;
      released = true;
      for (const reservedName of names) activeNames.delete(reservedName);
    },
  };
}

function entriesToRecord(
  entries: readonly { name: string; value: string }[]
): Record<string, string> {
  return Object.fromEntries(entries.map(({ name: entryName, value }) => [entryName, value]));
}

function mcpClientConfig(
  server: McpServer,
  serverName: string,
  cwd: string
): HarnessMcpClientConfig {
  if (!('type' in server)) {
    return {
      transport: 'stdio',
      serverName,
      command: server.command,
      args: [...server.args],
      env: entriesToRecord(server.env),
      cwd,
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    };
  }
  if (server.type === 'http') {
    return {
      transport: 'streamable-http',
      serverName,
      url: server.url,
      headers: entriesToRecord(server.headers),
      toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: true,
    };
  }
  throw invalidParams(`MCP transport ${server.type} is not supported`);
}

async function mountMcpServers(
  agentContext: HarnessAgentContext,
  servers: readonly McpServer[],
  serverNames: readonly string[],
  cwd: string
): Promise<void> {
  if (servers.length === 0) return;
  const plugin = await loadMcpClientPlugin(agentContext);
  const handles = servers.map((server, index) => {
    const serverName = serverNames[index];
    if (!serverName) throw new Error(`missing MCP namespace for server ${index}`);
    return agentContext.plugin(plugin, mcpClientConfig(server, serverName, cwd));
  });
  await Promise.all(handles.map((handle) => handle.await()));
}

function cloneSelection(selection: ModelSelection): ModelSelection {
  return { ...selection };
}

function installModelSelection(
  agentContext: HarnessAgentContext,
  selection: ModelSelectionRef
): void {
  agentContext.on(
    'system-prompt/assemble',
    async (_assembly: unknown, _context: unknown, next: () => Promise<HarnessPromptAssembly>) => {
      const selected = cloneSelection(selection.current);
      const assembled = await next();
      selection.assembled = selected;
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: selected.provider,
          model: selected.model,
        },
      };
    }
  );
  agentContext.on(
    'agent/request',
    async (_payload: unknown, next: () => Promise<HarnessRequestConfig>) => {
      const resolved = await next();
      const selected = selection.assembled ?? selection.current;
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        reasoningEffort: selected.reasoningEffort,
      };
    }
  );
}

function configOptions(record: SessionRecord): SessionConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: 'Permission',
      description: 'Sandbox and approval policy for the session',
      category: 'mode',
      type: 'select',
      currentValue: record.permissionMode,
      options: DEEPSEEK_HARNESS_PERMISSION_MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null,
      })),
    },
    {
      id: AGENT_PRESET_CONFIG_ID,
      name: 'Agent preset',
      description: 'Tools, prompt, and capabilities composed for the session',
      category: 'agent_preset',
      type: 'select',
      currentValue: record.agentPreset,
      options: record.agentPresetOptions.map((preset) => {
        const builtIn = DEEPSEEK_HARNESS_AGENT_PRESETS.find(
          (candidate) => candidate.value === preset.id
        );
        // The pinned Harness presets may carry upstream-localized metadata.
        // Keep built-in ACP labels stable; runtime metadata still owns user presets.
        return {
          value: preset.id,
          name: builtIn?.name ?? preset.name ?? preset.id,
          description: builtIn?.description ?? preset.description ?? null,
        };
      }),
    },
    {
      id: MODEL_CONFIG_ID,
      name: 'Model',
      description: 'DeepSeek model used for the session',
      category: 'model',
      type: 'select',
      currentValue: record.selection.current.model,
      options: record.models.map((model) => ({
        value: model.id,
        name: model.name ?? model.id,
        description: model.description ?? null,
      })),
    },
    {
      id: REASONING_EFFORT_CONFIG_ID,
      name: 'Reasoning effort',
      description: 'How much reasoning effort the model should use',
      category: 'thought_level',
      type: 'select',
      currentValue: record.selection.current.reasoningEffort,
      options: DEEPSEEK_HARNESS_REASONING_OPTIONS.map((effort) => ({
        value: effort.value,
        name: effort.name,
        description: effort.description ?? null,
      })),
    },
  ];
}

function modeState(record: SessionRecord): SessionModeState {
  return {
    currentModeId: record.permissionMode,
    availableModes: DEEPSEEK_HARNESS_PERMISSION_MODES.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description ?? null,
    })),
  };
}

function modelSupportsImages(models: readonly HarnessCatalogModel[], modelId: string): boolean {
  return models.some(
    (model) =>
      model.id === modelId &&
      (model.inputModalities as readonly string[] | undefined)?.includes('image')
  );
}

function imageMediaType(value: string): HarnessImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.includes(value as HarnessImageMediaType)
    ? (value as HarnessImageMediaType)
    : undefined;
}

function decodePromptImage(block: Extract<PromptRequest['prompt'][number], { type: 'image' }>): {
  data: Uint8Array;
  mediaType: HarnessImageMediaType;
} {
  const mediaType = imageMediaType(block.mimeType);
  if (!mediaType) {
    throw invalidParams('image mimeType must be image/png, image/jpeg, image/webp, or image/gif');
  }
  if (!block.data || !CANONICAL_BASE64.test(block.data)) {
    throw invalidParams('image data must be canonical base64');
  }
  const decoded = Buffer.from(block.data, 'base64');
  if (decoded.toString('base64') !== block.data) {
    throw invalidParams('image data must be canonical base64');
  }
  return { data: new Uint8Array(decoded), mediaType };
}

function isImageAdmissionError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    IMAGE_ADMISSION_ERROR_CODES.has(error.code)
  );
}

async function admitAcpPrompt(
  prompt: PromptRequest['prompt'],
  models: readonly HarnessCatalogModel[],
  modelId: string,
  attachments: HarnessAttachmentStore | undefined
): Promise<Array<HarnessTextBlock | HarnessImageBlock>> {
  const images: Array<{ data: Uint8Array; mediaType: HarnessImageMediaType }> = [];
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
      case 'resource_link':
        break;
      case 'image':
        if (!modelSupportsImages(models, modelId)) {
          throw invalidParams(`model ${JSON.stringify(modelId)} does not support image input`);
        }
        images.push(decodePromptImage(block));
        break;
      case 'audio':
        throw invalidParams('audio prompt content is not supported');
      case 'resource':
        throw invalidParams('embedded resource prompt content is not supported');
      default:
        throw invalidParams('unsupported ACP prompt content');
    }
  }

  let refs: readonly HarnessImageAttachmentRef[] = [];
  if (images.length > 0) {
    if (!attachments) throw internalError('no Harness attachment store is mounted');
    try {
      refs = await attachments.saveImages(images);
    } catch (error: unknown) {
      if (isImageAdmissionError(error)) throw invalidParams(error.message);
      throw internalError('unable to persist the prompt image batch');
    }
  }

  const content: Array<HarnessTextBlock | HarnessImageBlock> = [];
  let pendingText = '';
  let imageIndex = 0;
  const flushText = (): void => {
    if (!pendingText) return;
    content.push({ type: 'text', text: pendingText });
    pendingText = '';
  };
  for (const block of prompt) {
    if (block.type === 'text') {
      pendingText += block.text;
    } else if (block.type === 'resource_link') {
      pendingText += `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`;
    } else if (block.type === 'image') {
      flushText();
      const attachment = refs[imageIndex++];
      if (!attachment)
        throw internalError('the attachment store returned an incomplete image batch');
      content.push({ type: 'image', attachment });
    }
  }
  flushText();
  if (
    !content.some(
      (block) => block.type === 'image' || (block.type === 'text' && block.text.trim().length > 0)
    )
  ) {
    throw invalidParams('empty prompt');
  }
  return content;
}

function createUserMessage(
  id: string,
  content: Array<HarnessTextBlock | HarnessImageBlock>
): HarnessUserMessage {
  return Object.freeze({
    id,
    role: 'user' as const,
    content: Object.freeze(content.map((block) => Object.freeze(block))),
    source: Object.freeze({ kind: 'user' as const }),
  }) as HarnessUserMessage;
}

function turnEndToStopReason(reason: HarnessTurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn';
    case 'max-tokens':
      return 'max_tokens';
    case 'interrupted':
      return 'cancelled';
    case 'aborted':
    case 'blocked':
    case 'error':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

function errorChain(value: unknown): string {
  const seen = new Set<unknown>();
  const render = (current: unknown): string => {
    if (seen.has(current)) return '<circular cause>';
    seen.add(current);
    try {
      if (!(current instanceof Error)) return String(current);
      const message = current.message || current.name;
      const cause = current.cause == null ? '' : render(current.cause);
      return cause && cause !== message ? `${message}: ${cause}` : message;
    } finally {
      seen.delete(current);
    }
  };
  return render(value);
}

function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
  }
  if (params.additionalDirectories && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported');
  }
  for (const server of params.mcpServers) {
    if ('type' in server && server.type !== 'http') {
      throw invalidParams(`MCP transport ${server.type} is not supported`);
    }
  }
}

function requireSelectValue(params: SetSessionConfigOptionRequest): string {
  if (typeof params.value !== 'string') {
    throw invalidParams(`${params.configId} requires a select value`);
  }
  return params.value;
}

function assertAllowed(value: string, allowed: ReadonlySet<string>, label: string): void {
  if (!allowed.has(value)) {
    throw invalidParams(`unknown ${label}: ${value} (available: ${[...allowed].join(', ')})`);
  }
}

/** Mount the ACP bridge into the surrounding Harness composition. */
export function apply(ctx: HarnessContext, rawConfig?: DeepSeekAcpAdapterConfig): void {
  const config = resolveAdapterConfig(rawConfig);
  const sessions = new Map<string, SessionRecord>();
  const activeMcpServerNames = new Set<string>();
  let closed = false;
  let conn: AgentSideConnection;

  for (const mode of PERMISSION_MODE_IDS) {
    if (!ctx.permissionPresets.names.includes(mode)) {
      throw new Error(
        `acp-extension-dsh: permission preset ${JSON.stringify(mode)} is not composed`
      );
    }
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed');
  };

  const requireSession = (sessionId: string): SessionRecord => {
    const record = sessions.get(sessionId);
    if (!record) throw invalidParams(`unknown session: ${sessionId}`);
    return record;
  };

  const ownedRecord = (agent: HarnessAgent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id);
    return record?.agent === agent ? record : undefined;
  };

  const notify = (notification: SessionNotification): void => {
    void conn.sessionUpdate(notification).catch((error: unknown) => {
      ctx.logger.warn(`acp-extension-dsh: session/update failed: ${String(error)}`);
    });
  };

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight;
    if (!inflight) return;
    record.inflight = undefined;
    inflight.resolve(reason);
  };

  const disposeRecords = async (records: readonly SessionRecord[]): Promise<void> => {
    const subagents = ctx.get('subagents') as ContinuableDrain | undefined;
    if (subagents) {
      try {
        await subagents.drainContinuableDescendants(records.map((record) => record.agent));
      } catch (error: unknown) {
        ctx.logger.warn(
          `acp-extension-dsh: continuable subagent teardown failed: ${String(error)}`
        );
      }
    }
    const results = await Promise.allSettled(records.map((record) => record.dispose()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `DeepSeek ACP teardown failed for ${failures.length} session(s): ${failures
          .map(errorChain)
          .join('; ')}`
      );
    }
  };

  ctx.on('session/event', (session: HarnessSession, event: HarnessSessionEvent) => {
    const record = sessions.get(session.header.id);
    if (!record || record.agent.session !== session) return;
    try {
      if (
        event.type === 'assistant/chunk' &&
        event.data.chunk?.type === 'reasoning-delta' &&
        typeof event.data.chunk.text === 'string' &&
        event.data.chunk.text.length > 0
      ) {
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: event.data.chunk.text },
          },
        });
      } else if (
        event.type === 'assistant/chunk' &&
        event.data.chunk?.type === 'block-end' &&
        event.data.chunk.block?.type === 'reasoning'
      ) {
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: '\n\n' },
          },
        });
      } else if (event.type === 'assistant/message') {
        for (const block of event.data.message?.content ?? []) {
          if (block.type === 'text' && 'text' in block && block.text.length > 0) {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: block.text },
              },
            });
          } else if (block.type === 'image' && 'attachment' in block) {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `[image attachment ${block.attachment.attachmentId}]`,
                },
              },
            });
          }
        }
      } else if (event.type === 'compaction/start' && event.data.compactionId) {
        const activity = {
          version: 1,
          kind: 'context_compaction',
          automatic: event.data.turn !== null,
        } as const satisfies LodyActivityMeta;
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `context-compaction:${event.data.compactionId}`,
            title: 'Compacting context',
            kind: 'think',
            status: 'in_progress',
            _meta: { lody: { activity } },
          },
        });
      } else if (event.type === 'compaction/end' && event.data.compactionId) {
        const activity = {
          version: 1,
          kind: 'context_compaction',
          automatic: event.data.turn !== null,
          ...(event.data.error ? { failureReason: event.data.error } : {}),
        } as const satisfies LodyActivityMeta;
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `context-compaction:${event.data.compactionId}`,
            title: event.data.error ? 'Context compaction failed' : 'Context compacted',
            status: event.data.error ? 'failed' : 'completed',
            _meta: { lody: { activity } },
          },
        });
      }
    } finally {
      const inflight = record.inflight;
      if (
        inflight &&
        event.type === 'turn/end' &&
        inflight.turn === event.data.turn &&
        event.data.reason
      ) {
        if (event.data.reason.kind === 'error') {
          record.inflight = undefined;
          inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`));
        } else {
          inflight.endReason = event.data.reason;
        }
      }
    }
  });

  ctx.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }: { agent: HarnessAgent; message: { id: string }; turn: number }) => {
      const inflight = ownedRecord(agent)?.inflight;
      if (inflight && inflight.messageId === message.id) inflight.turn = turn;
    }
  );

  ctx.on(
    'agent/error',
    ({ agent, turn, error }: { agent: HarnessAgent; turn: number; error: unknown }) => {
      const record = ownedRecord(agent);
      const inflight = record?.inflight;
      if (!record || !inflight || (inflight.turn !== undefined && inflight.turn !== turn)) return;
      record.inflight = undefined;
      inflight.reject(internalError(`turn failed: ${errorChain(error)}`));
    }
  );

  ctx.on(
    'approval/request',
    (
      request: { agent: HarnessAgent; callId?: string },
      next: () => Promise<unknown>
    ): Promise<unknown> | undefined => {
      const record = ownedRecord(request.agent);
      if (!record || !request.callId) return next();
      return conn
        .requestPermission({
          sessionId: record.agent.session.id,
          toolCall: { toolCallId: request.callId },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        })
        .then(({ outcome }) => {
          if (outcome.outcome === 'cancelled') return 'cancelled';
          return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected';
        });
    }
  );

  const setPermissionMode = (record: SessionRecord, modeId: string): void => {
    assertAllowed(modeId, PERMISSION_MODE_IDS, 'permission mode');
    ctx.permissionPresets.set(record.agent.session, modeId);
    record.permissionMode = modeId;
  };

  const setConfigOption = (
    record: SessionRecord,
    params: SetSessionConfigOptionRequest
  ): SetSessionConfigOptionResponse | Promise<SetSessionConfigOptionResponse> => {
    const value = requireSelectValue(params);
    if (params.configId === MODE_CONFIG_ID) {
      setPermissionMode(record, value);
    } else if (params.configId === AGENT_PRESET_CONFIG_ID) {
      const available = new Set(record.agentPresetOptions.map((preset) => preset.id));
      assertAllowed(value, available, 'agent preset');
      if (value === record.agentPreset) return { configOptions: configOptions(record) };
      if (record.started) {
        throw invalidParams('agent preset is fixed after the session has started');
      }
      return ctx.agentPresets
        .recompose(record.agent.ctx, value)
        .then((preset) => {
          record.agent.session.append('agent-preset/selected', { agentPreset: preset.id });
          record.agentPreset = preset.id;
          return { configOptions: configOptions(record) };
        })
        .catch((error: unknown) => {
          if (error instanceof RequestError) throw error;
          throw invalidParams(
            `failed to select agent preset ${JSON.stringify(value)}: ${errorChain(error)}`
          );
        });
    } else if (params.configId === MODEL_CONFIG_ID) {
      assertAllowed(value, new Set(record.models.map((model) => model.id)), 'model');
      record.selection.current = { ...record.selection.current, model: value };
    } else if (params.configId === REASONING_EFFORT_CONFIG_ID) {
      assertAllowed(value, REASONING_EFFORT_IDS, 'reasoning effort');
      record.selection.current = {
        ...record.selection.current,
        reasoningEffort: value as ReasoningEffort,
      };
    } else {
      throw invalidParams(`unknown config option: ${params.configId}`);
    }
    return { configOptions: configOptions(record) };
  };

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection;
    return {
      async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        const models = await loadHarnessModels(ctx, config.provider);
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'acp-extension-dsh', version: ACP_EXTENSION_DSH_VERSION },
          agentCapabilities: {
            promptCapabilities: {
              image: models.some((model) => modelSupportsImages(models, model.id)),
              audio: false,
              embeddedContext: false,
            },
            mcpCapabilities: { http: true },
            sessionCapabilities: { close: {} },
            _meta: { lody: LODY_CAPABILITIES },
          },
          authMethods: [],
        };
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve();
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponseWithModels> {
        assertOpen();
        validateSessionParams(params);
        let models: HarnessCatalogModel[];
        try {
          models = await loadHarnessModels(ctx, config.provider);
        } catch (error: unknown) {
          throw internalError(`failed to list models: ${errorChain(error)}`);
        }
        const sessionId = randomUUID();
        const selection: ModelSelectionRef = {
          current: {
            provider: config.provider,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
          },
        };
        const agentPresetOptions = (await ctx.agentPresets.list()).filter(
          (preset) => preset.broken === undefined
        );
        const requestedPreset = ctx.agentPresets.defaultId;
        if (!agentPresetOptions.some((preset) => preset.id === requestedPreset)) {
          throw internalError(
            `default agent preset ${JSON.stringify(requestedPreset)} is unavailable`
          );
        }
        const mcpServerNames = reserveMcpServerNames(
          params.mcpServers,
          sessionId,
          activeMcpServerNames
        );
        let mountedPreset = requestedPreset;
        let handle: HarnessAgentHandle;
        try {
          handle = await ctx.agents.create({
            sessionId,
            meta: { cwd: params.cwd, agentPreset: requestedPreset },
            agentOptions: { provider: config.provider, model: config.model },
            setup: async (agentContext) => {
              installModelSelection(agentContext, selection);
              mountedPreset = (await ctx.agentPresets.mount(agentContext, requestedPreset)).id;
              await mountMcpServers(
                agentContext,
                params.mcpServers,
                mcpServerNames.names,
                params.cwd
              );
            },
          });
        } catch (error: unknown) {
          mcpServerNames.release();
          if (error instanceof RequestError) throw error;
          throw internalError(`failed to create session: ${errorChain(error)}`);
        }
        const dispose = async (): Promise<void> => {
          try {
            await handle.dispose();
          } finally {
            mcpServerNames.release();
          }
        };
        if (closed) {
          await dispose();
          throw internalError('connection closed during session/new');
        }
        let permissionMode: string;
        try {
          permissionMode = ctx.permissionPresets.current(handle.agent.session.events);
          assertAllowed(permissionMode, PERMISSION_MODE_IDS, 'permission mode');
        } catch (error: unknown) {
          await dispose();
          throw error;
        }
        const record: SessionRecord = {
          agent: handle.agent,
          dispose,
          selection,
          permissionMode,
          agentPreset: mountedPreset,
          agentPresetOptions,
          models,
          started: false,
        };
        sessions.set(sessionId, record);
        return {
          sessionId,
          modes: modeState(record),
          configOptions: configOptions(record),
          models: {
            currentModelId: record.selection.current.model,
            availableModels: record.models.map((model) => ({
              modelId: model.id,
              name: model.name ?? model.id,
              description: model.description ?? null,
            })),
          },
        };
      },

      setSessionMode(params: SetSessionModeRequest): void {
        const record = requireSession(params.sessionId);
        setPermissionMode(record, params.modeId);
      },

      setSessionConfigOption(
        params: SetSessionConfigOptionRequest
      ): SetSessionConfigOptionResponse | Promise<SetSessionConfigOptionResponse> {
        return setConfigOption(requireSession(params.sessionId), params);
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen();
        const record = requireSession(params.sessionId);
        if (record.inflight) throw invalidParams('a prompt is already in flight for this session');
        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge');
        }
        const attachments = ctx.get('attachments') as HarnessAttachmentStore | undefined;
        const messageId = randomUUID();
        let resolvePrompt!: (reason: StopReason) => void;
        let rejectPrompt!: (error: Error) => void;
        const completion = new Promise<StopReason>((resolve, reject) => {
          resolvePrompt = resolve;
          rejectPrompt = reject;
        });
        const inflight: InflightPrompt = {
          resolve: resolvePrompt,
          reject: rejectPrompt,
          messageId,
        };
        record.inflight = inflight;
        try {
          const content = await admitAcpPrompt(
            params.prompt,
            record.models,
            record.selection.current.model,
            attachments
          );
          if (record.inflight !== inflight) return { stopReason: await completion };
          const message = createUserMessage(messageId, content);
          record.started = true;
          try {
            record.agent.followup(message);
          } catch (error: unknown) {
            record.inflight = undefined;
            record.started = false;
            throw internalError(
              `prompt was not queued: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          void record.agent.whenIdle().then(() => {
            if (record.inflight !== inflight) return;
            record.inflight = undefined;
            const end = inflight.endReason;
            inflight.resolve(
              end
                ? end.kind === 'max-tokens'
                  ? 'end_turn'
                  : turnEndToStopReason(end)
                : 'cancelled'
            );
          });
        } catch (error: unknown) {
          if (record.inflight === inflight) record.inflight = undefined;
          throw error;
        }
        return { stopReason: await completion };
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(params.sessionId);
        if (!record) return Promise.resolve();
        record.agent.cancel({ kind: 'user' });
        settlePrompt(record, 'cancelled');
        return Promise.resolve();
      },

      async closeSession(params: CloseSessionRequest): Promise<void> {
        const record = requireSession(params.sessionId);
        sessions.delete(params.sessionId);
        record.agent.cancel({ kind: 'user' });
        settlePrompt(record, 'cancelled');
        await disposeRecords([record]);
      },
    };
  };

  const stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
    );
  conn = new AgentSideConnection(makeAgent, stream);

  let quiescing: Promise<void> | undefined;
  const quiesce = (): Promise<void> => {
    if (quiescing) return quiescing;
    closed = true;
    const records = [...sessions.values()];
    sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
      settlePrompt(record, 'cancelled');
    }
    quiescing = (async () => {
      await disposeRecords(records);
    })();
    return quiescing;
  };

  void conn.closed
    .catch((error: unknown) => {
      ctx.logger.warn(`acp-extension-dsh: connection closed with an error: ${String(error)}`);
    })
    .then(quiesce)
    .catch((error: unknown) => {
      ctx.logger.warn(`acp-extension-dsh: connection-close teardown failed: ${String(error)}`);
    });
  ctx.effect(() => quiesce, 'acp-extension-dsh.connection');
}

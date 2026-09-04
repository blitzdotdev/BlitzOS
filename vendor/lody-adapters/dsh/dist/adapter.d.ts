import { type Stream } from '@agentclientprotocol/sdk';
export declare const name = "acp-extension-dsh";
export declare const inject: string[];
type ReasoningEffort = 'off' | 'high' | 'max';
type HarnessTextBlock = {
    type: 'text';
    text: string;
};
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
type HarnessMessageBlock = HarnessTextBlock | HarnessImageBlock | {
    type: string;
};
type HarnessStreamChunk = {
    type: string;
    text?: string;
    block?: {
        type: string;
    };
};
type HarnessTurnEndReason = {
    kind: 'completed' | 'max-tokens' | 'aborted' | 'interrupted' | 'blocked';
} | {
    kind: 'error';
    error: {
        message: string;
    };
};
type HarnessSessionEvent = {
    type: string;
    data: {
        turn?: number | null;
        reason?: HarnessTurnEndReason;
        chunk?: HarnessStreamChunk;
        message?: {
            content: HarnessMessageBlock[];
        };
        agentPreset?: string;
        compactionId?: string;
        error?: string;
    };
};
type HarnessSession = {
    id: string;
    header: {
        id: string;
    };
    events: readonly HarnessSessionEvent[];
    append(type: 'agent-preset/selected', data: {
        agentPreset: string;
    }): void;
};
type HarnessAgent = {
    id: string;
    ctx: HarnessAgentContext;
    session: HarnessSession;
    followup(message: HarnessUserMessage): void;
    cancel(cause: {
        kind: 'user';
    }): void;
    whenIdle(): Promise<void>;
};
type HarnessUserMessage = {
    id: string;
    role: 'user';
    content: Array<HarnessTextBlock | HarnessImageBlock>;
    source: {
        kind: 'user';
    };
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
type HarnessMcpClientConfig = {
    transport: 'stdio';
    serverName: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    toolCallTimeoutMs: number;
    failOnStartupError: boolean;
} | {
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
            meta: {
                cwd: string;
                agentPreset: string;
            };
            agentOptions: {
                provider: string;
                model: string;
            };
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
/** Mount the ACP bridge into the surrounding Harness composition. */
export declare function apply(ctx: HarnessContext, rawConfig?: DeepSeekAcpAdapterConfig): void;
export {};
//# sourceMappingURL=adapter.d.ts.map
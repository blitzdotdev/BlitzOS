export interface Tool {
    /** HTTP method. Defaults to "POST" if omitted. */
    method?: string;
    /**
     * URL path including the leading slash. Identifier and routing target.
     * In v0 must be static (no `:id` params).
     */
    path: string;
    description: string;
    /** Optional JSON Schema describing the request body. */
    input_schema?: unknown;
    /**
     * Handler invoked when an agent calls this tool. Body is the agent's
     * raw HTTP body as a string — typically JSON; the handler should parse.
     */
    handler: ToolHandler;
}
export interface ToolCallContext {
    method: string;
    path: string;
    body: string;
    headers: Record<string, string>;
}
export type ToolResult = {
    status?: number;
    body?: unknown;
    taskId?: string;
} | unknown;
export type ToolHandler = (ctx: ToolCallContext) => Promise<ToolResult> | ToolResult;
export interface ConnectOptions {
    /** Public app-id matching an entry in the relay's apps.json. */
    appId: string;
    /** Markdown briefing served at GET /v1/t/<token>/agents.md. */
    agentsMd: string;
    /** Optional 1–3 sentence app description, surfaced in tools.json. */
    appDescription?: string;
    tools: Tool[];
    /**
     * Base URL of the relay. Default: "https://agentsocket.dev".
     * Override for self-hosted or local dev.
     * Note: "https://aisocket.dev" is also served by the same Worker.
     */
    baseUrl?: string;
    /**
     * When true (default), the SDK auto-reconnects after WS drops AND
     * re-mints any previously-minted agent-tokens under the new session.
     * The mapping {oldUrl → newUrl} is reported via onSessionChanged.
     */
    autoReconnect?: boolean;
    /**
     * Called when the WS drops. App decides when (or whether) to reconnect.
     * Default: agentSocket.exponentialBackoff() — call reconnect() after a
     * jittered exponential delay.
     */
    onDisconnect?: DisconnectHandler;
    /**
     * Called after a successful reconnect when sessionId changed.
     * tokensRemapped is non-empty only when autoReconnect:true.
     */
    onSessionChanged?: SessionChangedHandler;
    /**
     * Optional: heartbeat send interval (ms). Default 25000.
     */
    heartbeatIntervalMs?: number;
    /**
     * Optional: max time to wait for a pong before closing as dead (ms).
     * Default 50000.
     */
    heartbeatTimeoutMs?: number;
}
export interface DisconnectInfo {
    reason: string;
    /** Attempt number (1 for first reconnect attempt after a drop). */
    attempt: number;
    /** Call this to attempt the next reconnect. */
    reconnect: () => void;
    /** Call this to give up; SDK won't try to reconnect. */
    giveUp: () => void;
}
export type DisconnectHandler = (info: DisconnectInfo) => void | Promise<void>;
export interface SessionChangedInfo {
    priorSessionId: string;
    sessionId: string;
    /**
     * Map of old paste-link URL → new paste-link URL. With autoReconnect:true,
     * the SDK has already re-minted; the app should update any UI showing old URLs.
     * With autoReconnect:false this is empty (SDK didn't re-mint).
     */
    tokensRemapped: Map<string, string>;
}
export type SessionChangedHandler = (info: SessionChangedInfo) => void | Promise<void>;
export interface AgentToken {
    /** Full agent-token string. Used as the URL secret AND the revoke handle. */
    token: string;
    /** Pre-formatted paste URL (host-rewritten). */
    url: string;
    label: string;
    expiresAt: number | null;
}
export interface ListedToken extends AgentToken {
    mintedAt: number;
}
/**
 * Public Session interface returned from connect(). Methods are async.
 */
export interface Session {
    /** Current session-id (changes after reconnect with new session). */
    readonly sessionId: string;
    /** Whether the WebSocket is currently open. */
    readonly connected: boolean;
    /** Mint a new agent-token. */
    mintAgentToken(opts: {
        label: string;
    }): Promise<AgentToken>;
    /** Revoke an agent-token by its full token string. */
    revokeAgentToken(token: string): Promise<{
        ok: boolean;
    }>;
    /** List currently-active agent-tokens. */
    listAgentTokens(): Promise<ListedToken[]>;
    /**
     * Complete an async task. The handler must have previously returned
     * `{ status: 202, taskId }`. The agent's poll on `<URL>/_as_tasks/<taskId>`
     * will then return the supplied status + body.
     *
     * Fire-and-forget — no reply frame. Throws if the WS is not currently
     * open, or if taskId is missing. Async tasks do NOT survive a WS
     * reconnect (the relay's task map lives in DO memory); completing a
     * task minted in a prior session is a no-op on the relay.
     */
    completeTask(taskId: string, result?: {
        status?: number;
        body?: unknown;
    }): void;
    /**
     * Send a heartbeat ping immediately. No-op if the WS isn't open or
     * there's already a ping in flight. Intended for environments where
     * the runtime can suspend setTimeout-based heartbeats (e.g. Chrome MV3
     * service workers, which use chrome.alarms to wake periodically and
     * call ping() to exercise the WS path).
     */
    ping(): void;
    /** Close the WS and give up. */
    close(): void;
}

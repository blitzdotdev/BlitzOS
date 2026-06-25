export interface DefaultAgentsMdOptions {
    appName: string;
    appDescription: string;
    /** Full URL of this document (the agents.md endpoint) — see SDK rewrite. */
    agentsMdUrl: string;
    /** Optional bullet items: things the AI is allowed to do. */
    capabilities?: string[];
    /** Optional bullet items: things the AI cannot do. */
    limitations?: string[];
    /** Optional free-form prose about app-specific conventions. */
    conventions?: string;
}
export declare function defaultAgentsMd(opts: DefaultAgentsMdOptions): string;

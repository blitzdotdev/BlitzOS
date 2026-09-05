import type {LodyActivityMeta} from "acp-extension-core";

export type ContextCompactionTrigger = "manual" | "automatic";

export interface ContextCompactionMetadata {
    trigger?: ContextCompactionTrigger;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    error?: string;
}

/**
 * Provider-neutral metadata for a synthetic ACP context-compaction tool call.
 * The standard toolCallId and status fields own lifecycle identity and phase;
 * this extension carries only compaction-specific facts.
 */
export function createContextCompactionMeta(
    metadata: ContextCompactionMetadata = {},
): {lody: {activity: LodyActivityMeta}} {
    return {
        lody: {
            activity: {
                version: 1,
                kind: "context_compaction",
                ...(metadata.trigger === undefined
                    ? {}
                    : {automatic: metadata.trigger === "automatic"}),
                ...(metadata.preTokens === undefined
                    ? {}
                    : {usedTokensBefore: metadata.preTokens}),
                ...(metadata.postTokens === undefined
                    ? {}
                    : {usedTokensAfter: metadata.postTokens}),
                ...(metadata.durationMs === undefined ? {} : {durationMs: metadata.durationMs}),
                ...(metadata.error === undefined ? {} : {failureReason: metadata.error}),
            },
        },
    };
}

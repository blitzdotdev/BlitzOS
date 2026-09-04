import type {RateLimit, RateLimitsGetResponse} from "acp-extension-core";
import type {GetAccountRateLimitsResponse, RateLimitSnapshot} from "./app-server/v2";

export function toLodyRateLimit(snapshot: RateLimitSnapshot): RateLimit {
    const limitId = snapshot.limitId ?? snapshot.limitName ?? "codex";
    return {
        limitId,
        scope: {providerId: "codex"},
        limitName: snapshot.limitName,
        planName: snapshot.planType,
        windows: [snapshot.primary, snapshot.secondary]
            .filter((window): window is NonNullable<typeof window> => window !== null)
            .map(window => ({
                usedPercent: window.usedPercent,
                windowDurationSeconds:
                    window.windowDurationMins === null ? null : window.windowDurationMins * 60,
                resetsAtEpochSeconds: window.resetsAt,
            })),
    };
}

export function toLodyRateLimitsResponse(
    response: GetAccountRateLimitsResponse,
): RateLimitsGetResponse {
    const buckets = Object.values(response.rateLimitsByLimitId ?? {})
        .filter((snapshot): snapshot is RateLimitSnapshot => snapshot !== undefined);
    const snapshots = buckets.length > 0 ? buckets : [response.rateLimits];
    return {
        rateLimits: snapshots.map(toLodyRateLimit),
        fetchedAtEpochSeconds: Math.floor(Date.now() / 1000),
    };
}

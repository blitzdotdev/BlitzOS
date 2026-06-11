import type { DisconnectHandler } from "./types.js";
/**
 * Exponential backoff with ±25% jitter.
 * Default: 1s → 2s → 4s → 8s → ... capped at maxMs (default 30s).
 *
 * Returns a DisconnectHandler that schedules the next reconnect via setTimeout,
 * then calls reconnect(). Apps that want bespoke timing can supply their own.
 */
export declare function exponentialBackoff(opts?: {
    baseMs?: number;
    maxMs?: number;
    jitter?: number;
}): DisconnectHandler;
/**
 * Linear backoff: a fixed delay between every attempt.
 */
export declare function linearBackoff(opts?: {
    delayMs?: number;
}): DisconnectHandler;
/**
 * Reconnect immediately. Useful for tests or apps that want their own
 * outer backoff. NOT recommended in production.
 */
export declare function noBackoff(): DisconnectHandler;

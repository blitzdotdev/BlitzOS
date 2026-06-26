// Default backoff helpers for ConnectOptions.onDisconnect.
/**
 * Exponential backoff with ±25% jitter.
 * Default: 1s → 2s → 4s → 8s → ... capped at maxMs (default 30s).
 *
 * Returns a DisconnectHandler that schedules the next reconnect via setTimeout,
 * then calls reconnect(). Apps that want bespoke timing can supply their own.
 */
export function exponentialBackoff(opts = {}) {
    const baseMs = opts.baseMs ?? 1000;
    const maxMs = opts.maxMs ?? 30000;
    const jitter = opts.jitter ?? 0.25;
    return ({ attempt, reconnect }) => {
        const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
        const j = exp * jitter;
        const delay = Math.max(0, exp + (Math.random() * 2 - 1) * j);
        setTimeout(reconnect, delay);
    };
}
/**
 * Linear backoff: a fixed delay between every attempt.
 */
export function linearBackoff(opts = {}) {
    const delay = opts.delayMs ?? 5000;
    return ({ reconnect }) => {
        setTimeout(reconnect, delay);
    };
}
/**
 * Reconnect immediately. Useful for tests or apps that want their own
 * outer backoff. NOT recommended in production.
 */
export function noBackoff() {
    return ({ reconnect }) => reconnect();
}

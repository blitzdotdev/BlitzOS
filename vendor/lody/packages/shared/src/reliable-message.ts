/**
 * Total timeout for permission requests in milliseconds.
 * After this time, the request is considered failed and cancelled.
 *
 * The 20-minute timeout accounts for:
 * - Users reviewing complex permission requests
 * - Multi-device scenarios where approval happens on a different device
 * - Network latency for LoroDoc synchronization
 */
export const PERMISSION_REQUEST_TIMEOUT_MS = 1_200_000; // 20 minutes

/**
 * Is the box behind this workspace's gateway answering at all?
 *
 * THE FIELD REPORT THIS MODULE ANSWERS (BUG-CV-01, BUG-CV-02). A canary box
 * booted with a cloudflared connector that carried zero ready connections. The
 * machine was `running`, so the control plane said `running` and the footer
 * printed `workspace running` for more than seven minutes, while every
 * `/workspaces/<id>/webapp/7445/*` call answered 530. Nothing in the shell
 * asked the second question — the machine is up, but can the browser REACH it?
 * — so nothing could say the true sentence.
 *
 * The same dead gateway blanked the whole document. Every box poll in the shell
 * ran without a deadline, so a request that never answers held its socket for
 * as long as the tab lived; the browser ran out of them, and the lazy
 * `SessionSurface` import lost the race with `ERR_INSUFFICIENT_RESOURCES`.
 *
 * SO THIS MODULE IS ONE FACT AND TWO HABITS:
 *
 * - `boxGatewayFetch` — the deadline. Every read of the box gateway goes
 *   through it, so no box request can outlive `BOX_GATEWAY_TIMEOUT_MS` and no
 *   dead gateway can hold sockets open.
 * - `reportBoxGatewayProbe` — the fact. Each of those reads reports what it
 *   saw, and `BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE` consecutive failures
 *   settle the shell on `unreachable`. One success clears it.
 * - `boxGatewayPollIntervalMs` — the circuit breaker. Pollers slow down while
 *   the answer is `unreachable`, so a box that will not come back for an hour
 *   costs one request per 30 s rather than one per 5 s.
 *
 * NO NEW REQUEST IS MADE FOR ANY OF IT. The evidence is the polls the shell
 * already sends; this module only refuses to throw their answers away.
 */
import { useSyncExternalStore } from 'react';

/** What the shell believes about reaching this workspace's box. */
export type BoxGatewayHealth = 'unknown' | 'reachable' | 'unreachable';

/** One read's verdict. `reached` means bytes came back FROM THE BOX. */
export type BoxGatewayProbe = 'reached' | 'unreachable';

/**
 * The deadline every box read carries.
 *
 * Ten seconds because the slowest healthy answer measured on this path is the
 * cold-daemon 503 from the bridge, which is immediate, and a tunnel that is
 * merely slow still beats a page that is blank. The number's job is not to be
 * exactly right; it is to exist, which is what the polls lacked.
 */
export const BOX_GATEWAY_TIMEOUT_MS = 10_000;

/**
 * How many failures in a row settle the shell on `unreachable`.
 *
 * Three, so one blip during a machine's own boot does not put a scary sentence
 * in the footer, and so the verdict still arrives inside the first fifteen
 * seconds of a genuinely dead tunnel.
 */
export const BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE = 3;

/** What a poller falls back to once the gateway is known dead. */
export const BOX_GATEWAY_COLD_POLL_INTERVAL_MS = 30_000;

/**
 * Statuses that mean the request reached OUR edge and not the box.
 *
 * 530 is Cloudflare's own: the tunnel has no connector to hand the request to,
 * which is exactly the reported failure. 502 and 504 are the proxy saying the
 * same thing in older words.
 *
 * 503 IS DELIBERATELY ABSENT. The Lody bridge answers 503 itself while its
 * daemon has not written its catalog yet (`lody/box-capability.ts`), so a 503
 * is proof the box IS reachable — folding it in here would report a booting
 * daemon as a dead tunnel.
 */
const TUNNEL_FAILURE_STATUSES: readonly number[] = [502, 504, 530];

export function readBoxGatewayStatus(status: number): BoxGatewayProbe {
  return TUNNEL_FAILURE_STATUSES.includes(status) ? 'unreachable' : 'reached';
}

/**
 * The caller's own abort signal, if any, plus the deadline.
 *
 * Composed rather than replaced: a poller that aborts on unmount must still
 * abort on unmount, and the deadline must fire even when the caller passed no
 * signal at all.
 */
export function boxGatewaySignal(caller?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(BOX_GATEWAY_TIMEOUT_MS);
  return caller === undefined ? deadline : AbortSignal.any([caller, deadline]);
}

let consecutiveFailures = 0;
let health: BoxGatewayHealth = 'unknown';
const listeners = new Set<() => void>();

function publish(next: BoxGatewayHealth): void {
  if (next === health) return;
  health = next;
  for (const listener of listeners) listener();
}

export function reportBoxGatewayProbe(outcome: BoxGatewayProbe): void {
  if (outcome === 'reached') {
    consecutiveFailures = 0;
    publish('reachable');
    return;
  }
  consecutiveFailures += 1;
  if (consecutiveFailures >= BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE) publish('unreachable');
}

/**
 * Forgets everything known about the previous box.
 *
 * Called when the address the shell probes changes — a different workspace, or
 * the same one on a machine that just restarted. Without it a member who
 * switches away from a dead box reads its verdict on a healthy one.
 */
export function resetBoxGatewayHealth(): void {
  consecutiveFailures = 0;
  publish('unknown');
}

export function boxGatewayHealth(): BoxGatewayHealth {
  return health;
}

export function subscribeBoxGatewayHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBoxGatewayHealth(): BoxGatewayHealth {
  return useSyncExternalStore(subscribeBoxGatewayHealth, boxGatewayHealth, boxGatewayHealth);
}

/** A poller's interval, stretched while the box is known unreachable. */
export function boxGatewayPollIntervalMs(current: BoxGatewayHealth, normal: number): number {
  if (current !== 'unreachable') return normal;
  return Math.max(normal, BOX_GATEWAY_COLD_POLL_INTERVAL_MS);
}

/**
 * One read of the box gateway: deadline attached, verdict reported, response
 * handed back untouched.
 *
 * Throws exactly what `fetch` throws, so every caller keeps the error handling
 * it already had. A failure the CALLER caused — its own signal aborted on
 * unmount or on a workspace switch — reports nothing: that is not evidence
 * about the box, and counting it would make every navigation look like an
 * outage.
 */
export async function boxGatewayFetch(
  url: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const response = await fetcher(url, {
      credentials: 'include',
      signal: boxGatewaySignal(signal),
    });
    reportBoxGatewayProbe(readBoxGatewayStatus(response.status));
    return response;
  } catch (cause) {
    if (signal?.aborted !== true) reportBoxGatewayProbe('unreachable');
    throw cause;
  }
}

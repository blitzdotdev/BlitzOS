import { Effect } from 'effect';
import {
  makeLocalProbeClientAuto,
  type LocalProbeHealthResponse,
} from '@lody/shared/node/local-ipc';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

export type { LocalProbeHealthResponse };

const DEFAULT_LOCAL_PROBE_HEALTH_TIMEOUT_MS = 1_500;

export type FetchLocalProbeHealthOptions = {
  logger?: Pick<Logger, 'debug'>;
  timeoutMs?: number;
};

/**
 * Read the running daemon's health over the local IPC socket. P8 removed the
 * probe TCP port, so this discovers the daemon via its run-file socket rather
 * than a well-known port; callers keep the same `LocalProbeHealthResponse | null`
 * contract.
 */
export async function fetchLocalProbeHealth(
  options: FetchLocalProbeHealthOptions = {}
): Promise<LocalProbeHealthResponse | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_PROBE_HEALTH_TIMEOUT_MS;
  try {
    return await Effect.runPromise(makeLocalProbeClientAuto().health({ timeoutMs }));
  } catch (error) {
    options.logger?.debug(`Local probe health check failed: ${formatErrorMessage(error)}`);
    return null;
  }
}

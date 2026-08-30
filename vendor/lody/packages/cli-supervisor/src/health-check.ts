import { Effect } from 'effect';
import type { CliRuntimeState } from '@lody/shared/electron-ipc';
import { makeLocalProbeClientAuto } from '@lody/shared/node/local-ipc';

export type FetchCliRuntimeStateOptions = {
  timeoutMs?: number;
};

// Constructed once: the client caches the per-run-file discovery, so a fresh
// client per poll would re-read and re-validate the run file every time.
const probeClient = makeLocalProbeClientAuto();

export async function fetchCliRuntimeState(
  options?: FetchCliRuntimeStateOptions
): Promise<CliRuntimeState | null> {
  const timeoutMs = options?.timeoutMs ?? 800;

  try {
    return await Effect.runPromise(probeClient.state({ timeoutMs }));
  } catch {
    return null;
  }
}

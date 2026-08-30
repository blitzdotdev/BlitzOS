import {
  getReviewPolicyFlockDocId,
  getReviewRunScanPrefix,
  getReviewerConfigScanPrefix,
  parseMachineReviewerConfig,
  parseReviewRun,
  parseReviewerConfigKey,
  resolveReviewPolicy,
  REVIEW_POLICY_ROW_KEY,
  reviewerConfigKeys,
  reviewRunKeys,
  type MachineId,
  type MachineReviewerConfig,
  type ReviewPolicy,
  type ReviewRun,
  type SessionId,
} from '@lody/shared';
import type { WorkspaceRuntime } from './runtime';

/**
 * Review policy, per-machine reviewer configs, and runs live in one
 * workspace-scoped Flock document.
 *
 * The policy has to be here rather than in localStorage because the machine
 * reads it headlessly: a client that closes must not stop the branch it was told
 * would be reviewed and merged.
 */

export async function readReviewPolicyFromFlock(
  runtime: WorkspaceRuntime
): Promise<ReviewPolicy> {
  const handle = await runtime.repo.openFlockDoc(
    getReviewPolicyFlockDocId(runtime.workspaceId)
  );
  for (const row of handle.flock.scan({ prefix: REVIEW_POLICY_ROW_KEY })) {
    if (row.value !== undefined) {
      return resolveReviewPolicy(row.value);
    }
  }
  return resolveReviewPolicy(undefined);
}

export async function writeReviewPolicyToFlock(
  runtime: WorkspaceRuntime,
  policy: ReviewPolicy
): Promise<void> {
  await runtime.writer.flockRowPut(
    getReviewPolicyFlockDocId(runtime.workspaceId),
    REVIEW_POLICY_ROW_KEY,
    policy
  );
}

export async function readMachineReviewerConfigFromFlock(
  runtime: WorkspaceRuntime,
  machineId: MachineId
): Promise<MachineReviewerConfig | undefined> {
  const handle = await runtime.repo.openFlockDoc(getReviewPolicyFlockDocId(runtime.workspaceId));
  for (const row of handle.flock.scan({ prefix: reviewerConfigKeys.machine(machineId) })) {
    const parsed = parseMachineReviewerConfig(row.value);
    if (parsed?.machineId === machineId) {
      return parsed;
    }
  }
  return undefined;
}

export async function listMachineReviewerConfigsFromFlock(
  runtime: WorkspaceRuntime
): Promise<Map<MachineId, MachineReviewerConfig>> {
  const handle = await runtime.repo.openFlockDoc(getReviewPolicyFlockDocId(runtime.workspaceId));
  const configs = new Map<MachineId, MachineReviewerConfig>();
  for (const row of handle.flock.scan({ prefix: getReviewerConfigScanPrefix() })) {
    const machineId = parseReviewerConfigKey(row.key);
    const parsed = parseMachineReviewerConfig(row.value);
    if (machineId && parsed?.machineId === machineId) {
      configs.set(machineId, parsed);
    }
  }
  return configs;
}

export async function writeMachineReviewerConfigToFlock(
  runtime: WorkspaceRuntime,
  config: MachineReviewerConfig
): Promise<void> {
  await runtime.writer.flockRowPut(
    getReviewPolicyFlockDocId(runtime.workspaceId),
    reviewerConfigKeys.machine(config.machineId),
    config
  );
}

export async function deleteMachineReviewerConfigFromFlock(
  runtime: WorkspaceRuntime,
  machineId: MachineId
): Promise<void> {
  await runtime.writer.flockRowDelete(
    getReviewPolicyFlockDocId(runtime.workspaceId),
    reviewerConfigKeys.machine(machineId)
  );
}

export async function readReviewRunFromFlock(
  runtime: WorkspaceRuntime,
  sessionId: SessionId
): Promise<ReviewRun | undefined> {
  const handle = await runtime.repo.openFlockDoc(
    getReviewPolicyFlockDocId(runtime.workspaceId)
  );
  for (const row of handle.flock.scan({ prefix: reviewRunKeys.run(sessionId) })) {
    const parsed = parseReviewRun(row.value);
    if (parsed?.sessionId === sessionId) {
      return parsed;
    }
  }
  return undefined;
}

export async function writeReviewRunToFlock(
  runtime: WorkspaceRuntime,
  run: ReviewRun
): Promise<void> {
  await runtime.writer.flockRowPut(
    getReviewPolicyFlockDocId(runtime.workspaceId),
    reviewRunKeys.run(run.sessionId),
    run
  );
}

export async function deleteReviewRunFromFlock(
  runtime: WorkspaceRuntime,
  sessionId: SessionId
): Promise<void> {
  await runtime.writer.flockRowDelete(
    getReviewPolicyFlockDocId(runtime.workspaceId),
    reviewRunKeys.run(sessionId)
  );
}

export async function listReviewRunsFromFlock(
  runtime: WorkspaceRuntime
): Promise<ReviewRun[]> {
  const handle = await runtime.repo.openFlockDoc(
    getReviewPolicyFlockDocId(runtime.workspaceId)
  );
  const runs: ReviewRun[] = [];
  for (const row of handle.flock.scan({ prefix: getReviewRunScanPrefix() })) {
    const parsed = parseReviewRun(row.value);
    if (parsed) {
      runs.push(parsed);
    }
  }
  return runs;
}

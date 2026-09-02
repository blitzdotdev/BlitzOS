import type {
  LocalProjectControlResponse,
  LocalProjectHistoryCatalogResult,
  LocalProjectHistoryConflictResolveResult,
  LocalProjectHistoryImportResult,
  LocalProjectHistoryProvider,
  LocalProjectId,
  MachineId,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { getIpcServices, windowIpcClient, type LodyIpcClient } from '@/lib/electron-ipc-client';

const HISTORY_CONTROL_TIMEOUT_MS = 120_000;

// Batch size for importing local-project history sessions.
//
// Each import RPC runs CLI-side in a sequential loop (spawn ACP process, replay,
// hash, write Loro doc per session) under a single 120s wall-clock timeout. A
// large selection trivially exceeds that budget and the RPC resolves to null
// ("Machine did not respond before the request timed out"). Splitting the
// selection into small batches gives each RPC its own 120s budget, lets partial
// progress land, and makes a single slow/failed session blast-radius one batch
// instead of the whole import. 5 keeps the per-batch wall clock comfortably
// under the timeout even with cold ACP startups.
const HISTORY_IMPORT_BATCH_SIZE = 5;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function mergeImportResults(
  base: LocalProjectHistoryImportResult | null,
  next: LocalProjectHistoryImportResult
): LocalProjectHistoryImportResult {
  if (!base) {
    return next;
  }
  return {
    summary: {
      listed: base.summary.listed + next.summary.listed,
      imported: base.summary.imported + next.summary.imported,
      refreshed: base.summary.refreshed + next.summary.refreshed,
      skipped: base.summary.skipped + next.summary.skipped,
      conflicted: base.summary.conflicted + next.summary.conflicted,
      failed: base.summary.failed + next.summary.failed,
      failures: [...base.summary.failures, ...next.summary.failures],
    },
    // Each batch returns the full catalog snapshot rebuilt from the machine doc
    // (including sessions imported by earlier batches), so the latest batch's
    // catalog is the most complete — last one wins.
    catalog: next.catalog,
  };
}

function hasElectronHistoryApi(ipcClient: LodyIpcClient): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean(getIpcServices(ipcClient));
}

function hasElectronResolveHistoryApi(ipcClient: LodyIpcClient): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean(getIpcServices(ipcClient));
}

export function canUseProjectHistoryProjectControl(args: {
  runtime: WorkspaceRuntime | null;
  localMachineId?: MachineId | null;
  machineId: MachineId;
  supportsLocalProjectHistoryRpc?: boolean;
  ipcClient?: LodyIpcClient;
}): boolean {
  const ipcClient = args.ipcClient ?? windowIpcClient;
  if (
    typeof window !== 'undefined' &&
    args.localMachineId === args.machineId &&
    hasElectronHistoryApi(ipcClient)
  ) {
    return true;
  }

  return Boolean(args.runtime && args.supportsLocalProjectHistoryRpc);
}

function isLocalElectronProject(args: {
  localMachineId?: MachineId | null;
  machineId: MachineId;
}): boolean {
  return args.localMachineId === args.machineId;
}

function assertProjectControlResponse(
  response: LocalProjectControlResponse | null
): asserts response is Extract<LocalProjectControlResponse, { ok: true }> {
  if (!response) {
    throw new Error('Machine did not respond before the request timed out.');
  }
  if (!response.ok) {
    throw new Error(response.message);
  }
}

function unwrapHistorySyncResponse(
  response: LocalProjectControlResponse | null
): LocalProjectHistoryCatalogResult {
  assertProjectControlResponse(response);
  if (response.type !== 'local-project/sync-history') {
    throw new Error(`Unexpected response type: ${response.type}`);
  }
  return response.result;
}

function unwrapHistoryImportResponse(
  response: LocalProjectControlResponse | null
): LocalProjectHistoryImportResult {
  assertProjectControlResponse(response);
  if (response.type !== 'local-project/import-history') {
    throw new Error(`Unexpected response type: ${response.type}`);
  }
  return response.result;
}

function unwrapHistoryConflictResolveResponse(
  response: LocalProjectControlResponse | null
): LocalProjectHistoryConflictResolveResult {
  assertProjectControlResponse(response);
  if (response.type !== 'local-project/resolve-history-conflict') {
    throw new Error(`Unexpected response type: ${response.type}`);
  }
  return response.result;
}

export async function syncProjectHistoryForLocalProject(args: {
  provider: LocalProjectHistoryProvider;
  runtime: WorkspaceRuntime | null;
  localMachineId?: MachineId | null;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  localProjectId: LocalProjectId;
  requestedByUserId: string;
  ipcClient?: LodyIpcClient;
}): Promise<LocalProjectHistoryCatalogResult> {
  const ipcClient = args.ipcClient ?? windowIpcClient;
  if (
    typeof window !== 'undefined' &&
    isLocalElectronProject(args) &&
    hasElectronHistoryApi(ipcClient)
  ) {
    if (!getIpcServices(ipcClient)) {
      throw new Error('Electron history API is not available.');
    }
    const result = await getIpcServices(ipcClient)!.localProjects.syncHistory(
      args.provider,
      args.workspaceId,
      args.localProjectId
    );
    if ('error' in result) {
      throw new Error(result.error);
    }
    return result;
  }

  if (!args.runtime) {
    throw new Error('Workspace runtime is not ready.');
  }

  const response = await args.runtime.requestLocalProjectControl(
    {
      type: 'local-project/sync-history',
      provider: args.provider,
      machineId: args.machineId,
      workspaceId: args.workspaceId,
      localProjectId: args.localProjectId,
      requestedByUserId: args.requestedByUserId,
    },
    { timeoutMs: HISTORY_CONTROL_TIMEOUT_MS }
  );
  return unwrapHistorySyncResponse(response);
}

type ImportProjectHistoryArgs = {
  provider: LocalProjectHistoryProvider;
  runtime: WorkspaceRuntime | null;
  localMachineId?: MachineId | null;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  localProjectId: LocalProjectId;
  acpSessionIds: string[];
  requestedByUserId: string;
  ipcClient?: LodyIpcClient;
  // Invoked after each batch completes with the cumulative result so callers can
  // render incremental progress and land partial success even if a later batch
  // fails or times out.
  onBatchComplete?: (
    cumulative: LocalProjectHistoryImportResult,
    progress: { completed: number; total: number }
  ) => void;
};

async function executeImportBatch(
  args: ImportProjectHistoryArgs,
  acpSessionIds: string[]
): Promise<LocalProjectHistoryImportResult> {
  const ipcClient = args.ipcClient ?? windowIpcClient;
  if (
    typeof window !== 'undefined' &&
    isLocalElectronProject(args) &&
    hasElectronHistoryApi(ipcClient)
  ) {
    if (!getIpcServices(ipcClient)) {
      throw new Error('Electron history API is not available.');
    }
    const result = await getIpcServices(ipcClient)!.localProjects.importHistory(
      args.provider,
      args.workspaceId,
      args.localProjectId,
      acpSessionIds
    );
    if ('error' in result) {
      throw new Error(result.error);
    }
    return result;
  }

  if (!args.runtime) {
    throw new Error('Workspace runtime is not ready.');
  }

  const response = await args.runtime.requestLocalProjectControl(
    {
      type: 'local-project/import-history',
      provider: args.provider,
      machineId: args.machineId,
      workspaceId: args.workspaceId,
      localProjectId: args.localProjectId,
      acpSessionIds,
      requestedByUserId: args.requestedByUserId,
    },
    { timeoutMs: HISTORY_CONTROL_TIMEOUT_MS }
  );
  return unwrapHistoryImportResponse(response);
}

export async function importProjectHistoryForLocalProject(
  args: ImportProjectHistoryArgs
): Promise<LocalProjectHistoryImportResult> {
  const uniqueIds = [...new Set(args.acpSessionIds)];
  // Fall back to a single empty batch when nothing is selected so the call still
  // returns a fresh catalog snapshot (matching prior single-call behavior).
  const batches = uniqueIds.length ? chunk(uniqueIds, HISTORY_IMPORT_BATCH_SIZE) : [[]];

  let cumulative: LocalProjectHistoryImportResult | null = null;
  let completed = 0;
  for (const batch of batches) {
    const batchResult = await executeImportBatch(args, batch);
    cumulative = mergeImportResults(cumulative, batchResult);
    completed += batch.length;
    args.onBatchComplete?.(cumulative, { completed, total: uniqueIds.length });
  }

  // `cumulative` is always set: `batches` is never empty (we inject `[[]]`).
  if (!cumulative) {
    throw new Error('History import produced no result.');
  }
  return cumulative;
}

export async function resolveProjectHistoryConflictForLocalProject(args: {
  provider: LocalProjectHistoryProvider;
  runtime: WorkspaceRuntime | null;
  localMachineId?: MachineId | null;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  localProjectId: LocalProjectId;
  sessionId: SessionId;
  acpSessionId: string;
  requestedByUserId: string;
  ipcClient?: LodyIpcClient;
}): Promise<LocalProjectHistoryConflictResolveResult> {
  const ipcClient = args.ipcClient ?? windowIpcClient;
  if (
    typeof window !== 'undefined' &&
    isLocalElectronProject(args) &&
    hasElectronResolveHistoryApi(ipcClient)
  ) {
    if (!getIpcServices(ipcClient)) {
      throw new Error('Electron history conflict API is not available.');
    }
    const result = await getIpcServices(ipcClient)!.localProjects.resolveHistoryConflict(
      args.provider,
      args.workspaceId,
      args.localProjectId,
      args.sessionId,
      args.acpSessionId
    );
    if ('error' in result) {
      throw new Error(result.error);
    }
    return result;
  }

  if (!args.runtime) {
    throw new Error('Workspace runtime is not ready.');
  }

  const response = await args.runtime.requestLocalProjectControl(
    {
      type: 'local-project/resolve-history-conflict',
      provider: args.provider,
      machineId: args.machineId,
      workspaceId: args.workspaceId,
      localProjectId: args.localProjectId,
      sessionId: args.sessionId,
      acpSessionId: args.acpSessionId,
      requestedByUserId: args.requestedByUserId,
    },
    { timeoutMs: HISTORY_CONTROL_TIMEOUT_MS }
  );
  return unwrapHistoryConflictResolveResponse(response);
}
